// Send a proposal PDF to the GC via Microsoft Graph sendMail.
// Uses its own token file (ms-tokens-send.json) with the Mail.Send scope —
// separate from the read-only intake tokens. First use requires:
//   1. Mail.Send delegated permission added to the Entra app (one-time,
//      in the Entra portal), and
//   2. a device-code sign-in, driven from the dashboard UI.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

const SCOPES = 'Mail.Send offline_access';
const TOKENS = 'ms-tokens-send.json';

function env() {
  const e = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) e[m[1]] = m[2];
  }
  e.MS_TENANT_ID ||= 'organizations';
  return e;
}

const tokenUrl = e => `https://login.microsoftonline.com/${e.MS_TENANT_ID}/oauth2/v2.0/token`;

// --- device-code flow, split into start/poll so the UI can display the code ---
const pending = new Map(); // deviceCode -> {interval, clientId, tenant}

export async function startSendAuth() {
  const e = env();
  const res = await fetch(`https://login.microsoftonline.com/${e.MS_TENANT_ID}/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.MS_CLIENT_ID, scope: SCOPES }),
  });
  const dc = await res.json();
  if (!res.ok) throw new Error(dc.error_description ?? 'device code request failed');
  pending.set(dc.device_code, true);
  return { deviceCode: dc.device_code, userCode: dc.user_code, url: dc.verification_uri, message: dc.message };
}

export async function pollSendAuth(deviceCode) {
  const e = env();
  const res = await fetch(tokenUrl(e), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: e.MS_CLIENT_ID,
      device_code: deviceCode,
    }),
  });
  const body = await res.json();
  if (res.ok) {
    writeFileSync(TOKENS, JSON.stringify(body, null, 2));
    pending.delete(deviceCode);
    return { status: 'done' };
  }
  if (body.error === 'authorization_pending' || body.error === 'slow_down') return { status: 'pending' };
  return { status: 'error', error: body.error_description ?? body.error };
}

export function sendAuthReady() {
  return existsSync(TOKENS);
}

async function accessToken() {
  if (!existsSync(TOKENS)) throw Object.assign(new Error('send auth not set up'), { code: 'NO_AUTH' });
  const e = env();
  const saved = JSON.parse(readFileSync(TOKENS, 'utf8'));
  const res = await fetch(tokenUrl(e), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: e.MS_CLIENT_ID,
      refresh_token: saved.refresh_token,
      scope: SCOPES,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw Object.assign(new Error(body.error_description ?? 'token refresh failed'), { code: 'NO_AUTH' });
  writeFileSync(TOKENS, JSON.stringify(body, null, 2));
  return body.access_token;
}

export async function sendProposal({ to, subject, bodyText, pdfPath }) {
  const token = await accessToken();
  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      saveToSentItems: true,
      message: {
        subject,
        body: { contentType: 'Text', content: bodyText },
        toRecipients: [{ emailAddress: { address: to } }],
        attachments: [{
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: basename(pdfPath),
          contentType: 'application/pdf',
          contentBytes: readFileSync(pdfPath).toString('base64'),
        }],
      },
    }),
  });
  if (res.status === 202) return { sent: true };
  const err = await res.text();
  if (res.status === 403) throw Object.assign(new Error('Mail.Send permission missing on the Entra app'), { code: 'NO_PERMISSION', detail: err });
  throw new Error(`sendMail failed (${res.status}): ${err}`);
}
