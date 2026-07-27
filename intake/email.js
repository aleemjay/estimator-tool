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
import { GRAPH, loadEnv, getToken, htmlToText } from './graph.js';
import { loadDirectSenders, directClient } from './direct.js';

const DAYS = process.argv.includes('--days')
  ? Number(process.argv[process.argv.indexOf('--days') + 1])
  : 30;
const DUMP = process.argv.includes('--dump');

function loadBids() {
  return existsSync('data/bids.json') ? JSON.parse(readFileSync('data/bids.json', 'utf8')) : {};
}

function saveBids(bids) {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/bids.json', JSON.stringify(bids, null, 2));
}

// Extract what we can from a BuildingConnected notification email. Tuned
// against real samples via --dump; unparsed fields stay null and get filled
// in manually (or later via the API).
function classify(subject) {
  const s = subject.toLowerCase();
  if (/bid invite|invitation to bid|invited you|bid invitation/.test(s)) return 'invite';
  if (/addendum|add#\d|revised|updated documents|plans|specs|drawings|site plans|scopes of work|rfi|responses|photos|plan pages|bid tabulation/.test(s)) return 'documents';
  if (/reminder|due today|due tomorrow|extension/.test(s)) return 'reminder';
  if (/new message|questions|site walk|notice to/.test(s)) return 'message';
  return 'other';
}

function parseFields(subject, text, html) {
  // Body line: "<lead> from <GC> has invited you to bid on\n<project>[: <trade>]"
  const invited = text.match(/(.+?) from (.+?) has invited you to bid on\s*\n+\s*(.+)/i);
  let lead = invited?.[1]?.trim() ?? null;
  let client = invited?.[2]?.trim() ?? null;
  let project = invited?.[3]?.trim() ?? null;
  let trade = null;
  const pt = project?.match(/^(.*?):\s*([^:]+)$/);
  if (pt) {
    project = pt[1].trim();
    trade = pt[2].trim();
  }
  const location = text.match(/Location:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
  const due = text.match(/Bid Due:\s*([^\n]+)/i)?.[1]?.trim()
    ?? text.match(/due(?: date)?[:\s]+([A-Z][a-z]+ \d{1,2},? \d{4}[^\n]*)/i)?.[1]?.trim() ?? null;
  const contactEmail = text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i)?.[0] ?? null;
  const contactPhone = text.match(/\+1[\s\d()-]{10,}/)?.[0]?.trim() ?? null;

  // Every notification links to the RFP (https://app.buildingconnected.com/
  // rfps/<24-hex>/bid) — the stable per-project key for grouping.
  const links = [...(html ?? '').matchAll(/https:\/\/app\.buildingconnected\.com[^\s"'<>)]*/g)].map(m => m[0]);
  const rfpId = links.map(l => l.match(/rfps\/([a-f0-9]{24})/i)?.[1]).find(Boolean) ?? null;
  const link = links.find(l => /rfps\/[a-f0-9]{24}/i.test(l)) ?? links[0] ?? null;

  return { project, trade, client, lead, location, due, contactEmail, contactPhone, rfpId, link };
}

// Notification boilerplate words that carry no project identity.
const STOP = new Set(
  ('bid bids invite invitation invited reminder due today tomorrow extension addendum add revised updated ' +
   'documents document plans specs drawings sheets pages plan spec site walk scheduled scopes scope work posted ' +
   'notice bidders quotes questions answers rfi rfis response responses attached plus photos existing conditions ' +
   'tabulation civil message project rfp geo soils reports date dates night awarded manual monday tuesday ' +
   'wednesday thursday friday all recd doc addit').split(' ')
);

function nameTokens(s) {
  return new Set(
    (s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9.]+/g, ' ')
      .split(/\s+/)
      .map(t => t.replace(/^\.+|\.+$/g, ''))
      .filter(t => t && !STOP.has(t))
      // drop dates/times like 7/15/26, 06, 2026, 11:30am
      .filter(t => !/^\d{1,4}$/.test(t) || t.length === 4 && Number(t) > 2100 || (t.length >= 3 && t.length <= 4 && Number(t) < 2020))
  );
}

// Truncation-tolerant similarity: overlap relative to the smaller token set.
function nameMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (ta.size < 2 || tb.size < 2) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= 2 && overlap / Math.min(ta.size, tb.size) >= 0.6;
}

// Strip notification prefixes when a subject has to serve as a project name.
function cleanSubjectName(s) {
  return (s ?? '')
    .replace(/^[^-–:]*?(reminder|posted|addendum ?#?\d*|add#?\d+|extension|invitation to bid|bid invite|updated documents|revised[^-–:]*|photos of existing conditions|notice to[^-–:]*)[^-–:]*[-–:]\s*/i, '')
    .replace(/\s*\.{3}$/, '')
    .trim() || s;
}

const env = loadEnv();
const tokens = await getToken(env, 'Mail.Read offline_access');
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
const bids = loadBids(); // keyed by opportunity id (or normalized name)
const DIRECT_SENDERS = loadDirectSenders(); // GCs who email invites directly
let found = 0, newEmails = 0, newProjects = 0;

let url =
  `${GRAPH}/me/messages?$filter=receivedDateTime ge ${since}` +
  `&$select=id,internetMessageId,subject,from,receivedDateTime,body,webLink&$top=50&$orderby=receivedDateTime desc`;

const emails = [];
while (url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!res.ok) throw new Error(`Graph request failed (${res.status}): ${await res.text()}`);
  const page = await res.json();
  for (const msg of page.value ?? []) {
    const sender = msg.from?.emailAddress?.address ?? '';
    const direct = directClient(sender, DIRECT_SENDERS);
    if (!/buildingconnected\.com$/i.test(sender) && !direct) continue;
    found++;
    msg._direct = direct; // GC display name when from a direct-GC sender
    msg._sender = sender;
    emails.push(msg);
  }
  url = page['@odata.nextLink'] ?? null;
}

// Oldest first so invites (which carry full details) create projects before
// reminders/addenda attach to them.
emails.sort((a, b) => new Date(a.receivedDateTime) - new Date(b.receivedDateTime));

for (const msg of emails) {
  const html = msg.body?.content ?? '';
  const text = htmlToText(html);
  const emailId = msg.internetMessageId ?? msg.id;
  if (DUMP) {
    mkdirSync('data/raw', { recursive: true });
    const safe = emailId.replace(/[^a-z0-9]/gi, '_').slice(0, 80);
    writeFileSync(`data/raw/${safe}.txt`, `SUBJECT: ${msg.subject}\nFROM: ${msg.from?.emailAddress?.address}\nDATE: ${msg.receivedDateTime}\n\n${text}`);
  }

  const f = parseFields(msg.subject ?? '', text, html);
  const kind = classify(msg.subject ?? '');
  if (msg._direct) {
    // Direct-GC email: the BC body patterns won't parse; the senders map
    // supplies the client, and replies should go to the sender.
    f.client = f.client ?? msg._direct;
    f.contactEmail = msg._sender;
    f.rfpId = null; // never group direct emails by a BC link someone forwarded
  }

  // Find the project this email belongs to: by RFP id (as key or stored
  // field), then by truncation-tolerant name similarity.
  const name = f.project ?? cleanSubjectName(msg.subject);
  let key = f.rfpId
    ? (bids[f.rfpId] ? f.rfpId : Object.keys(bids).find(k => bids[k].rfpId === f.rfpId) ?? null)
    : null;
  if (!key) {
    // Fuzzy name match — but never merge into a bid whose stored RFP id
    // differs from this email's: chain projects (e.g. Walmart Supercenter
    // stores) share nearly every name token and only the rfps/<id> link
    // tells them apart.
    key = Object.keys(bids).find(k =>
      nameMatch(bids[k].project, name) &&
      !(f.rfpId && bids[k].rfpId && bids[k].rfpId !== f.rfpId)
    ) ?? null;
  }

  // Learned the RFP id for a project created before we saw it? Re-key.
  if (key && f.rfpId && key !== f.rfpId && !bids[f.rfpId]) {
    bids[f.rfpId] = bids[key];
    delete bids[key];
    key = f.rfpId;
  }

  if (!key) {
    key = f.rfpId ?? emailId;
    bids[key] = {
      source: msg._direct ? 'email-direct' : 'email',
      project: name,
      trade: f.trade,
      client: f.client,
      lead: f.lead,
      location: f.location,
      due: f.due,
      contactEmail: f.contactEmail,
      contactPhone: f.contactPhone,
      oppId: f.oppId,
      link: f.link,
      status: 'new',
      files: [],
      emails: [],
    };
    newProjects++;
  }

  const bid = bids[key];
  if (bid.emails.some(e => e.id === emailId)) continue;
  newEmails++;
  bid.emails.push({
    id: emailId,
    kind,
    subject: msg.subject ?? null,
    receivedAt: msg.receivedDateTime ?? null,
  });
  // Invites carry the richest data — let them fill gaps on the project,
  // and let a real invite replace a name derived from a notification subject.
  for (const [k2, v] of Object.entries(f)) {
    if (v && !bid[k2]) bid[k2] = v;
  }
  if (kind === 'invite' && f.project) {
    bid.project = f.project;
    if (f.client) bid.client = f.client;
    if (f.trade) bid.trade = f.trade;
  }
  if (f.due && kind !== 'invite') bid.due = f.due; // extensions move the date
}

saveBids(bids);
const projects = Object.values(bids);
console.log(`Scanned ${found} BuildingConnected email(s) from the last ${DAYS} days.`);
console.log(`${newEmails} new email(s); ${newProjects} new project(s); ${projects.length} total in data/bids.json:\n`);
for (const b of projects) {
  console.log(`  • ${b.project}${b.client ? `  [${b.client}]` : ''}${b.due ? `  due ${b.due}` : ''}  (${b.emails.length} email${b.emails.length === 1 ? '' : 's'})`);
}
if (DUMP) console.log('\nRaw copies saved to data/raw/ for parser tuning.');
