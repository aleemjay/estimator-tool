# EpoxyCreations Estimator

Bid automation for EpoxyCreations LLC (AJ's commercial epoxy/concrete
flooring business, Kissimmee FL). Pipeline: BuildingConnected invites →
email intake → plan download → AI takeoff → priced quote → branded
proposal PDF → approval-gated send to the GC. See README.md for setup
history and usage.

## Commands

- `npm run dashboard` — web UI on http://localhost:8788 (normally already
  running via LaunchAgent `com.epoxycreations.estimator`, which also
  keeps the Mac awake; reachable from AJ's phone over Tailscale at
  http://100.111.28.79:8788). `./setup/install-launchagent.sh`
  installs/refreshes the agent (RunAtLoad + KeepAlive + logs/server.log)
- `npm run pipeline` — full sweep: intake → plan fetch → takeoffs → quotes
  (skips past-due bids; `--include-overdue` to force)
- `npm run intake:email` — pull new invites from Outlook (Graph)
- `npm run intake:browser` — fetch missing plan files from BuildingConnected
- `npm run login` — re-establish the BuildingConnected browser session
- `node pricing/quote.js --system epoxy_flake --sqft 2400` — CLI quote

## Architecture

- `server.js` — zero-framework HTTP server + JSON API; serves
  `public/index.html` (single-file UI, live-refreshes every 15s)
- `intake/email.js` — Microsoft Graph device-code auth; groups
  BuildingConnected notification emails into bids by rfps/<id> link +
  fuzzy name match → `data/bids.json`
- `intake/browser.js` — Playwright plan downloader (attended-capable);
  auto-resumes Autodesk SSO prompts, never touches credential fields.
  Also `--set-status <label> --key <key>`: flips the bid's Bid Board
  status on BC (server triggers it with "Bidding" after each send;
  records bcStatus/bcStatusFailed on the bid)
- `takeoff/run.js` — headless `claude -p` reads plan PDFs in
  `data/plans/<key>/`, returns items[] (one per system), terse
  scope/not-scope, judgment calls (~$1/run, uses AJ's Claude login)
- `pricing/rules.yaml` — AJ's rate card + proposal language (interviewed
  July 2026). rules are DATA; the engine is `pricing/quote.js`
- `proposal/generate.js` — pdfkit estimate matching AJ's Joist format
  exactly (numbering continues from #419 via data/estimate-counter.json)
- `proposal/send.js` — Graph sendMail, separate Mail.Send token,
  device-code flow driven from the UI

## Hard-won constraints — do not regress

- **bids.json single-writer discipline**: any long-running process must
  re-read the file and patch only its own fields before saving (see
  `recordFetchResult` in intake/browser.js). A whole-object save from a
  stale read once wiped completed takeoff data.
- **BuildingConnected browser must run headed** (`headless: false`):
  headless Chromium can't decrypt the persistent profile's cookies on
  macOS (different keychain entry) and lands on the login page.
- **Never enter credentials programmatically** — the browser fetcher may
  click Autodesk's "Sign in" session-resume button only; passwords/MFA
  wait for the human (30-min window).
- **Restart the server after editing pricing/rules.yaml or any module**
  — RULES is cached at import time (`kill $(lsof -ti :8788)` then the
  LaunchAgent restarts it, or `launchctl kickstart -k gui/$(id -u)/com.epoxycreations.estimator`).
- **Totals are exact** (no $500 rounding — AJ's explicit choice), job
  minimum $1,000, no MVB exclusion note on proposals, never mention
  warranty. Quote supports multiple system items per bid.
- Bid Board API (Autodesk APS) is connected and authed (`connect.js`,
  tokens.json) but gated: opportunities return 403 until AJ buys paid
  Bid Board Pro. Browser automation is the interim (ToS-gray, attended).
- gitignored and machine-local: `.env`, all token files, `data/`,
  `downloads/`, `proposals/`, browser profile. Never commit bid data or
  GC contact info.

## Voice/format rules for anything customer-facing

Proposals mirror AJ's Joist estimates #417/#418: logo header, Prepared
For block, per-system sections (intro → "1. System Description" →
"2. Proposed Scope of Work" with Surface Preparation / Installation
subheads → Estimated Coverage), Subtotal/Total, signature page.
