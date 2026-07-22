#!/usr/bin/env node
'use strict';
/*
 * overleaf-sync — push a local LaTeX project to Overleaf (overleaf.com or any
 * Server Pro / self-hosted instance) via the web + OT API. No git bridge needed.
 *
 * Dependency-driven: give it a root .tex; it traces \input / \include /
 * \bibliography / local \usepackage and uploads exactly the compile-closure.
 * Self-contained: the Socket.IO/OT engine is vendored in lib/ (from overleaf.nvim, MIT).
 *
 * Config precedence: --flag  >  env var  >  .env in cwd  >  built-in default.
 *
 *   quickstart:  cd my-paper/
 *                printf 'OVERLEAF_PROJECT=<id>\nOVERLEAF_COOKIE=<cookie>\n' > .env
 *                overleaf-sync --dry-run --purge     # preview
 *                overleaf-sync --purge               # push
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const auth = require('./lib/auth');
const SocketManager = require('./lib/socket');

// ---- .env loader (KEY=VALUE; # comments) into process.env ----------------
function loadDotenv(files) {
  for (const f of files) {
    let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !m[1].startsWith('#')) if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadDotenv([path.join(process.cwd(), '.env')]);

// ---- arg parsing ---------------------------------------------------------
const args = process.argv.slice(2);
const flag = (k) => args.includes('--' + k) || args.includes('-' + k.charAt(0));
const argVal = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };

// paper dir resolves first (needed to locate the project config file)
const PAPER = argVal('paper') || process.env.OVERLEAF_PAPER || process.cwd();

// ---- project config file (overleaf-sync.json in --paper, or --config) ----
let FILE_CFG = {};
(function loadProjectConfig() {
  const explicit = argVal('config');
  const cands = explicit ? [explicit]
    : [path.join(PAPER, 'overleaf-sync.json'), path.join(PAPER, '.overleaf-sync.json')];
  for (const c of cands) {
    try { FILE_CFG = JSON.parse(fs.readFileSync(c, 'utf8')); return; }
    catch (e) { if (explicit) console.error(`error: cannot read --config ${c}: ${e.message}`); }
  }
})();

// resolve one key: --flag > OVERLEAF_* env / .env > project config file > default
function cfg(key, envKey, def) {
  const v = argVal(key); if (v !== undefined) return v;
  const e = process.env[envKey]; if (e !== undefined) return e;
  if (FILE_CFG[key] !== undefined) return FILE_CFG[key];
  return def;
}

const HELP = `overleaf-sync — push a local LaTeX project to Overleaf (web/OT API, no git bridge).

Usage:
  overleaf-sync [options]              # config from overleaf-sync.json / env / .env

Options:
  --root <file>        root .tex (default: <paper>/main.tex); its compile-closure is uploaded
  --paper <dir>        local project dir (default: current directory)
  --project <id>       Overleaf project id (required; or set in overleaf-sync.json / OVERLEAF_PROJECT)
  --host <url>         Overleaf base URL (default: https://www.overleaf.com)
  --config <file>      project config file (default: <paper>/overleaf-sync.json)
  --cookie <value>     session cookie (or OVERLEAF_COOKIE; else read from Firefox)
  --cookie-name <name> cookie name (default: auto — overleaf_session2 for overleaf.com,
                       overleaf.sid for self-hosted)
  --browser <name>     cookie source: firefox (default) | chrome
  --dry-run            preview changes, modify nothing
  --purge              delete Overleaf entities not in the compile-closure
  --yes                skip the --purge confirmation prompt
  -h, --help           show this help

Config precedence: --flag > OVERLEAF_* env / .env > overleaf-sync.json > default.

Project config (overleaf-sync.json):
  { "host": "https://overleaf.example.edu", "project": "<id>", "root": "main.tex" }

Examples:
  overleaf-sync --dry-run --purge        # everything from overleaf-sync.json
  overleaf-sync --project 6a58... --purge
  overleaf-sync --root thesis.tex --paper ./thesis`;

if (flag('help') || args.includes('-h')) { console.log(HELP); process.exit(0); }

const CFG = {
  paper: PAPER,
  project: cfg('project', 'OVERLEAF_PROJECT', null),
  host: (cfg('host', 'OVERLEAF_HOST', 'https://www.overleaf.com') || '').replace(/\/$/, ''),
  cookie: cfg('cookie', 'OVERLEAF_COOKIE', null),
  cookieName: cfg('cookie-name', 'OVERLEAF_COOKIE_NAME', null),
  browser: (cfg('browser', 'OVERLEAF_BROWSER', 'firefox') || 'firefox').toLowerCase(),
  dryRun: flag('dry-run'),
  purge: flag('purge') || FILE_CFG.purge === true,
  yes: flag('yes') || FILE_CFG.yes === true,
};
// root: explicit, else auto-detect main.tex in --paper.
{ const r = cfg('root', 'OVERLEAF_ROOT', null);
  CFG.root = r ? (path.isAbsolute(r) ? r : path.join(CFG.paper, r))
              : ['main.tex', 'main_prelim.tex'].map(f => path.join(CFG.paper, f)).find(f => fs.existsSync(f)); }

// validate
const die = (m) => { console.error(`error: ${m}\n(see: overleaf-sync --help)`); process.exit(2); };
if (!CFG.project) die('no project id. Pass --project <id>, set OVERLEAF_PROJECT, or add "project" to overleaf-sync.json.');
if (!CFG.root) die(`no root .tex found in ${CFG.paper}. Pass --root <file> or add "root" to overleaf-sync.json.`);
if (!fs.existsSync(CFG.root)) die(`root file not found: ${CFG.root}`);
// auto cookie name from host
if (!CFG.cookieName) {
  const h = (() => { try { return new URL(CFG.host).hostname; } catch (e) { return ''; } })();
  CFG.cookieName = (h === 'www.overleaf.com' || h === 'overleaf.com') ? 'overleaf_session2' : 'overleaf.sid';
}
process.env.OVERLEAF_URL = CFG.host;

// ---- cookie resolution ---------------------------------------------------
function getCookieFromFirefox() {
  const dirs = fs.readdirSync(path.join(os.homedir(), '.mozilla/firefox'))
    .filter(d => d.endsWith('.default-release'))
    .map(d => path.join(os.homedir(), '.mozilla/firefox', d));
  for (const prof of dirs) {
    const src = path.join(prof, 'cookies.sqlite');
    if (!fs.existsSync(src)) continue;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cookie-'));
    try {
      fs.copyFileSync(src, path.join(tmp, 'cookies.sqlite'));
      for (const ext of ['-wal', '-shm']) { const w = src + ext; if (fs.existsSync(w)) fs.copyFileSync(w, path.join(tmp, 'cookies.sqlite' + ext)); }
      const host = new URL(CFG.host).hostname;
      const row = cp.execSync(`sqlite3 "${path.join(tmp, 'cookies.sqlite')}" "SELECT value FROM moz_cookies WHERE host='${host}' AND name='${CFG.cookieName}' LIMIT 1;"`).toString().trim();
      if (row) return `${CFG.cookieName}=${row}`;
    } catch (e) { /* next profile */ }
    finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }
  return null;
}
function resolveCookie() {
  if (CFG.cookie) return CFG.cookie.includes('=') ? CFG.cookie : `${CFG.cookieName}=${CFG.cookie}`;
  if (CFG.browser === 'firefox') {
    const c = getCookieFromFirefox();
    if (c) return c;
    die(`no ${CFG.cookieName} cookie for ${CFG.host} in Firefox. Log in there, or pass --cookie / OVERLEAF_COOKIE.`);
  }
  die(`--browser ${CFG.browser} not supported yet. Use --cookie or --browser firefox.`);
}

