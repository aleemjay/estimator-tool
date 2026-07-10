#!/usr/bin/env node
// Email intake (Outlook / Microsoft 365 via Microsoft Graph): scans the
// mailbox for BuildingConnected notification emails and records each bid
// invite in data/bids.json. Safe to re-run — already-seen messages skipped.
//
// One-time sign-in uses the device-code flow: the script prints a URL and
// a short code; open the URL, enter the code, sign in as the mailbox owner.
// Tokens are saved to ms-tokens.json (gitignored) and refresh automatically.
//
// Usage:
//   node intake/email.js            # scan the last 30 days
//   node intake/email.js --days 90  # scan further back
//   node intake/email.js --dump     # also save raw bodies to data/raw/

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DAYS = process.argv.includes('--days')
  ? Number(process.argv[process.argv.indexOf('--days') + 1])
  : 30;
const DUMP = process.argv.includes('--dump');
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Mail.Read offline_access';

function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.MS_CLIENT_ID) {
    console.error(
      'Missing MS_CLIENT_ID in .env (from the Entra app registration).\n' +
      'See README "Email intake setup". MS_TENANT_ID is optional (defaults to organizations).'
    );
    process.exit(1);
  }
  env.MS_TENANT_ID ||= 'organizations';
  return env;
}

async function deviceCodeSignIn(env) {
  const base = `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0`;
  let res = await fetch(`${base}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, scope: SCOPES }),
  });
  if (!res.ok) throw new Error(`Device code request failed (${res.status}): ${await res.text()}`);
  const dc = await res.json();
  console.log('\n' + dc.message + '\n'); // "To sign in, use a web browser to open ... and enter the code ..."

  const deadline = Date.now() + dc.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (dc.interval ?? 5) * 1000));
    res = await fetch(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: env.MS_CLIENT_ID,
        device_code: dc.device_code,
      }),
    });
    const body = await res.json();
    if (res.ok) return body;
    if (body.error !== 'authorization_pending' && body.error !== 'slow_down') {
      throw new Error(`Sign-in failed: ${body.error} — ${body.error_description}`);
    }
  }
  throw new Error('Device code expired before sign-in completed.');
}

async function getToken(env) {
  if (existsSync('ms-tokens.json')) {
    const saved = JSON.parse(readFileSync('ms-tokens.json', 'utf8'));
    if (saved.refresh_token) {
      const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: env.MS_CLIENT_ID,
          refresh_token: saved.refresh_token,
          scope: SCOPES,
        }),
      });
      if (res.ok) {
        const tokens = await res.json();
        writeFileSync('ms-tokens.json', JSON.stringify(tokens, null, 2));
        return tokens;
      }
      console.log('Token refresh failed; starting a fresh sign-in.');
    }
  }
  const tokens = await deviceCodeSignIn(env);
  writeFileSync('ms-tokens.json', JSON.stringify(tokens, null, 2));
  console.log('Signed in; tokens saved to ms-tokens.json');
  return tokens;
}

function loadBids() {
  return existsSync('data/bids.json') ? JSON.parse(readFileSync('data/bids.json', 'utf8')) : {};
}

function saveBids(bids) {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/bids.json', JSON.stringify(bids, null, 2));
}

function htmlToText(html) {
  return (html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}

// Extract what we can from a BuildingConnected notification email. Tuned
// against real samples via --dump; unparsed fields stay null and get filled
// in manually (or later via the API).
function parseInvite(subject, text) {
  let project = null, client = null;
  let m =
    subject.match(/invited (?:you )?to bid on (.+?)(?: by (.+))?$/i) ??
    subject.match(/bid invite[:\s]+(.+)$/i);
  if (m) {
    project = m[1]?.trim() ?? null;
    client = m[2]?.trim() ?? null;
  }
  if (!client) {
    const mc = subject.match(/^(?:.+) from (.+?) invited/i) ?? text.match(/\bfrom ([^\n]+?) (?:has )?invited you/i);
    if (mc) client = mc[1].trim();
  }
  const due = text.match(/due(?: date)?[:\s]+([A-Z][a-z]+ \d{1,2},? \d{4}[^\n]*)/i)?.[1]?.trim() ?? null;
  const link = text.match(/https:\/\/app\.buildingconnected\.com[^\s>")]*/)?.[0] ?? null;
  return { project, client, due, link };
}

const env = loadEnv();
const tokens = await getToken(env);
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const bids = loadBids();
let found = 0, added = 0;

let url =
  `${GRAPH}/me/messages?$filter=receivedDateTime ge ${since}` +
  `&$select=id,internetMessageId,subject,from,receivedDateTime,body,webLink&$top=50&$orderby=receivedDateTime desc`;

while (url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!res.ok) throw new Error(`Graph request failed (${res.status}): ${await res.text()}`);
  const page = await res.json();
  for (const msg of page.value ?? []) {
    const sender = msg.from?.emailAddress?.address ?? '';
    if (!/buildingconnected\.com$/i.test(sender)) continue;
    found++;
    const id = msg.internetMessageId ?? msg.id;
    const text = htmlToText(msg.body?.content);
    if (DUMP) {
      mkdirSync('data/raw', { recursive: true });
      const safe = id.replace(/[^a-z0-9]/gi, '_').slice(0, 80);
      writeFileSync(`data/raw/${safe}.txt`, `SUBJECT: ${msg.subject}\nFROM: ${sender}\nDATE: ${msg.receivedDateTime}\n\n${text}`);
    }
    if (bids[id]) continue;
    const parsed = parseInvite(msg.subject ?? '', text);
    bids[id] = {
      source: 'email',
      receivedAt: msg.receivedDateTime ?? null,
      subject: msg.subject ?? null,
      ...parsed,
      status: 'new',
      files: [],
    };
    added++;
    console.log(`  + ${parsed.project ?? msg.subject}`);
  }
  url = page['@odata.nextLink'] ?? null;
}

saveBids(bids);
console.log(`\nFound ${found} BuildingConnected email(s) in the last ${DAYS} days; ${added} new bid record(s) in data/bids.json.`);
if (DUMP) console.log('Raw copies saved to data/raw/ for parser tuning.');
