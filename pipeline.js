#!/usr/bin/env node
// One-command pipeline: email intake → plan download → AI takeoff → draft
// quote. After a run, bids sit in the dashboard priced and ready for
// approve / tweak / send. Usage:
//
//   npm run pipeline              # full run (browser window may open once)
//   npm run pipeline -- --no-browser   # skip the plan-download step

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTakeoff, listPlans } from './takeoff/run.js';
import { computeQuote } from './pricing/quote.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIDS = join(ROOT, 'data/bids.json');
const PLANS = join(ROOT, 'data/plans');
const CLOSED = new Set(['won', 'lost', 'declined', 'archived', 'sent']);
const noBrowser = process.argv.includes('--no-browser');

function step(title) { console.log(`\n=== ${title} ===`); }
const loadBids = () => JSON.parse(readFileSync(BIDS, 'utf8'));
const saveBids = b => writeFileSync(BIDS, JSON.stringify(b, null, 2));

// 1. Email intake
step('1/4 Email intake');
const intake = spawnSync('node', ['intake/email.js'], { cwd: ROOT, stdio: 'inherit' });
if (intake.status !== 0) console.log('(email intake failed — continuing with existing bids)');

// 2. Plan download (attended-capable browser step)
step('2/4 Plan download from BuildingConnected');
if (noBrowser) {
  console.log('skipped (--no-browser)');
} else {
  spawnSync('node', ['intake/browser.js'], { cwd: ROOT, stdio: 'inherit' });
}

// 3. AI takeoff for bids that have plans but no AI takeoff yet
step('3/4 AI takeoffs');
{
  const bids = loadBids();
  const todo = Object.entries(bids).filter(([key, b]) => {
    if (CLOSED.has(b.status) || b.aiTakeoff) return false;
    return listPlans(PLANS, key).files.length > 0;
  });
  if (!todo.length) console.log('nothing to run');
  for (const [key, b] of todo) {
    process.stdout.write(`  ${b.project} ... `);
    try {
      const result = await runTakeoff(b, listPlans(PLANS, key).dir);
      const fresh = loadBids();
      fresh[key].aiTakeoff = result;
      if (result.system) {
        fresh[key].takeoff = { system: result.system, sqft: result.sqft, coveLf: result.coveLf, prep: result.prep };
      }
      saveBids(fresh);
      console.log(`${result.system ?? 'no scope'} / ${result.sqft} sqft (${result.confidence})`);
    } catch (e) {
      console.log(`FAILED: ${e.message.split('\n')[0]}`);
    }
  }
}

// 4. Draft quotes for bids with a takeoff but no quote yet
step('4/4 Draft quotes');
{
  const bids = loadBids();
  let drafted = 0;
  for (const [, b] of Object.entries(bids)) {
    if (CLOSED.has(b.status)) continue;
    const t = b.takeoff;
    if (!t?.system || !t?.sqft) continue;
    if (!b.quote) {
      const q = computeQuote({ system: t.system, sqft: t.sqft, coveLf: t.coveLf ?? 0, prep: t.prep ?? [] });
      b.quote = { total: q.total, draftedAt: new Date().toISOString() };
      drafted++;
    }
    if (b.status === 'new' || b.status === 'takeoff') b.status = 'quote';
  }
  saveBids(bids);
  console.log(drafted ? `${drafted} quote(s) drafted` : 'nothing to draft');
}

// Summary
const bids = loadBids();
const ready = Object.values(bids).filter(b => b.status === 'quote');
console.log('\n=== Ready for your review ===');
for (const b of ready) {
  console.log(`  • ${b.project}  →  $${(b.quote?.total ?? 0).toLocaleString()}  (due ${b.due ?? '?'})`);
}
if (!ready.length) console.log('  (none — check dashboard for bids needing plans or takeoffs)');
console.log('\nOpen http://localhost:8788 to approve / tweak / send.');
