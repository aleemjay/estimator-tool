// Direct-GC senders: contractors who email bid invites directly instead
// of through BuildingConnected. Configured in data/direct-senders.json
// (machine-local, gitignored — GC contact info never gets committed):
//
//   { "summitgc.net": "Summit GC", "bids@acmebuilders.com": "Acme Builders" }
//
// Keys are a full address or a domain; values are the GC's display name
// (used as the bid's client). Any matching sender's email flows through
// intake like a BC notification: grouped by fuzzy project-name match,
// client/contact prefilled from this map.

import { readFileSync, existsSync } from 'node:fs';

export function loadDirectSenders(file = 'data/direct-senders.json') {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  } catch (e) {
    console.log(`(ignoring ${file}: ${e.message})`);
    return {};
  }
}

// Returns the GC display name when the sender matches, else null.
export function directClient(sender, senders) {
  const s = (sender ?? '').toLowerCase();
  const domain = s.split('@')[1] ?? '';
  for (const [k, name] of Object.entries(senders ?? {})) {
    const key = k.toLowerCase();
    if (s === key || domain === key || domain.endsWith('.' + key)) return name;
  }
  return null;
}
