#!/usr/bin/env node
// EpoxyCreations Estimator dashboard — local web app over data/bids.json
// and the pricing engine. Usage: npm run dashboard  (http://localhost:8788)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { parse } from 'yaml';
import { computeQuote } from './pricing/quote.js';
import { runTakeoff, listPlans, planSlug } from './takeoff/run.js';
import { generateProposal, nextEstimateNumber } from './proposal/generate.js';
import { startSendAuth, pollSendAuth, sendAuthReady, sendProposal } from './proposal/send.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const BIDS = join(ROOT, 'data/bids.json');
const PLANS = join(ROOT, 'data/plans');
const RULES = parse(readFileSync(join(ROOT, 'pricing/rules.yaml'), 'utf8'));
const takeoffRuns = new Map(); // bidKey -> {status:'running'|'done'|'error', error?}
const fetchRuns = new Map(); // bidKey -> same shape

function startTakeoffRun(key) {
  const bids = loadBids();
  const { dir, files } = listPlans(PLANS, key);
  if (!files.length || takeoffRuns.get(key)?.status === 'running') return false;
  takeoffRuns.set(key, { status: 'running', startedAt: Date.now() });
  runTakeoff(bids[key], dir)
    .then(result => {
      const fresh = loadBids();
      fresh[key].aiTakeoff = result;
      if (result.system) {
        fresh[key].takeoff = { system: result.system, sqft: result.sqft, coveLf: result.coveLf, prep: result.prep };
        const q = computeQuote({ system: result.system, sqft: result.sqft, coveLf: result.coveLf, prep: result.prep });
        fresh[key].quote = { total: q.total, draftedAt: new Date().toISOString() };
        if (fresh[key].status === 'new' || fresh[key].status === 'takeoff') fresh[key].status = 'quote';
      } else if (fresh[key].status === 'new') {
        fresh[key].status = 'takeoff';
      }
      saveBids(fresh);
      takeoffRuns.set(key, { status: 'done' });
    })
    .catch(e => takeoffRuns.set(key, { status: 'error', error: e.message }));
  return true;
}