// ---- desired tree: compile-closure of the root .tex ----------------------
function resolveTexRef(ref, fromDir) {
  const cleaned = ref.replace(/^\.\//, '');
  const cands = [path.join(CFG.paper, cleaned), path.join(CFG.paper, cleaned + '.tex'),
                 path.join(fromDir, cleaned), path.join(fromDir, cleaned + '.tex')];
  for (const c of cands) { try { if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.resolve(c); } catch (e) {} }
  return null;
}
function collectDeps(rootAbs) {
  const want = new Map(); const seen = new Set();
  const queue = [{ abs: path.resolve(rootAbs), isRoot: true }];
  while (queue.length) {
    const { abs, isRoot } = queue.shift();
    if (seen.has(abs)) continue; seen.add(abs);
    const rel = path.relative(CFG.paper, abs);
    want.set(isRoot ? '/main.tex' : '/' + rel.split(path.sep).join('/'), abs);
    let content = ''; try { content = fs.readFileSync(abs, 'utf8'); } catch (e) { continue; }
    const code = content.replace(/(^|[^\\])%.*/g, '$1'); // strip line comments
    const fromDir = path.dirname(abs);
    const push = (dep) => { if (dep && !seen.has(dep)) queue.push({ abs: dep, isRoot: false }); };
    for (const m of code.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) push(resolveTexRef(m[1].trim(), fromDir));
    for (const m of code.matchAll(/\\input\s+([^\s{}\\%]+)/g)) push(resolveTexRef(m[1].trim(), fromDir));
    for (const m of code.matchAll(/\\bibliography\s*\{([^}]+)\}/g))
      for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const dep = path.join(CFG.paper, n + '.bib'); if (fs.existsSync(dep)) push(path.resolve(dep));
      }
    for (const m of code.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g))
      for (const n of m[1].split(',').map(s => s.trim()).filter(Boolean)) {
        const dep = path.join(CFG.paper, n + '.sty'); if (fs.existsSync(dep)) push(path.resolve(dep));
      }
  }
  return want;
}

