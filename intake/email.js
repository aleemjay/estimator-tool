#!/usr/bin/env node
// Email intake: scans the Google Workspace inbox over IMAP for
// BuildingConnected notification emails and records each bid invite in
// data/bids.json. Safe to re-run — already-seen messages are skipped.
//
// Usage:
//   node intake/email.js            # scan the last 30 days
//   node intake/email.js --days 90  # scan further back
//   node intake/email.js --dump     # also save raw email bodies to data/raw/
//                                   #   (used to tune the parser)

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const DAYS = process.argv.includes('--days')
  ? Number(process.argv[process.argv.indexOf('--days') + 1])
  : 30;
const DUMP = process.argv.includes('--dump');

function loadEnv() {
  const env = {};
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2];
    }
  }
  if (!env.IMAP_USER || !env.IMAP_APP_PASSWORD) {
    console.error(
      'Missing IMAP_USER / IMAP_APP_PASSWORD in .env.\n' +
      'Create a Google app password at https://myaccount.google.com/apppasswords\n' +
      '(requires 2-step verification on the account).'
    );
    process.exit(1);
  }
  return env;
}

function loadBids() {
  if (!existsSync('data/bids.json')) return {};
  return JSON.parse(readFileSync('data/bids.json', 'utf8'));
}

function saveBids(bids) {
  mkdirSync('data', { recursive: true });
  writeFileSync('data/bids.json', JSON.stringify(bids, null, 2));
}

// Extract what we can from a BuildingConnected notification email.
// Tuned against real samples via --dump; fields that can't be parsed stay
// null and get filled in manually (or later via the API).
function parseInvite(mail) {
  const subject = mail.subject ?? '';
  const text = (mail.text ?? '').replace(/\r/g, '');

  // Common subject shapes:
  //   "You've been invited to bid on <project> by <company>"
  //   "Reminder: <project> bids are due ..."
  //   "<person> from <company> invited you to bid on <project>"
  let project = null;
  let client = null;
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
const client = new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: env.IMAP_USER, pass: env.IMAP_APP_PASSWORD },
  logger: false,
});

const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const bids = loadBids();
let found = 0, added = 0;

await client.connect();
const lock = await client.getMailboxLock('[Gmail]/All Mail').catch(() => client.getMailboxLock('INBOX'));
try {
  const uids = await client.search({ from: 'buildingconnected.com', since });
  console.log(`Found ${uids?.length ?? 0} BuildingConnected emails since ${since.toDateString()}.`);
  for await (const msg of client.fetch(uids ?? [], { source: true, envelope: true })) {
    found++;
    const mail = await simpleParser(msg.source);
    const id = mail.messageId ?? `uid-${msg.uid}`;
    if (DUMP) {
      mkdirSync('data/raw', { recursive: true });
      const safe = id.replace(/[^a-z0-9]/gi, '_').slice(0, 80);
      writeFileSync(`data/raw/${safe}.txt`, `SUBJECT: ${mail.subject}\nFROM: ${mail.from?.text}\nDATE: ${mail.date}\n\n${mail.text ?? ''}`);
    }
    if (bids[id]) continue;
    const parsed = parseInvite(mail);
    bids[id] = {
      source: 'email',
      receivedAt: mail.date?.toISOString() ?? null,
      subject: mail.subject ?? null,
      ...parsed,
      status: 'new',
      files: [],
    };
    added++;
    console.log(`  + ${parsed.project ?? mail.subject}`);
  }
} finally {
  lock.release();
  await client.logout();
}

saveBids(bids);
console.log(`\nProcessed ${found} emails; ${added} new bid record(s) in data/bids.json.`);
if (DUMP) console.log('Raw copies saved to data/raw/ for parser tuning.');
