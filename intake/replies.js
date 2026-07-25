#!/usr/bin/env node
// GC reply detection: scans the mailbox for messages from the contacts a
// proposal was sent to and records them on the bid (gcReplies[] +
// gcReplyAt), so replies surface in the dashboard instead of living only
// in Outlook. Runs after email intake (dashboard "Fetch new bids" button
// and the pipeline); safe to re-run — replies dedupe by message id.
//
// Usage: node intake/replies.js

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GRAPH, loadEnv, getToken } from './graph.js';

// Senders that are never a GC reply: our own mailbox + platform noise.
const NOT_GC = /epoxycreationsfl\.com$|buildingconnected\.com$|autodesk\.com$|@.*no-?reply/i;
const GENERIC_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'aol.com', 'icloud.com', 'msn.com', 'live.com']);

const bidAddresses = b =>
  (b.recipients ?? (b.sentTo ? b.sentTo.split(/[,;]/) : [b.contactEmail]))
    .map(a => (a ?? '').trim().toLowerCase()).filter(Boolean);

const projectTokens = p =>
  (p ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 4);

// Match one inbox message to the sent bid it belongs to. Exact recipient
// address wins; a same-company domain match needs the subject/preview to
// mention the project or estimate number (so two bids at one GC don't
// cross-attach). Returns a bid key or null.
export function matchReply(msg, targets) {
  const from = (msg.from?.emailAddress?.address ?? '').toLowerCase();
  const fromDomain = from.split('@')[1] ?? '';
  if (!from || NOT_GC.test(from)) return null;
  const hay = `${msg.subject ?? ''} ${msg.bodyPreview ?? ''}`.toLowerCase();

  const mentions = ([key, b]) =>
    (b.estimateNo && hay.includes(`estimate #${b.estimateNo}`)) ||
    projectTokens(b.project).some(t => hay.includes(t));

  const exact = targets.filter(([, b]) => bidAddresses(b).includes(from));
  const domain = GENERIC_DOMAINS.has(fromDomain) ? [] : targets.filter(([, b]) =>
    bidAddresses(b).some(a => a.endsWith('@' + fromDomain)));

  const pool = exact.length ? exact : domain;
  if (!pool.length) return null;
  // Only count messages received after the proposal went out.
  const after = pool.filter(([, b]) => new Date(msg.receivedDateTime) > new Date(b.sentAt));
  if (!after.length) return null;
  if (after.length === 1 && exact.length) return after[0][0];
  const mentioned = after.filter(mentions);
  if (mentioned.length) return mentioned[0][0];
  if (!exact.length) return null; // domain-only match with no project mention: too ambiguous
  // Same contact, several bids, no project mention — take the latest send.
  return after.sort((a, b) => new Date(b[1].sentAt) - new Date(a[1].sentAt))[0][0];
}

// Re-read fresh and patch only reply fields (single-writer discipline).
function recordReplies(key, replies) {
  const fresh = JSON.parse(readFileSync('data/bids.json', 'utf8'));
  if (!fresh[key]) return;
  const seen = new Set((fresh[key].gcReplies ?? []).map(r => r.id));
  const merged = [...(fresh[key].gcReplies ?? []), ...replies.filter(r => !seen.has(r.id))]
    .sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt)).slice(-20);
  fresh[key].gcReplies = merged;
  fresh[key].gcReplyAt = merged[merged.length - 1]?.receivedAt ?? null;
  writeFileSync('data/bids.json', JSON.stringify(fresh, null, 2));
}

async function main() {
  const bids = existsSync('data/bids.json') ? JSON.parse(readFileSync('data/bids.json', 'utf8')) : {};
  const targets = Object.entries(bids).filter(([, b]) => b.sentAt && bidAddresses(b).length);
  if (!targets.length) {
    console.log('No sent bids to watch for replies.');
    return;
  }

  const oldest = Math.min(...targets.map(([, b]) => +new Date(b.sentAt)));
  const since = new Date(Math.max(oldest - 24 * 3600e3, Date.now() - 90 * 24 * 3600e3)).toISOString();

  const env = loadEnv();
  const tokens = await getToken(env, 'Mail.Read offline_access');
  let url = `${GRAPH}/me/messages?$filter=receivedDateTime ge ${since}` +
    `&$select=id,subject,from,receivedDateTime,bodyPreview,webLink&$top=50&$orderby=receivedDateTime desc`;

  const byKey = new Map();
  let scanned = 0;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!res.ok) throw new Error(`Graph request failed (${res.status}): ${await res.text()}`);
    const page = await res.json();
    for (const msg of page.value ?? []) {
      scanned++;
      const key = matchReply(msg, targets);
      if (!key) continue;
      const list = byKey.get(key) ?? [];
      list.push({
        id: msg.id,
        from: msg.from?.emailAddress?.address ?? '',
        fromName: msg.from?.emailAddress?.name ?? '',
        subject: msg.subject ?? '',
        preview: (msg.bodyPreview ?? '').slice(0, 200),
        receivedAt: msg.receivedDateTime,
        webLink: msg.webLink ?? null,
      });
      byKey.set(key, list);
    }
    url = page['@odata.nextLink'] ?? null;
  }

  for (const [key, replies] of byKey) recordReplies(key, replies);
  console.log(`Scanned ${scanned} message(s) since ${since.slice(0, 10)}; replies matched on ${byKey.size} bid(s):`);
  for (const [key, replies] of byKey) console.log(`  💬 ${bids[key].project} — ${replies.length} message(s), latest: ${replies[replies.length - 1].subject}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
