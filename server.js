#!/usr/bin/env node
// EpoxyCreations Estimator dashboard — local web app over data/bids.json
// and the pricing engine. Usage: npm run dashboard  (http://localhost:8788)

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { computeQuote } from './pricing/quote.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = 8788;
const BIDS = join(ROOT, 'data/bids.json');
const RULES = parse(readFileSync(join(ROOT, 'pricing/rules.yaml'), 'utf8'));

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
    if (url.pathname.startsWith('/api/bids/') && req.method === 'POST') {
      const key = decodeURIComponent(url.pathname.slice('/api/bids/'.length));
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
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Estimator dashboard: http://localhost:${PORT}`));
