// AI takeoff: runs headless Claude over the plan PDFs attached to a bid
// (data/plans/<slug>/) and returns a structured takeoff draft for human
// review. Uses the local `claude` CLI (Claude Code auth) — no API key.

import { execFile } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const planSlug = key => key.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

export function listPlans(plansRoot, key) {
  const dir = join(plansRoot, planSlug(key));
  if (!existsSync(dir)) return { dir, files: [] };
  const files = readdirSync(dir).filter(f => /\.(pdf|png|jpe?g)$/i.test(f));
  return { dir, files };
}

const SCHEMA = `{
  "executive_summary": "<MAX 2 short sentences: building type + city, GC, what the overall project is. Telegraphic, no filler.>",
  "scope": "<ONE terse line, our scope only. Format: '<system> ~<SF> SF (<rooms/finish codes>)' — join multiple systems with ' + '. Example: 'Sealed concrete ~1,596 SF (7 rooms, FC-2) + slip-resistant epoxy 497 SF (chem storage 109)'>",
  "not_our_scope": "<ONE terse line of what in this bid is NOT our trade. Example: 'LVT in exam/treatment rooms (flooring sub), rubber base, paint'>",
  "items": [
    {
      "system": "<one of: epoxy_flake | quartz | urethane_cement | solid_color_epoxy | polished_concrete | sealed_concrete>",
      "sqft": <number>,
      "area_note": "<MAX 10 words: which rooms/finish codes this covers>"
    }
    // ONE ENTRY PER DISTINCT SYSTEM in our scope. A bid with sealed concrete
    // in some rooms and epoxy in others = TWO items. Empty array if none.
  ],
  "coveLf": <number, linear feet of integral cove base in our scope, 0 if none/unknown>,
  "prep": [<any of: "heavy_corrective_grinding", "shot_blasting", "coating_glue_removal" — ONLY if the documents put that work in the flooring contractor's scope, not the GC/demo contractor's>],
  "confidence": "<high|medium|low>",
  "judgment_calls": [<strings, MAX 12 words each, imperative: things a human must verify before bidding. Example: 'Confirm FC-2/FC-5 split in rooms 111 & 114 (no dimensions)'>],
  "opportunities": [<strings, MAX 12 words each: adjacent scope we could also bid>]
}
Style: telegraphic and specific. Sheet/room/spec references allowed. No sentences explaining your method, no hedging language, no repetition.`;

function buildPrompt(bid) {
  return `You are a construction estimator for EpoxyCreations LLC, a commercial epoxy/resinous flooring and polished/sealed concrete subcontractor in Florida. Analyze the construction documents (PDFs) in the current directory for this bid invitation and produce a quantity takeoff of OUR trade scope only.

Bid context:
- Project: ${bid.project ?? 'unknown'}
- GC/client: ${bid.client ?? 'unknown'}
- Invited trade: ${bid.trade ?? 'unknown'}
- Location: ${bid.location ?? 'unknown'}

Our trade covers: decorative flake epoxy, quartz broadcast, urethane cement, solid-color high-build epoxy, polished concrete, sealed/densified concrete (grind & seal), integral cove base, and fluid-applied resinous flooring (quote as urethane cement). NOT our trade: tile, LVT/resilient flooring, carpet, wood, paint (except epoxy/polysiloxane coating systems).

Method:
1. List the PDFs (Glob). Start with the smallest/most-likely-architectural set.
2. In large combined sets, find the sheet index on the cover, then read ONLY the relevant sheets: finish plan + finish schedule (usually A-1xx), demolition notes (D-1xx), and the code/floor plan sheet with room areas. PDFs over 10 pages must be read with the pages parameter (max 20 pages per call) — read targeted small ranges, not the whole set.
3. From the finish schedule, identify which floor finish codes are resinous/sealed/polished concrete systems (read their spec descriptions — e.g. epoxy, urethane, sealer, densifier product names) vs other trades.
4. Sum the floor areas of rooms specced with OUR finish codes. Use room areas from plans where stated; flag any you had to estimate. If our scope contains MORE THAN ONE distinct system (e.g. sealed concrete in some rooms, epoxy in others), report each as its own entry in "items" with its own sq ft — never blend different systems into one number.
5. Check demolition general notes for whether existing flooring removal/grinding is by the GC/demo contractor or left to the flooring contractor.

Return ONLY a JSON object exactly matching this schema (no prose, no code fences):
${SCHEMA}`;
}

export function runTakeoff(bid, plansDir, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', buildPrompt(bid), '--allowedTools', 'Read,Glob', '--output-format', 'json'],
      { cwd: plansDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error(`takeoff agent failed: ${err.message}`));
        try {
          const envelope = JSON.parse(stdout.trim().split('\n').pop());
          if (envelope.is_error) return reject(new Error(`takeoff agent error: ${envelope.result}`));
          let text = (envelope.result ?? '').trim();
          const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenced) text = fenced[1].trim();
          const start = text.indexOf('{');
          const end = text.lastIndexOf('}');
          if (start < 0 || end < 0) return reject(new Error(`takeoff agent returned no JSON: ${text.slice(0, 300)}`));
          const parsed = JSON.parse(text.slice(start, end + 1));
          const items = (Array.isArray(parsed.items) ? parsed.items : [])
            .filter(it => it?.system && it.system !== 'none' && Number(it.sqft) > 0)
            .map(it => ({ system: it.system, sqft: Number(it.sqft), areaNote: it.area_note ?? '' }));
          // Legacy single-system fallback for older prompt outputs.
          if (!items.length && parsed.system && parsed.system !== 'none' && Number(parsed.sqft) > 0) {
            items.push({ system: parsed.system, sqft: Number(parsed.sqft), areaNote: '' });
          }
          resolve({
            execSummary: parsed.executive_summary ?? '',
            scope: parsed.scope ?? '',
            notScope: parsed.not_our_scope ?? '',
            summary: parsed.summary ?? undefined, // legacy field, absent in new runs
            items,
            system: items[0]?.system ?? null,
            sqft: items.reduce((s, it) => s + it.sqft, 0),
            coveLf: Number(parsed.coveLf) || 0,
            prep: Array.isArray(parsed.prep) ? parsed.prep : [],
            confidence: parsed.confidence ?? 'low',
            summary: parsed.summary ?? '',
            judgmentCalls: parsed.judgment_calls ?? [],
            opportunities: parsed.opportunities ?? [],
            ranAt: new Date().toISOString(),
            costUsd: envelope.total_cost_usd ?? null,
          });
        } catch (e) {
          reject(new Error(`could not parse takeoff output: ${e.message}`));
        }
      }
    );
    child.stdin?.end();
  });
}
