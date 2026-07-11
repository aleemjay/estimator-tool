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
  "executive_summary": "<2-4 sentences for the business owner: what the building/project is and where, who the GC is, the overall construction scope, any schedule/bid requirements stated, and where our trade fits in the job>",
  "system": "<one of: epoxy_flake | quartz | urethane_cement | solid_color_epoxy | polished_concrete | sealed_concrete | none>",
  "sqft": <number, total sq ft of OUR scope (resinous/sealed/polished concrete flooring); 0 if none>,
  "coveLf": <number, linear feet of integral cove base in our scope, 0 if none/unknown>,
  "prep": [<any of: "heavy_corrective_grinding", "shot_blasting", "coating_glue_removal" — ONLY if the documents put that work in the flooring contractor's scope, not the GC/demo contractor's>],
  "confidence": "<high|medium|low>",
  "summary": "<3-6 sentences: what the project is, what our actual scope is (rooms, finish codes, spec products), what is NOT our trade, and how you derived the sq ft>",
  "judgment_calls": [<strings: each thing a human must verify — scope boundaries, area measurements you could not confirm, ambiguous spec language, work that might be by others>],
  "opportunities": [<strings: adjacent scope we could also bid, e.g. epoxy/resinous WALL systems, joint fill, additional rooms specced for coatings>]
}`;

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
4. Sum the floor areas of rooms specced with OUR finish codes. Use room areas from plans where stated; flag any you had to estimate.
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
          resolve({
            execSummary: parsed.executive_summary ?? '',
            system: parsed.system === 'none' ? null : parsed.system,
            sqft: Number(parsed.sqft) || 0,
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
