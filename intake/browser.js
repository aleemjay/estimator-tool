#!/usr/bin/env node
// Plan fetcher: drives a real Chromium window (Playwright) to download each
// bid's plan files from BuildingConnected into data/plans/<key>/.
//
// First run opens a visible window on the login page — sign in once; the
// session persists in data/browser-profile/ and later runs are silent.
// Attended by design: a visible, human-paced window on AJ's own account.
// The API (paid Bid Board Pro) replaces this when available.
//
// Usage:
//   node intake/browser.js            # fetch plans for active bids missing them
//   node intake/browser.js --key <bidKey>

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSlug } from '../takeoff/run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIDS = join(ROOT, 'data/bids.json');
const PLANS = join(ROOT, 'data/plans');
const CLOSED = new Set(['won', 'lost', 'declined', 'archived', 'sent']);

const onlyKey = process.argv.includes('--key') ? process.argv[process.argv.indexOf('--key') + 1] : null;

const bids = JSON.parse(readFileSync(BIDS, 'utf8'));
const targets = Object.entries(bids).filter(([key, b]) => {
  if (onlyKey) return key === onlyKey;
  if (CLOSED.has(b.status)) return false;
  if (!b.rfpId && !b.link) return false;
  const dir = join(PLANS, planSlug(key));
  const have = existsSync(dir) && readdirSync(dir).some(f => /\.(pdf|png|jpe?g)$/i.test(f));
  return !have && !b.plansFetchFailed;
});

if (!targets.length) {
  console.log('No bids need plan fetching.');
  process.exit(0);
}
console.log(`Fetching plans for ${targets.length} bid(s)...`);

const ctx = await chromium.launchPersistentContext(join(ROOT, 'data/browser-profile'), {
  headless: false,
  channel: undefined,
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

async function ensureLoggedIn() {
  await page.goto('https://app.buildingconnected.com/opportunities', { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) {
    console.log('\n>>> Not signed in. Log in to BuildingConnected in the window (one time).');
    console.log('>>> Waiting up to 5 minutes...\n');
    try {
      await page.waitForURL(u => !String(u).includes('/login'), { timeout: 5 * 60 * 1000 });
    } catch {
      console.log('LOGIN_TIMEOUT: BuildingConnected sign-in was not completed in the browser window. Click "Fetch plans" again when you are ready to sign in.');
      await ctx.close();
      process.exit(1);
    }
    console.log('Signed in.');
  }
}

async function fetchPlans(key, bid) {
  const url = bid.rfpId ? `https://app.buildingconnected.com/rfps/${bid.rfpId}/bid` : bid.link;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // Files tab (per AJ's UI: Overview | Files | Messages | Bid Form)
  const filesTab = page.getByRole('tab', { name: /^files/i }).or(page.getByText(/^Files$/i).first());
  await filesTab.first().click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  // Prefer the Client Files view if the toggle exists
  const clientToggle = page.getByText(/^Client\s*Files$/i).first();
  if (await clientToggle.isVisible().catch(() => false)) await clientToggle.click().catch(() => {});

  const downloadAll = page.getByRole('button', { name: /download all/i }).or(page.getByText(/download all/i).first());
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5 * 60 * 1000 }),
    downloadAll.first().click({ timeout: 15000 }),
  ]);

  const dir = join(PLANS, planSlug(key));
  mkdirSync(dir, { recursive: true });
  const suggested = download.suggestedFilename();
  const saved = join(dir, suggested);
  await download.saveAs(saved);

  if (/\.zip$/i.test(suggested)) {
    execFileSync('/usr/bin/unzip', ['-o', '-j', saved, '-d', dir], { stdio: 'pipe' });
    execFileSync('/bin/rm', [saved]);
  }
  const files = readdirSync(dir).filter(f => /\.(pdf|png|jpe?g)$/i.test(f));
  return files;
}

await ensureLoggedIn();
let ok = 0, failed = 0;
for (const [key, bid] of targets) {
  process.stdout.write(`  ${bid.project} ... `);
  try {
    const files = await fetchPlans(key, bid);
    bid.plansFetchedAt = new Date().toISOString();
    delete bid.plansFetchFailed;
    console.log(`${files.length} file(s)`);
    ok++;
  } catch (e) {
    bid.plansFetchFailed = e.message.split('\n')[0].slice(0, 200);
    console.log(`FAILED: ${bid.plansFetchFailed}`);
    failed++;
  }
  writeFileSync(BIDS, JSON.stringify(bids, null, 2));
  await page.waitForTimeout(1500 + Math.random() * 2000);
}

await ctx.close();
console.log(`\nDone: ${ok} fetched, ${failed} failed.`);
if (failed) console.log('Failed bids are marked plansFetchFailed in data/bids.json (cleared on retry with --key).');
