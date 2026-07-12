#!/usr/bin/env node
// Quote engine: applies pricing/rules.yaml to a takeoff and returns line
// items + total. Also usable as a CLI:
//
//   node pricing/quote.js --system epoxy_flake --sqft 2400 --cove-lf 180
//   node pricing/quote.js --system urethane_cement --sqft 3300 \
//     --prep shot_blasting --prep coating_glue_removal

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RULES = parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'rules.yaml'), 'utf8'));

function tierRate(tiers, qty) {
  let rate = tiers[0].rate;
  for (const t of tiers) if (qty >= t.min) rate = t.rate;
  return rate;
}

export function computeQuote({ system, sqft, coveLf = 0, prep = [] }) {
  const sys = RULES.systems[system];
  if (!sys) throw new Error(`Unknown system "${system}". Options: ${Object.keys(RULES.systems).join(', ')}`);

  const lines = [];
  const rate = tierRate(sys.tiers, sqft);
  lines.push({ label: `${sys.label} — ${sqft.toLocaleString()} sq ft @ $${rate.toFixed(2)}`, amount: sqft * rate, kind: 'system', key: system });

  if (coveLf > 0) {
    const cb = RULES.line_items.cove_base;
    const cbRate = tierRate(cb.tiers, coveLf);
    lines.push({ label: `${cb.label} — ${coveLf.toLocaleString()} LF @ $${cbRate.toFixed(2)}`, amount: coveLf * cbRate, kind: 'cove', key: 'cove_base' });
  }

  const notes = [];
  for (const p of prep) {
    const item = RULES.prep[p];
    if (!item) throw new Error(`Unknown prep item "${p}". Options: ${Object.keys(RULES.prep).join(', ')}`);
    if (item.billing === 'included_in_base' || item.billing === 'excluded_by_default') continue;
    const pRate = item.draft_rate ?? item.rate;
    lines.push({ label: `${item.label} — ${sqft.toLocaleString()} sq ft @ $${pRate.toFixed(2)}`, amount: sqft * pRate, kind: 'prep', key: p });
  }

  let subtotal = lines.reduce((s, l) => s + l.amount, 0);
  let floored = false;
  if (subtotal < RULES.job_rules.minimum_contract) {
    subtotal = RULES.job_rules.minimum_contract;
    floored = true;
  }
  const nearest = RULES.presentation.round_total_to_nearest;
  const total = Math.max(
    Math.round(subtotal / nearest) * nearest,
    RULES.job_rules.minimum_contract
  );

  return {
    lines,
    subtotal,
    floored,
    total,
    notes,
    validityDays: RULES.presentation.quote_validity_days,
  };
}

// --- CLI ---
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const prep = [];
  args.forEach((a, i) => { if (a === '--prep') prep.push(args[i + 1]); });

  const q = computeQuote({
    system: get('--system'),
    sqft: Number(get('--sqft') ?? 0),
    coveLf: Number(get('--cove-lf') ?? 0),
    prep,
  });

  for (const l of q.lines) console.log(`  ${l.label.padEnd(64)} $${l.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`);
  if (q.floored) console.log(`  (raised to job minimum $${RULES.job_rules.minimum_contract.toLocaleString()})`);
  console.log(`  ${'TOTAL (rounded to nearest $' + RULES.presentation.round_total_to_nearest + ')'.padEnd(62)} $${q.total.toLocaleString()}`);
  console.log(`\n  Valid ${q.validityDays} days. Notes:`);
  for (const n of q.notes) console.log(`   - ${n}`);
}
