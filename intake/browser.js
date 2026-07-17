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
//   node intake/browser.js --login    # one-time sign-in only (waits 30 min)
//   node intake/browser.js --set-status Bidding --key <bidKey>
//                                     # flip the bid's Bid Board status on BC

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
const loginOnly = process.argv.includes('--login');
const includeOverdue = process.argv.includes('--include-overdue');
const setStatusTo = process.argv.includes('--set-status') ? process.argv[process.argv.indexOf('--set-status') + 1] : null;

const bids = JSON.parse(readFileSync(BIDS, 'utf8'));
let skippedOverdue = 0;
const targets = (loginOnly || setStatusTo) ? [] : Object.entries(bids).filter(([key, b]) => {
  if (onlyKey) return key === onlyKey;
  if (CLOSED.has(b.status)) return false;
  if (!b.rfpId && !b.link) return false;
  if (!includeOverdue) {
    const due = new Date(b.due ?? '');
    if (!isNaN(due) && due < new Date(new Date().toDateString())) { skippedOverdue++; return false; }
  }
  const dir = join(PLANS, planSlug(key));
  const have = existsSync(dir) && readdirSync(dir).some(f => /\.(pdf|png|jpe?g)$/i.test(f));
  return !have && !b.plansFetchFailed;
});
if (skippedOverdue) console.log(`(skipping ${skippedOverdue} past-due bid(s) — use --include-overdue to force)`);

// Resolve the --set-status target bid (by --key, or --project name match)
// BEFORE opening a browser window, so bad input fails fast.
let statusKey = null;
if (setStatusTo) {
  const proj = process.argv.includes('--project') ? process.argv[process.argv.indexOf('--project') + 1] : null;
  if (onlyKey && bids[onlyKey]) {
    statusKey = onlyKey;
  } else if (proj) {
    const matches = Object.entries(bids).filter(([, b]) => (b.project ?? '').toLowerCase().includes(proj.toLowerCase()));
    if (matches.length !== 1) {
      console.log(matches.length
        ? `SET_STATUS_FAILED: "${proj}" matches ${matches.length} bids: ${matches.map(([k]) => k).join(', ')}`
        : `SET_STATUS_FAILED: no bid whose project name contains "${proj}"`);
      process.exit(1);
    }
    statusKey = matches[0][0];
  } else {
    console.log(onlyKey
      ? `SET_STATUS_FAILED: no bid with key "${onlyKey}"`
      : 'SET_STATUS_FAILED: pass --key <bidKey> or --project <name substring>');
    console.log('Known bids:', Object.keys(bids).join(', '));
    process.exit(1);
  }
  console.log(`Target: ${bids[statusKey].project} (${statusKey}) -> "${setStatusTo}"`);
}

if (!loginOnly && !setStatusTo && !targets.length) {
  console.log('No bids need plan fetching.');
  process.exit(0);
}
if (!loginOnly && !setStatusTo) console.log(`Fetching plans for ${targets.length} bid(s)...`);

const ctx = await chromium.launchPersistentContext(join(ROOT, 'data/browser-profile'), {
  headless: false,
  channel: undefined,
  viewport: { width: 1440, height: 900 },
  acceptDownloads: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

// Signed-out states: BC's own /login page, or Autodesk SSO (signin.autodesk.com).
const NEEDS_AUTH = url => /signin\.autodesk\.com|accounts\.autodesk\.com|app\.buildingconnected\.com\/login/.test(url);

// Wait for auth to complete. If Autodesk SSO just wants a click to resume the
// remembered session, click it. NEVER touches credential fields — if a
// password/MFA is requested, we wait for the human.
async function completeAuth(timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('app.buildingconnected.com') && !NEEDS_AUTH(url)) return true;
    const hasPassword = await page.locator('input[type="password"]').filter({ visible: true }).count().catch(() => 0);
    if (!hasPassword && /signin\.autodesk\.com|accounts\.autodesk\.com/.test(url)) {
      // Session-resume prompt: a lone "Sign in" button for the remembered account.
      const resume = page.getByRole('button', { name: /^sign in$/i }).first();
      if (await resume.isVisible().catch(() => false)) {
        await resume.click().catch(() => {});
        await page.waitForTimeout(5000);
        continue;
      }
    }
    if (!announced) {
      console.log('>>> Sign-in needed: complete it in the browser window (waiting up to 30 minutes)...');
      announced = true;
    }
    await page.waitForTimeout(3000);
  }
  return false;
}

