/**
 * Minimal .env loader — no dependencies.
 *
 * Reads app/.env.local (then app/.env), with real process env winning, so the
 * provisioning scripts use exactly the same credentials as the Next.js app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = {
  ...parseEnvFile(path.join(APP_DIR, '.env')),
  ...parseEnvFile(path.join(APP_DIR, '.env.local')),
};

export const env = { ...fileEnv, ...process.env };

export function require_(name) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it to app/.env.local or export it before running.`);
  }
  return value;
}

/**
 * Public base URL Vapi will call back on. Vapi's servers cannot reach
 * localhost, so tunnel it (cloudflared / ngrok) and pass the https URL:
 *   VAPI_SERVER_URL=https://xyz.trycloudflare.com node scripts/vapi/provision-assistant.mjs
 */
export function serverBaseUrl() {
  return (env.VAPI_SERVER_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function isLocalUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
}