// ---- walk Overleaf rootFolder -> path -> {id,type} -----------------------
function walkTree(rootFolder) {
  const map = new Map();
  const walk = (folder, prefix) => {
    for (const d of folder.docs || []) map.set(prefix + d.name, { id: d._id, type: 'doc' });
    for (const f of folder.fileRefs || []) map.set(prefix + f.name, { id: f._id, type: 'file' });
    for (const sub of folder.folders || []) { const p = prefix + sub.name + '/'; map.set(p, { id: sub._id, type: 'folder', isFolder: true }); walk(sub, p); }
  };
  walk(rootFolder, '/');
  return map;
}

// ---- HTTP helpers --------------------------------------------------------
let COOKIE = null, CSRF = null;
async function getCsrf() {
  const res = await auth.httpGet(`${CFG.host}/project/${CFG.project}`, COOKIE);
  if (res.status === 302 || res.status === 401 || res.status === 403) die('cookie rejected (expired?). Re-login and update --cookie / OVERLEAF_COOKIE.');
  if (res.status !== 200) die(`project page HTTP ${res.status} (wrong --project or --host?)`);
  const m = res.body.match(/ol-csrfToken"\s+content="([^"]*)"/);
  if (!m) die('csrf token not found on project page.');
  return m[1];
}
async function createDoc(name, parentId) {
  const res = await auth.httpPost(`${CFG.host}/project/${CFG.project}/doc`, COOKIE, CSRF, { name, parent_folder_id: parentId || null });
  if (res.status !== 200) throw new Error(`createDoc ${name}: ${res.status} ${res.body}`);
  return JSON.parse(res.body)._id;
}
async function createFolder(name, parentId) {
  const res = await auth.httpPost(`${CFG.host}/project/${CFG.project}/folder`, COOKIE, CSRF, { name, parent_folder_id: parentId || null });
  if (res.status !== 200) throw new Error(`createFolder ${name}: ${res.status} ${res.body}`);
  return JSON.parse(res.body)._id;
}
async function deleteEntity(type, id) {
  const res = await auth.httpDelete(`${CFG.host}/project/${CFG.project}/${type}/${id}`, COOKIE, CSRF);
  if (res.status !== 204 && res.status !== 200) throw new Error(`delete ${type}/${id}: ${res.status}`);
}
async function setDocContent(sm, docId, newContent) {
  const { lines, version } = await sm.joinDoc(docId);
  const oldContent = (lines || []).join('\n');
  if (oldContent === newContent) return 'unchanged';
  const op = [];
  if (oldContent.length) op.push({ p: 0, d: oldContent });
  op.push({ p: 0, i: newContent });
  await sm.applyOtUpdate(docId, op, version, oldContent);
  return 'updated';
}

// ---- main ----------------------------------------------------------------
(async () => {
  COOKIE = resolveCookie();
  CSRF = await getCsrf();
  const desired = collectDeps(CFG.root);
  console.error(`overleaf-sync: ${CFG.host}  project=${CFG.project}`);
  console.error(`  root ${path.relative(CFG.paper, CFG.root)} -> /main.tex  |  compile-closure: ${desired.size} files  |  dry-run=${CFG.dryRun} purge=${CFG.purge}`);

  const sm = new SocketManager(COOKIE, CFG.project, () => {});
  const conn = await sm.connect();
  const rf = conn.project.rootFolder;
  const rootFolder = Array.isArray(rf) ? rf[0] : rf;
  const tree = walkTree(rootFolder);
  console.error(`  connected: ${tree.size} remote entities`);

  const folderCache = new Map([['/', rootFolder._id]]);
  for (const [f, info] of tree) if (f.endsWith('/')) folderCache.set(f, info.id);
  async function ensureFolder(folderPath) {
    if (folderCache.has(folderPath)) return folderCache.get(folderPath);
    const dn = path.posix.dirname(folderPath.slice(0, -1));
    const parentId = await ensureFolder(dn === '/' ? '/' : dn + '/');
    const name = folderPath.slice(0, -1).split('/').pop();
    if (CFG.dryRun) { folderCache.set(folderPath, 'dry'); return 'dry'; }
    const id = await createFolder(name, parentId);
    folderCache.set(folderPath, id);
    return id;
  }

  const plan = [];
  for (const [ovPath, localAbs] of desired) {
    const dn = path.posix.dirname(ovPath);
    const parentPath = dn === '/' ? '/' : dn + '/';
    const name = path.posix.basename(ovPath);
    const parentId = await ensureFolder(parentPath);
    const existing = tree.get(ovPath);
    const content = fs.readFileSync(localAbs, 'utf8');
    if (existing && existing.type === 'doc') plan.push({ ovPath, kind: 'update', id: existing.id, content });
    else if (existing && existing.type === 'file') plan.push({ ovPath, kind: 'replace', id: existing.id, parentId, name, content });
    else plan.push({ ovPath, kind: 'create', parentId, name, content });
  }

  const deletions = [];
  if (CFG.purge) {
    const wantPaths = new Set([...desired.keys()]);
    for (const [p, info] of tree) {
      if (p === '/') continue;
      if (info.isFolder ? ![...wantPaths].some(w => w.startsWith(p)) : !wantPaths.has(p)) deletions.push({ ovPath: p, ...info });
    }
  }

  if (CFG.dryRun) {
    console.error('\n--- dry run (no changes) ---');
    for (const p of plan) console.error(`  ${p.kind === 'update' ? 'upsert' : p.kind === 'replace' ? 'replace' : 'create'}  ${p.ovPath}`);
    for (const d of deletions) console.error(`  delete  ${d.ovPath}`);
    console.error(`--- ${plan.length} upsert(s), ${deletions.length} delete(s) ---`);
    sm.disconnect(); process.exit(0);
  }

  // confirm destructive purge
  if (CFG.purge && deletions.length && !CFG.yes && process.stdin.isTTY) {
    console.error(`\nAbout to DELETE ${deletions.length} entity(ies) on Overleaf (recoverable via version history):`);
    for (const d of deletions.slice(0, 20)) console.error(`  - ${d.ovPath}`);
    if (deletions.length > 20) console.error(`  ... and ${deletions.length - 20} more`);
    process.stderr.write('Proceed? [y/N] ');
    const ans = cp.execSync('read line; echo "$line"', { stdio: ['inherit', 'pipe', 'inherit'], shell: '/bin/bash' }).toString().trim().toLowerCase();
    if (ans !== 'y' && ans !== 'yes') { console.error('aborted.'); sm.disconnect(); process.exit(1); }
  }

  deletions.sort((a, b) => b.ovPath.length - a.ovPath.length); // leaves first
  let deleted = 0;
  for (const d of deletions) { try { await deleteEntity(d.type, d.id); deleted++; console.error(`  deleted ${d.ovPath}`); } catch (e) { console.error(`  DELETE FAIL ${d.ovPath}: ${e.message}`); } }

  let created = 0, updated = 0, unchanged = 0;
  for (const p of plan) {
    try {
      if (p.kind === 'create') { const id = await createDoc(p.name, p.parentId); const r = await setDocContent(sm, id, p.content); created++; console.error(`  created ${p.ovPath}`); }
      else if (p.kind === 'update') { const r = await setDocContent(sm, p.id, p.content); r === 'updated' ? updated++ : unchanged++; }
      else if (p.kind === 'replace') { await deleteEntity('file', p.id); const id = await createDoc(p.name, p.parentId); await setDocContent(sm, id, p.content); created++; console.error(`  replaced ${p.ovPath}`); }
    } catch (e) { console.error(`  FAIL ${p.ovPath}: ${e.message}`); }
  }

  // verify: fresh reconnect, read back every doc, compare byte-for-byte
  console.error('\nverifying...');
  sm.disconnect();
  const vsm = new SocketManager(COOKIE, CFG.project, () => {});
  const vrf = (await vsm.connect()).project.rootFolder;
  const vtree = walkTree(Array.isArray(vrf) ? vrf[0] : vrf);
  let mismatches = 0, ok = 0;
  for (const [ovPath, localAbs] of desired) {
    const info = vtree.get(ovPath);
    if (!info) { console.error(`  MISSING ${ovPath}`); mismatches++; continue; }
    if (info.type !== 'doc') { console.error(`  NOT A DOC ${ovPath}`); mismatches++; continue; }
    try {
      const remote = ((await vsm.joinDoc(info.id)).lines || []).join('\n');
      const local = fs.readFileSync(localAbs, 'utf8');
      if (remote === local) ok++; else { mismatches++; console.error(`  MISMATCH ${ovPath} (remote ${remote.length}B vs local ${local.length}B)`); }
    } catch (e) { mismatches++; console.error(`  verify FAIL ${ovPath}: ${e.message}`); }
  }
  if (CFG.purge) {
    const want = new Set([...desired.keys()]);
    for (const [p] of vtree) { if (p !== '/' && !p.endsWith('/') && !want.has(p)) { console.error(`  LEFTOVER ${p}`); mismatches++; } }
  }
  console.error(`\ndone: ${created} created, ${updated} updated, ${unchanged} unchanged, ${deleted} deleted | verify ok=${ok} mismatch=${mismatches}`);
  vsm.disconnect();
  process.exit(mismatches ? 1 : 0);
})().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
