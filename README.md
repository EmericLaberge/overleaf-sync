# overleaf-sync

Push a local LaTeX project to **Overleaf** (overleaf.com *or any Server Pro /
self-hosted instance*) from the command line — **no git bridge required**.

Dependency-driven: you point it at a root `.tex` and it traces `\input`,
`\include`, `\bibliography`, and local `\usepackage`, then uploads **exactly the
compile-closure** to Overleaf. Works on instances where the git bridge isn't
enabled (the common self-hosted case).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why

Overleaf's official git integration requires Server Pro **and** an admin-configured
git host. Many self-hosted instances (universities, companies) license the feature
but never deploy it — so `git clone/push` just doesn't work. `overleaf-sync` uses
the same web + real-time (OT) API the Overleaf editor uses, so it works anywhere
you can log in.

## Install

```bash
git clone https://github.com/EmericLaberge/overleaf-sync.git
cd overleaf-sync
npm install                # pulls socket.io-client (Overleaf's fork) from GitHub
npm install -g .           # exposes the `overleaf-sync` command globally
```

Requires **Node ≥ 18**. The Socket.IO/OT engine is vendored in `lib/` (sourced
from [overleaf.nvim](https://github.com/richwomanbtc/overleaf.nvim), MIT) — there
is **no dependency on the overleaf.nvim plugin**.

## Quick start

```bash
cd my-paper/                                   # your LaTeX project
cat > .env <<EOF                               # one-time config
OVERLEAF_HOST=https://overleaf.example.edu
OVERLEAF_PROJECT=<your-project-id>
OVERLEAF_COOKIE=overleaf.sid=s%3A...
EOF
overleaf-sync --dry-run --purge                # preview what would change
overleaf-sync --purge                          # push
```

Log in to your Overleaf instance in **Firefox** once and the cookie is read
automatically (no need to put it in `.env`). The cookie name is auto-detected:
`overleaf_session2` for overleaf.com, `overleaf.sid` for self-hosted.

## How it works

1. **Resolve** the compile-closure of the root `.tex` (`\input`/`\include` →
   `.tex`, `\bibliography{...}` → `.bib`, `\usepackage{name}` → local `name.sty`).
   The root becomes `/main.tex` on Overleaf; deps keep their relative paths.
2. **Authenticate** with the session cookie (`overleaf.sid` / `overleaf_session2`).
3. **Diff** against the live project tree (fetched over Socket.IO `joinProject`).
4. **Push** content via Operational Transformation — `.tex`/`.bib`/`.sty` are
   Overleaf *documents*, so content is set with one `joinDoc` + `applyOtUpdate`
   op per file (binary `/upload` is unused: Overleaf rejects `.tex` there).
   Create/delete entities over HTTP (`POST /doc`, `/folder`, `DELETE /<type>/<id>`).
5. **Verify** — reconnects, re-joins every doc, and compares remote to local
   **byte-for-byte**. Exits non-zero on any mismatch. `--purge` also checks no
   entities are left over.

## Configuration

Precedence: **`--flag`** > **`OVERLEAF_*` env / `.env`** > **`overleaf-sync.json`** > **default**.

| flag | env | default | meaning |
|---|---|---|---|
| `--root <file>` | — | `<paper>/main.tex` | root `.tex`; its compile-closure is uploaded |
| `--paper <dir>` | `OVERLEAF_PAPER` | `.` (cwd) | local project dir |
| `--project <id>` | `OVERLEAF_PROJECT` | — *(required)* | Overleaf project id |
| `--host <url>` | `OVERLEAF_HOST` | `https://www.overleaf.com` | Overleaf base URL |
| `--config <file>` | — | `<paper>/overleaf-sync.json` | project config file (see below) |
| `--cookie <v>` | `OVERLEAF_COOKIE` | *(Firefox)* | session cookie value |
| `--cookie-name <n>` | — | *auto* | `overleaf_session2` (overleaf.com) / `overleaf.sid` (self-hosted) |
| `--browser <name>` | — | `firefox` | cookie source (`firefox`; `chrome` TODO) |
| `--dry-run` | — | off | preview, change nothing |
| `--purge` | — | off | delete Overleaf entities not in the closure (prompts unless `--yes`; recoverable via Overleaf version history) |
| `--yes` | — | off | skip the purge confirmation |


### Project config file (`overleaf-sync.json`)

Drop a `overleaf-sync.json` in your project dir and `overleaf-sync` picks up
host/project/root automatically — no flags needed:

```json
{
  "host": "https://overleaf.example.edu",
  "project": "<your-project-id>",
  "root": "main.tex",
  "cookieName": "overleaf.sid",
  "purge": false
}
```

Then from the project dir: `overleaf-sync --dry-run --purge`. Any key can also be
set via env/`.env` or a `--flag`; flags win. Keep the cookie out of this file
(it's a secret) — use Firefox auto-extract, `.env`, or `--cookie`.

### Getting the cookie manually

Firefox/Chrome → DevTools → Application → Cookies → your Overleaf host → copy the
`overleaf.sid` (or `overleaf_session2`) value. Put it in `.env` as
`OVERLEAF_COOKIE=overleaf.sid=<value>` or pass `--cookie '<value>'`.

## Examples

```bash
overleaf-sync --dry-run --purge                              # safest first run
overleaf-sync --purge --yes                                  # non-interactive (CI)
overleaf-sync --host https://overleaf.uni.edu --project abc  # self-hosted
overleaf-sync --root thesis.tex --paper ./thesis             # custom root
overleaf-sync                                               # all config from .env
```

## Limitations

- `\includegraphics` (binary image assets) are **not** traced yet — only `.tex`,
  `.bib`, and local `.sty`. Fine for TikZ-based projects. PR welcome for binary
  upload.
- Cookie extraction is Firefox-only for now (Chrome auto-extract is a TODO);
  `--cookie` / `OVERLEAF_COOKIE` work for any browser/platform.
- Self-hosted Overleaf returns `project.rootFolder` as a one-element array under
  the v1 Socket.IO scheme — handled automatically.

## License

MIT. The `lib/` engine (`auth.js`, `socket.js`) is sourced from
[overleaf.nvim](https://github.com/richwomanbtc/overleaf.nvim) (MIT, © its
authors). `socket.io-client` is [Overleaf's fork](https://github.com/overleaf/socket.io-client)
of the 0.9 client, pulled at install time.
