#!/usr/bin/env node
// One-time BuildingConnected API connection: runs the 3-legged OAuth flow,
// saves tokens to tokens.json, and verifies access by listing Bid Board
// opportunities. Requires Node 18+. Usage: node connect.js

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const AUTH_BASE = 'https://developer.api.autodesk.com/authentication/v2';
const BC_BASE = 'https://developer.api.autodesk.com/construction/buildingconnected/v2';
const SCOPES = 'data:read data:write';

function loadEnv() {
  if (!existsSync('.env')) {
    console.error('No .env file found. Copy .env.example to .env and fill in your APS app credentials.');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const key of ['APS_CLIENT_ID', 'APS_CLIENT_SECRET', 'APS_CALLBACK_URL']) {
    if (!env[key]) {
      console.error(`Missing ${key} in .env`);
      process.exit(1);
    }
  }
  return env;
}

async function exchangeToken(env, params) {
  const res = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

function saveTokens(tokens) {
  tokens.obtained_at = new Date().toISOString();
  writeFileSync('tokens.json', JSON.stringify(tokens, null, 2));
  console.log('Tokens saved to tokens.json');
}

async function authorize(env) {
  const state = randomBytes(16).toString('hex');
  const port = new URL(env.APS_CALLBACK_URL).port || 80;

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, env.APS_CALLBACK_URL);
      if (url.pathname !== new URL(env.APS_CALLBACK_URL).pathname) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      if (err) {
        res.end('Authorization failed. You can close this tab.');
        server.close();
        reject(new Error(`Authorization denied: ${err}`));
        return;
      }
      if (url.searchParams.get('state') !== state) {
        res.end('State mismatch. You can close this tab.');
        server.close();
        reject(new Error('OAuth state mismatch'));
        return;
      }
      res.end('Connected! You can close this tab and return to the terminal.');
      server.close();
      resolve(url.searchParams.get('code'));
    });
    server.listen(port, () => {
      const authUrl =
        `${AUTH_BASE}/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(env.APS_CLIENT_ID)}` +
        `&redirect_uri=${encodeURIComponent(env.APS_CALLBACK_URL)}` +
        `&scope=${encodeURIComponent(SCOPES)}` +
        `&state=${state}`;
      console.log('\nOpening Autodesk sign-in in your browser...');
      console.log('If it does not open, paste this URL into your browser:\n\n' + authUrl + '\n');
      execFile('open', [authUrl], () => {});
    });
  });

  return exchangeToken(env, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.APS_CALLBACK_URL,
  });
}

async function refreshIfPossible(env) {
  if (!existsSync('tokens.json')) return null;
  const saved = JSON.parse(readFileSync('tokens.json', 'utf8'));
  if (!saved.refresh_token) return null;
  try {
    console.log('Found existing tokens.json — refreshing...');
    return await exchangeToken(env, {
      grant_type: 'refresh_token',
      refresh_token: saved.refresh_token,
      scope: SCOPES,
    });
  } catch {
    console.log('Refresh failed; starting a fresh sign-in.');
    return null;
  }
}

async function verify(tokens) {
  console.log('\nVerifying access — fetching your Bid Board opportunities...');
  const res = await fetch(`${BC_BASE}/opportunities?limit=10`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) throw new Error(`Opportunities request failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const items = data.results ?? data.data ?? [];
  console.log(`\nSuccess — API returned ${items.length} opportunit${items.length === 1 ? 'y' : 'ies'}:`);
  for (const o of items) {
    const due = o.dueAt ?? o.dueDate ?? 'no due date';
    console.log(`  - ${o.name ?? o.title ?? o.id}  (due ${due})`);
  }
  if (items.length === 0) {
    console.log('  (empty list — check that this Autodesk account is the one linked to your BuildingConnected Bid Board)');
  }
}

const env = loadEnv();
let tokens = await refreshIfPossible(env);
if (!tokens) tokens = await authorize(env);
saveTokens(tokens);
await verify(tokens);
console.log('\nConnection is set up. tokens.json will be reused by the app.');
