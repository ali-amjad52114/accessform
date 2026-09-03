/**
 * Twilio Messages API, server-side only, via fetch.
 *
 * Auth: Account SID + Auth Token (basic auth). The API Key pair in .env.local
 * was verified on 2026-09-03 to return 401 code 8001 ("actor doesn't have any
 * assertions") against this account, so it is only a fallback when the auth
 * token is absent.
 *
 * Nothing in this module decides WHETHER to send — that is `sendSummary()` in
 * ./sms.ts (trial guard, demo guard, deliveries rows). This module just talks
 * to Twilio and reports what Twilio said.
 */

import { serverSecret } from '../adapters/env';
import { TWILIO_FROM_ENV } from '../contract';

export const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01' as const;

/**
 * The number AccessForm texts from. Read from `TWILIO_FROM_NUMBER`; this
 * default is the number provisioned on the account (verified sms-capable,
 * status "in-use") and exists so the running server works before the env var
 * is added. Add `TWILIO_FROM_NUMBER=+19452772309` to app/.env.local.
 */
export const DEFAULT_TWILIO_FROM_NUMBER = '+19452772309' as const;

export interface TwilioCredentials {
  accountSid: string;
  /** Basic-auth username: the Account SID, or the API Key SID as fallback. */
  username: string;
  /** Basic-auth password: the Auth Token, or the API Key Secret as fallback. */
  password: string;
  authKind: 'auth_token' | 'api_key';
  from: string;
  /** The ONLY number a trial account may text. Undefined when not configured. */
  testMobile?: string;
}

export function twilioCredentials(): TwilioCredentials | undefined {
  const accountSid = serverSecret('TWILIO_ACCOUNT_SID');
  if (!accountSid) return undefined;
  const authToken = serverSecret('TWILIO_AUTH_TOKEN');
  const keySid = serverSecret('TWILIO_API_KEY_SID');
  const keySecret = serverSecret('TWILIO_API_KEY_SECRET');
  const from = serverSecret(TWILIO_FROM_ENV) ?? DEFAULT_TWILIO_FROM_NUMBER;
  const testMobile = serverSecret('TWILIO_TEST_MOBILE');

  if (authToken) {
    return { accountSid, username: accountSid, password: authToken, authKind: 'auth_token', from, testMobile };
  }
  if (keySid && keySecret) {
    return { accountSid, username: keySid, password: keySecret, authKind: 'api_key', from, testMobile };
  }
  return undefined;
}

export function hasTwilioCredentials(): boolean {
  return twilioCredentials() !== undefined;
}

function basicAuth(creds: TwilioCredentials): string {
  return 'Basic ' + Buffer.from(`${creds.username}:${creds.password}`, 'utf8').toString('base64');
}

/** E.164: "+" then 8-15 digits. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** Last four digits only — the only form a number is ever spoken or logged in. */
export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : '***';
}

export interface TwilioSendResult {
  ok: boolean;
  /** Message SID ("SM…") when accepted. */
  sid: string;
  /** Twilio's own status word ("queued", "accepted", …) when accepted. */
  status: string;
  /** Twilio error text (code + message) when rejected; "" otherwise. */
  error: string;
  httpStatus: number;
}

/**
 * POST /Accounts/{sid}/Messages.json. Never throws on a Twilio rejection —
 * the caller records the outcome on the deliveries row either way.
 */
export async function sendSms(
  creds: TwilioCredentials,
  input: { to: string; body: string },
  timeoutMs = 20_000,
): Promise<TwilioSendResult> {
  const form = new URLSearchParams();
  form.set('To', input.to);
  form.set('From', creds.from);
  form.set('Body', input.body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${TWILIO_API_BASE}/Accounts/${creds.accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(creds),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = {};
    }
    if (!response.ok) {
      const code = json.code !== undefined ? `Twilio ${String(json.code)}: ` : `HTTP ${response.status}: `;
      const message = typeof json.message === 'string' ? json.message : text.slice(0, 200);
      return { ok: false, sid: '', status: '', error: code + message, httpStatus: response.status };
    }
    return {
      ok: true,
      sid: typeof json.sid === 'string' ? json.sid : '',
      status: typeof json.status === 'string' ? json.status : 'queued',
      error: '',
      httpStatus: response.status,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      sid: '',
      status: '',
      error: aborted ? `Twilio request timed out after ${timeoutMs}ms` : `Twilio request failed: ${error instanceof Error ? error.message : String(error)}`,
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface TwilioAccountCheck {
  ok: boolean;
  accountStatus: string;
  accountType: string;
  authKind: TwilioCredentials['authKind'];
  from: string;
  fromSmsCapable: boolean | null;
  error: string;
}

/**
 * GET /Accounts/{sid}.json and the from-number's capabilities. Read-only;
 * used by the dry-run route so an operator can see the account state without
 * sending anything. Never returns a secret.
 */
export async function checkTwilioAccount(creds: TwilioCredentials): Promise<TwilioAccountCheck> {
  const headers = { Authorization: basicAuth(creds), Accept: 'application/json' };
  const base: TwilioAccountCheck = {
    ok: false,
    accountStatus: '',
    accountType: '',
    authKind: creds.authKind,
    from: creds.from,
    fromSmsCapable: null,
    error: '',
  };
  try {
    const acct = await fetch(`${TWILIO_API_BASE}/Accounts/${creds.accountSid}.json`, { headers, cache: 'no-store' });
    const acctJson = (await acct.json()) as Record<string, unknown>;
    if (!acct.ok) {
      return { ...base, error: `HTTP ${acct.status}: ${String(acctJson.message ?? '')}` };
    }
    base.accountStatus = String(acctJson.status ?? '');
    base.accountType = String(acctJson.type ?? '');

    const nums = await fetch(
      `${TWILIO_API_BASE}/Accounts/${creds.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(creds.from)}`,
      { headers, cache: 'no-store' },
    );
    const numsJson = (await nums.json()) as { incoming_phone_numbers?: Array<{ capabilities?: { sms?: boolean } }> };
    const first = numsJson.incoming_phone_numbers?.[0];
    base.fromSmsCapable = first ? Boolean(first.capabilities?.sms) : false;
    base.ok = base.accountStatus === 'active' && base.fromSmsCapable === true;
    if (!base.ok && !base.error) {
      base.error = first ? `account status "${base.accountStatus}"` : `from-number ${creds.from} is not on this account`;
    }
    return base;
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
