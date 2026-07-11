# EpoxyCreations Estimator

Bid automation dashboard for EpoxyCreations' commercial work. Watches the
BuildingConnected Bid Board, drafts takeoffs and quotes with AI, and — after
human approval — sends the proposal to the GC.

## The problem

Bid invites arrive on BuildingConnected's Bid Board (epoxy flooring, polished
concrete, concrete sealing jobs across Florida). Today each one requires
manually: downloading the permit-set PDFs, doing a takeoff to find flooring
sq ft and scope, building an estimate in Joist, and sending it back to the GC
before the due date. Roughly 10+ open invites at any time; most invites don't
include project size, so the sq ft has to be measured from plans.

## The workflow this tool automates

1. **Intake** — pull opportunities from the BuildingConnected API (webhooks
   for `opportunity.created`, plus a scheduled sync). Capture name, GC/client,
   due date, location, scope of work, and download the plan files.
2. **Takeoff (AI drafts, AJ verifies)** — Claude reads the permit-set PDFs:
   extracts room/finish schedules, flooring scope notes, and areas. Output is
   a draft takeoff (areas by coating system) that AJ reviews and corrects in
   the dashboard before pricing.
3. **Quote** — apply EpoxyCreations pricing rules (see `pricing/`) to the
   verified takeoff: $/sq ft by system, prep, moisture mitigation,
   mobilization, minimums. Produces a draft quote with line items.
4. **Send (approval-gated)** — generate a branded proposal PDF and, only after
   AJ clicks approve, deliver it to the GC: submit via the BuildingConnected
   bid form (API `POST bids`) and/or email to the estimator contact.

The tool never submits a bid without explicit approval.

## Key facts discovered during scoping (July 2026)

- **BuildingConnected API** is part of Autodesk Platform Services (APS):
  read/write endpoints for opportunities, projects, files, invites, and bids,
  plus webhooks (`opportunity.created`, `bid.created`, etc.). Bid Board API
  access is tied to a **Bid Board Pro** subscription — currently on trial;
  long-term automation requires the paid plan.
  Docs: https://aps.autodesk.com/en/docs/buildingconnected/v2/developers_guide/overview/
- **Joist** (pro.joistapp.com — current quoting app) has **no public API**;
  only QuickBooks/payment integrations. So this tool generates its own
  proposal PDFs rather than pushing into Joist. Joist remains for residential
  work; line items can be copied over manually if a record in Joist is wanted.
- **Pricing rules are undocumented** — they live in AJ's head. Phase 0 is a
  structured pricing interview to encode them (see
  `pricing/INTERVIEW.md`).

## Using the tool (current state)

```
npm run pipeline       # the whole thing: intake → plans → AI takeoff → draft quotes
npm run dashboard      # open http://localhost:8788 to approve / tweak / send
```

`npm run pipeline` pulls new invites from Outlook, opens a browser to
download each new bid's plan files from BuildingConnected (first run:
sign in once in the window that opens; the session is remembered), runs
the AI takeoff on each new plan set, prices it, and leaves every bid in
the dashboard at status "quote" — ready to approve, tweak, or send.
`--no-browser` skips the plan-download step.

Individual steps, if needed:

```
npm run intake:email     # just pull new invites
npm run intake:browser   # just fetch missing plan files
```

Per-bid workflow in the dashboard:
1. **Plans** — download the set from BuildingConnected ("Download All") and
   drop the PDFs into the folder shown on the bid (data/plans/<id>/).
2. **Run AI takeoff** — headless Claude reads the plans (uses your Claude
   Code login, no API key), fills system/sqft/prep, and reports a summary
   with judgment calls to verify. Takes a few minutes for a big set.
3. **Review** — adjust the takeoff fields; the quote reprices live.
4. **Generate proposal PDF** — branded estimate (Joist look, sequential
   numbering continuing at #419) written to proposals/.
5. **Send to GC…** — emails the PDF from contact@epoxycreationsfl.com via
   Microsoft Graph after a confirm dialog. First use requires a one-time
   device-code sign-in (the UI walks through it). If Microsoft reports a
   permissions error, add **Mail.Send** (Delegated) to the Entra app the
   same way Mail.Read was added.

## Architecture (planned)

- **Web dashboard** (single user): list of open bids with status
  (new → takeoff review → quote review → approved → sent), detail view per
  bid with plan viewer, editable takeoff table, quote editor, approve-and-send.
- **Server**: Node.js. Handles APS OAuth (3-legged), webhook receiver,
  file sync, Anthropic API calls for plan extraction, PDF generation, email
  sending. Needs a small always-on host for webhooks + OAuth callback
  (start local-with-tunnel, promote later).
- **Storage**: SQLite — one user, low volume.
- **AI**: Anthropic API (latest Claude model) for reading permit sets and
  drafting takeoffs.

## Roadmap

- **Phase 0 — Pricing rules**: interview AJ, encode rules as data
  (`pricing/rules.yaml`), unit-test against past real quotes.
- **Phase 1 — Intake**: APS app + OAuth, sync Bid Board opportunities and
  files into SQLite, basic dashboard listing bids by due date.
- **Phase 2 — Takeoff + quote drafting**: AI plan extraction, review UI,
  pricing engine, draft quote per bid.
- **Phase 3 — Proposal + send**: branded PDF generation, email delivery,
  BuildingConnected bid submission, approval gate, audit log.

## API connection status (2026-07-10)

- APS app **EpoxyCreations Estimator** created (Traditional Web App,
  callback `http://localhost:8787/callback`); credentials in gitignored
  `.env`.
- `node connect.js` completes 3-legged OAuth and saves/refreshes
  `tokens.json`. `GET /users/me` returns 200 — auth and app config verified.
- **Blocker:** Bid Board endpoints (`GET /opportunities`) return
  `403 BB_PRO_SUBSCRIPTION_REQUIRED`. The limited trial shows
  `hasBbPro: true` in the product but API access requires **paid** Bid Board
  Pro. Until then, intake is manual (Download All on an invite → drop PDFs
  in a folder).

## Email intake setup (Outlook / Microsoft 365)

The mailbox for `contact@epoxycreationsfl.com` is on Microsoft 365, so
intake uses the Microsoft Graph API (basic IMAP auth is disabled on M365).
One-time registration:

1. Go to https://entra.microsoft.com (sign in as the mailbox account) →
   **Identity → Applications → App registrations → New registration**.
2. Name: `EpoxyCreations Estimator`. Supported account types: *Accounts in
   this organizational directory only*. No redirect URI. Register.
3. On the app page: **Authentication → Advanced settings → Allow public
   client flows → Yes** → Save.
4. **API permissions → Add a permission → Microsoft Graph → Delegated →
   Mail.Read** → Add.
5. Copy the **Application (client) ID** (and optionally the Directory
   (tenant) ID) into `.env` as `MS_CLIENT_ID` / `MS_TENANT_ID`.

Then run `npm run intake:email` — it prints a code and a microsoft.com URL
for a one-time sign-in; tokens persist in `ms-tokens.json` (gitignored).

## Prerequisites AJ must set up

- [x] Create an APS app at https://aps.autodesk.com (done — see above)
- [ ] Bid Board Pro: ask BuildingConnected support about API access on trial
      / pricing, or subscribe (unblocks automatic intake instantly)
- [ ] Anthropic API key for the plan-reading agent
- [ ] Complete the pricing interview (Phase 0)
- [ ] A sample of 3–5 past quotes (Joist PDFs) to validate the pricing engine
      and to match proposal branding
