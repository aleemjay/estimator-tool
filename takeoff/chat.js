// Per-bid Q&A: headless Claude answers AJ's questions about a bid using the
// bid record, the pricing rules, and (when attached) the bid's plan PDFs.
// Same engine as the takeoff: local `claude` CLI, Claude Code auth, no API key.

import { execFile } from 'node:child_process';

function buildPrompt({ bid, rulesYaml, hasPlans, history, question }) {
  // chatLog is stored on the bid; strip it so the transcript isn't doubled.
  const { chatLog, ...bidForPrompt } = bid;
  const transcript = (history ?? []).slice(-12)
    .map(m => `${m.role === 'user' ? 'AJ' : 'Assistant'}: ${m.text}`).join('\n\n');

  return `You are the estimating assistant for EpoxyCreations LLC, a commercial epoxy/resinous flooring and polished/sealed concrete subcontractor in Florida. AJ (the owner) is asking about one specific bid. Answer his question directly.

Resources available to you:
- The bid record (JSON, below): intake data, takeoff, quote, notes, AI takeoff summary.
- The company rate card / pricing rules (YAML, below).
- ${hasPlans
    ? 'The bid\'s plan PDFs are in the current directory. Use Glob to list them and Read to open them when the question needs document details. PDFs over 10 pages must be read with the pages parameter (max 20 pages per call) — read targeted small ranges, not whole sets.'
    : 'No plan PDFs are attached to this bid — say so if the question needs them.'}

Rules: be terse and specific. Cite sheet/room/spec references when you pull facts from documents. If you compute a price, use the rate card and show the arithmetic in one line. If something is not in the record or the documents, say so plainly — never invent quantities or scope.

Bid record:
${JSON.stringify(bidForPrompt, null, 1)}

Rate card / pricing rules:
${rulesYaml}

${transcript ? `Conversation so far:\n${transcript}\n\n` : ''}AJ's question: ${question}`;
}

export function askBid(args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', buildPrompt(args), '--allowedTools', 'Read,Glob', '--output-format', 'json'],
      { cwd: args.plansDir, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: process.env },
      (err, stdout) => {
        if (err && !stdout) return reject(new Error(`chat agent failed: ${err.message}`));
        try {
          const envelope = JSON.parse(stdout.trim().split('\n').pop());
          if (envelope.is_error) return reject(new Error(`chat agent error: ${envelope.result}`));
          const text = (envelope.result ?? '').trim();
          if (!text) return reject(new Error('chat agent returned an empty answer'));
          resolve({ text, costUsd: envelope.total_cost_usd ?? null });
        } catch (e) {
          reject(new Error(`could not parse chat output: ${e.message}`));
        }
      }
    );
    child.stdin?.end();
  });
}