const loadBids = () => (existsSync(BIDS) ? JSON.parse(readFileSync(BIDS, 'utf8')) : {});
const saveBids = b => writeFileSync(BIDS, JSON.stringify(b, null, 2));

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(readFileSync(join(ROOT, 'public/index.html')));
    }
    if (url.pathname === '/api/bids' && req.method === 'GET') {
      return json(res, 200, loadBids());
    }
    if (url.pathname === '/api/rules' && req.method === 'GET') {
      return json(res, 200, {
        systems: Object.fromEntries(Object.entries(RULES.systems).map(([k, v]) => [k, v.label])),
        prep: Object.fromEntries(
          Object.entries(RULES.prep)
            .filter(([, v]) => v.billing === 'separate_line_item')
            .map(([k, v]) => [k, v.label])
        ),
      });
    }
    const patchMatch = url.pathname.match(/^\/api\/bids\/([^/]+)$/);
    if (patchMatch && req.method === 'POST') {
      const key = decodeURIComponent(patchMatch[1]);
      const bids = loadBids();
      if (!bids[key]) return json(res, 404, { error: 'unknown bid' });
      const patch = await readBody(req);
      // Only fields the UI owns — never let a patch clobber intake data.
      for (const f of ['status', 'notes', 'takeoff', 'quote']) {
        if (f in patch) bids[key][f] = patch[f];
      }
      saveBids(bids);
      return json(res, 200, bids[key]);
    }
    if (url.pathname === '/api/quote' && req.method === 'POST') {
      const { system, sqft, coveLf, prep } = await readBody(req);
      return json(res, 200, computeQuote({ system, sqft: Number(sqft) || 0, coveLf: Number(coveLf) || 0, prep: prep ?? [] }));
    }

    // --- plans + AI takeoff ---
    const takeoffMatch = url.pathname.match(/^\/api\/bids\/([^/]+)\/(plans|takeoff|takeoff-status|fetch-plans|fetch-status)$/);
    if (takeoffMatch) {
      const key = decodeURIComponent(takeoffMatch[1]);
      const action = takeoffMatch[2];
      const bids = loadBids();
      if (!bids[key]) return json(res, 404, { error: 'unknown bid' });

      if (action === 'plans') {
        const { dir, files } = listPlans(PLANS, key);
        mkdirSync(dir, { recursive: true });
        return json(res, 200, { dir, files });
      }
      if (action === 'takeoff-status') {
        return json(res, 200, takeoffRuns.get(key) ?? { status: 'idle' });
      }
      if (action === 'fetch-status') {
        return json(res, 200, fetchRuns.get(key) ?? { status: 'idle' });
      }
      if (action === 'takeoff' && req.method === 'POST') {
        const { dir, files } = listPlans(PLANS, key);
        if (!files.length) return json(res, 400, { error: `No plan files. Drop PDFs into: ${dir}` });
        if (!startTakeoffRun(key)) return json(res, 409, { error: 'takeoff already running' });
        return json(res, 202, { status: 'running' });
      }
      if (action === 'fetch-plans' && req.method === 'POST') {
        if (fetchRuns.get(key)?.status === 'running') return json(res, 409, { error: 'fetch already running' });
        if (!bids[key].rfpId && !bids[key].link) return json(res, 400, { error: 'bid has no BuildingConnected link' });
        fetchRuns.set(key, { status: 'running', startedAt: Date.now() });
        let out = '';
        const child = spawn('node', ['intake/browser.js', '--key', key], { cwd: ROOT });
        child.stdout.on('data', d => (out += d));
        child.stderr.on('data', d => (out += d));
        child.on('exit', () => {
          const { files } = listPlans(PLANS, key);
          if (files.length) {
            fetchRuns.set(key, { status: 'done' });
            startTakeoffRun(key); // chain: plans -> takeoff -> quote, fully automatic
          } else {
            const lines = out.split('\n').map(s => s.trim()).filter(Boolean);
            const meaningful = lines.find(l => /LOGIN_TIMEOUT|FAILED|Error|Timeout/i.test(l)) ?? lines.pop() ?? 'no files downloaded';
            fetchRuns.set(key, { status: 'error', error: meaningful.slice(0, 250) });
          }
        });
        return json(res, 202, { status: 'running' });
      }
    }

    // --- proposal generation + download ---
    const propMatch = url.pathname.match(/^\/api\/bids\/([^/]+)\/proposal$/);
    if (propMatch && req.method === 'POST') {
      const key = decodeURIComponent(propMatch[1]);
      const bids = loadBids();
      const bid = bids[key];
      if (!bid) return json(res, 404, { error: 'unknown bid' });
      const t = bid.takeoff;
      if (!t?.system || !t?.sqft) return json(res, 400, { error: 'save a takeoff (system + sqft) first' });
      const quote = computeQuote({ system: t.system, sqft: t.sqft, coveLf: t.coveLf ?? 0, prep: t.prep ?? [] });
      const estimateNo = bid.estimateNo ?? nextEstimateNumber();
      const file = generateProposal(bid, quote, t, estimateNo);
      bid.estimateNo = estimateNo;
      bid.proposalFile = basename(file);
      bid.quote = { total: quote.total, generatedAt: new Date().toISOString() };
      saveBids(bids);
      return json(res, 200, { file: `/proposals/${basename(file)}`, estimateNo, total: quote.total });
    }
    if (url.pathname.startsWith('/proposals/') && req.method === 'GET') {
      const file = join(ROOT, 'proposals', basename(url.pathname));
      if (!existsSync(file)) return json(res, 404, { error: 'no such proposal' });
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${basename(file)}"` });
      return res.end(readFileSync(file));
    }

    // --- send flow ---
    if (url.pathname === '/api/send-auth' && req.method === 'GET') {
      return json(res, 200, { ready: sendAuthReady() });
    }
    if (url.pathname === '/api/send-auth/start' && req.method === 'POST') {
      return json(res, 200, await startSendAuth());
    }
    if (url.pathname === '/api/send-auth/poll' && req.method === 'POST') {
      const { deviceCode } = await readBody(req);
      return json(res, 200, await pollSendAuth(deviceCode));
    }
    const sendMatch = url.pathname.match(/^\/api\/bids\/([^/]+)\/send$/);
    if (sendMatch && req.method === 'POST') {
      const key = decodeURIComponent(sendMatch[1]);
      const bids = loadBids();
      const bid = bids[key];
      if (!bid) return json(res, 404, { error: 'unknown bid' });
      if (!bid.proposalFile) return json(res, 400, { error: 'generate the proposal first' });
      const { to, subject, body } = await readBody(req);
      if (!to) return json(res, 400, { error: 'no recipient' });
      try {
        await sendProposal({ to, subject, bodyText: body, pdfPath: join(ROOT, 'proposals', bid.proposalFile) });
        bid.status = 'sent';
        bid.sentAt = new Date().toISOString();
        bid.sentTo = to;
        saveBids(bids);
        return json(res, 200, { sent: true });
      } catch (e) {
        return json(res, e.code === 'NO_AUTH' ? 401 : e.code === 'NO_PERMISSION' ? 403 : 500, { error: e.message, code: e.code ?? null });
      }
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Estimator dashboard: http://localhost:${PORT}`));
