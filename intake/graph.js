// Shared Microsoft Graph helpers for the intake scripts (email.js,
// replies.js): .env loading, device-code sign-in, token refresh, and
// HTML-to-text. Tokens live in ms-tokens.json (Mail.Read scope).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export function loadEnv() {
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

async function deviceCodeSignIn(env, scopes) {
  const base = `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0`;
  let res = await fetch(`${base}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID, scope: scopes }),
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

export async function getToken(env, scopes = 'Mail.Read offline_access') {
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
          scope: scopes,
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
  const tokens = await deviceCodeSignIn(env, scopes);
  writeFileSync('ms-tokens.json', JSON.stringify(tokens, null, 2));
  console.log('Signed in; tokens saved to ms-tokens.json');
  return tokens;
}

export function htmlToText(html) {
  return (html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n');
}