async function gotoAuthed(url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  if (NEEDS_AUTH(page.url())) {
    if (!(await completeAuth())) {
      console.log('LOGIN_TIMEOUT: sign-in was not completed. Run "npm run login" when ready.');
      await ctx.close();
      process.exit(1);
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
  }
}

async function ensureLoggedIn() {
  await gotoAuthed('https://app.buildingconnected.com/opportunities');
  console.log('Signed in.');
}

async function fetchPlans(key, bid) {
  const base = bid.rfpId ? `https://app.buildingconnected.com/rfps/${bid.rfpId}` : null;
  // Try the direct files route first; fall back to clicking the Files tab.
  await gotoAuthed(base ? `${base}/files` : bid.link);
  if (!/\/files/i.test(page.url())) {
    const filesTab = page.getByRole('tab', { name: /^files/i }).or(page.getByText(/^Files$/i).first());
    await filesTab.first().click({ timeout: 30000 });
    await page.waitForTimeout(2500);
  }

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

// The Bid Board status control on an opportunity page shows the current
// state (Undecided / Bidding / Declined / ...) and opens a menu of states.
const BC_STATES = /undecided|considering|bidding|not bidding|declined|submitted|won|lost/i;

async function setBcStatus(bid, statusLabel) {
  const url = bid.rfpId ? `https://app.buildingconnected.com/rfps/${bid.rfpId}` : bid.link;
  if (!url) throw new Error('bid has no BuildingConnected link');
  await gotoAuthed(url);
  const exact = new RegExp(`^\\s*${statusLabel}\\s*$`, 'i');
  const control = page.getByRole('button', { name: BC_STATES }).or(page.getByRole('combobox', { name: BC_STATES })).first();
  await control.waitFor({ timeout: 30000 });
  if (await control.textContent().catch(() => '').then(t => exact.test(t ?? ''))) return; // already set
  await control.click();
  await page.waitForTimeout(1200);
  const option = page.getByRole('menuitem', { name: exact })
    .or(page.getByRole('option', { name: exact }))
    .or(page.getByText(exact));
  await option.first().click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  const shown = await page.getByRole('button', { name: exact }).or(page.getByRole('combobox', { name: exact }))
    .first().isVisible().catch(() => false);
  if (!shown) throw new Error(`clicked "${statusLabel}" but the status control does not show it`);
}

await ensureLoggedIn();
if (loginOnly) {
  console.log('Session saved. Plan fetching is now fully automatic — close this window or it closes itself.');
  await ctx.close();
  process.exit(0);
}

// Re-read bids.json fresh and touch ONLY this bid's fetch fields, so a slow
// fetch never overwrites takeoff/quote data written meanwhile by the server.
function recordFetchResult(key, patch) {
  const fresh = JSON.parse(readFileSync(BIDS, 'utf8'));
  if (!fresh[key]) return;
  Object.assign(fresh[key], patch);
  if (patch.plansFetchedAt) delete fresh[key].plansFetchFailed;
  if (patch.bcStatus) delete fresh[key].bcStatusFailed;
  writeFileSync(BIDS, JSON.stringify(fresh, null, 2));
}

if (setStatusTo) {
  const bid = bids[statusKey];
  try {
    await setBcStatus(bid, setStatusTo);
    recordFetchResult(statusKey, { bcStatus: setStatusTo, bcStatusAt: new Date().toISOString() });
    console.log(`BC status set to "${setStatusTo}" for ${bid.project}`);
    await ctx.close();
    process.exit(0);
  } catch (e) {
    const msg = e.message.split('\n')[0].slice(0, 200);
    recordFetchResult(statusKey, { bcStatusFailed: msg });
    console.log(`SET_STATUS_FAILED: ${msg}`);
    // Diagnostics for tuning the selectors against the real BC page:
    // screenshot + the text of every button-ish control currently visible.
    try {
      await page.screenshot({ path: join(ROOT, 'data/bc-status-fail.png') });
      const texts = await page.locator('button, [role=button], [role=combobox], [role=menuitem], [role=option]').allTextContents();
      console.log('PAGE URL:', page.url());
      console.log('VISIBLE CONTROLS:', JSON.stringify([...new Set(texts.map(t => t.trim()).filter(Boolean))].slice(0, 80)));
      console.log('Screenshot saved to data/bc-status-fail.png');
    } catch {}
    await ctx.close();
    process.exit(1);
  }
}

let ok = 0, failed = 0;
for (const [key, bid] of targets) {
  process.stdout.write(`  ${bid.project} ... `);
  try {
    const files = await fetchPlans(key, bid);
    recordFetchResult(key, { plansFetchedAt: new Date().toISOString() });
    console.log(`${files.length} file(s)`);
    ok++;
  } catch (e) {
    const msg = e.message.split('\n')[0].slice(0, 200);
    recordFetchResult(key, { plansFetchFailed: msg });
    console.log(`FAILED: ${msg}`);
    failed++;
  }
  await page.waitForTimeout(1500 + Math.random() * 2000);
}

await ctx.close();
console.log(`\nDone: ${ok} fetched, ${failed} failed.`);
if (failed) console.log('Failed bids are marked plansFetchFailed in data/bids.json (cleared on retry with --key).');
