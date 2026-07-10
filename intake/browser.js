#!/usr/bin/env node
// Browser intake (experimental): drives a real Chromium window with
// Playwright to read the BuildingConnected Bid Board and download plan
// files — filling the gap email intake can't (file downloads need a login).
//
// NOTE: automated access to the BuildingConnected web app is likely against
// their terms of service. This script only touches AJ's own account and
// data, runs attended (a visible window, human-paced), and is the fallback
// while API access (paid Bid Board Pro) is not in place. Prefer the API
// when available.
//
// Setup (one time):
//   npm install playwright && npx playwright install chromium
// First run opens a window — log in to BuildingConnected manually; the
// session is kept in data/browser-profile/ so later runs are already
// signed in.
//
// Usage: node intake/browser.js

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const BID_BOARD_URL = 'https://app.buildingconnected.com/opportunities';

const ctx = await chromium.launchPersistentContext('data/browser-profile', {
  headless: false, // attended by design — keep the window visible
  viewport: { width: 1440, height: 900 },
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(BID_BOARD_URL);

// If we land on a login page, wait for AJ to sign in manually.
if (!page.url().includes('/opportunities')) {
  console.log('Not signed in — log in to BuildingConnected in the window.');
  console.log('Waiting until the Bid Board loads (up to 5 minutes)...');
  await page.waitForURL('**/opportunities**', { timeout: 5 * 60 * 1000 });
}
console.log('On the Bid Board.');

// ---------------------------------------------------------------------------
// TODO(next session): the selectors below must be built against the live
// DOM (develop with AJ signed in, inspecting via Claude's browser tools).
// Planned flow:
//   1. Read each row: name, trade, due date, project size, location, client.
//   2. Merge into data/bids.json (same shape as email intake, source:'browser').
//   3. For each new bid: open detail page -> Files tab -> "Download All",
//      save into downloads/<bid-name>/ and record paths in bids.json.
// ---------------------------------------------------------------------------
console.log('Row scraping is not implemented yet — this run only verifies login/session persistence.');

await ctx.close();
