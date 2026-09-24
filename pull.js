#!/usr/bin/env node
'use strict';
/* pull.js — read-only Overleaf access: list projects / fetch history updates. GET only. */
const fs = require('fs'); const os = require('os'); const path = require('path'); const cp = require('child_process');
const https = require('https'); const http = require('http');

const args = process.argv.slice(2);
const argVal = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined; };
const HOST = argVal('host') || process.env.OVERLEAF_HOST || 'https://overleaf.iro.umontreal.ca';
const PROJECT = argVal('project') || process.env.OVERLEAF_PROJECT;
const OUT = argVal('out') || '.';
const die = (m) => { console.error('error: ' + m); process.exit(2); };

function cookieFromFirefox() {
  const host = new URL(HOST).hostname;
  const dirs = fs.readdirSync(path.join(os.homedir(), '.mozilla/firefox')).filter(d => d.endsWith('.default-release')).map(d => path.join(os.homedir(), '.mozilla/firefox', d));
  for (const prof of dirs) {
    const src = path.join(prof, 'cookies.sqlite');
    if (!fs.existsSync(src)) continue;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cookie-'));
    try {
      fs.copyFileSync(src, path.join(tmp, 'cookies.sqlite'));
      for (const ext of ['-wal', '-shm']) if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, path.join(tmp, 'cookies.sqlite' + ext));
      const row = cp.execSync(`sqlite3 "${path.join(tmp, 'cookies.sqlite')}" "SELECT value FROM moz_cookies WHERE host='${host}' AND name='overleaf.sid' LIMIT 1;"`).toString().trim();
      if (row) return `overleaf.sid=${row}`;
    } catch (e) {} finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
  }
  return null;
}

function getBuf(url, cookie, n = 5) {
  return new Promise((resolve, reject) => {
    const p = new URL(url); const mod = p.protocol === 'http:' ? http : https;
    const req = mod.request({ hostname: p.hostname, port: p.port || (p.protocol === 'http:' ? 80 : 443), path: p.pathname + p.search, method: 'GET',
      headers: { Cookie: cookie, 'User-Agent': 'overleaf-pull/0.1', Accept: '*/*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && n > 0) { res.resume(); return resolve(getBuf(new URL(res.headers.location, url).toString(), cookie, n - 1)); }
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject); req.setTimeout(60000, () => req.destroy(new Error('timeout'))); req.end();
  });
}

(async () => {
  const cookie = cookieFromFirefox();
  if (!cookie) die('no overleaf.sid cookie in Firefox for ' + new URL(HOST).hostname);
  fs.mkdirSync(OUT, { recursive: true });

  if (!PROJECT) {
    const res = await getBuf(`${HOST}/api/project`, cookie);
    if (res.status !== 200) die(`/api/project HTTP ${res.status}`);
    for (const p of JSON.parse(res.body.toString()).projects.sort((a, b) => String(b.lastUpdated).localeCompare(String(a.lastUpdated))))
      console.log(`${p._id}  ${new Date(p.lastUpdated).toISOString()}  ${JSON.stringify(p.name)}`);
    return;
  }

  for (const [name, url] of [
    ['updates.json', `${HOST}/project/${PROJECT}/updates?min_count=0`],
    ['snapshot.zip', `${HOST}/project/${PROJECT}/download/zip`],
  ]) {
    try {
      const r = await getBuf(url, cookie);
      fs.writeFileSync(path.join(OUT, name), r.body);
      console.error(`${name}: HTTP ${r.status}, ${r.body.length} B`);
    } catch (e) { console.error(`${name}: FAIL ${e.message}`); }
  }
})().catch(e => { console.error('fatal:', e.message || e); process.exit(1); });
