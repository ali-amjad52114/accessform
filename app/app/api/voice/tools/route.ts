/**
 * POST /api/voice/tools — the Vapi tool-call webhook.
 *
 * Every voice tool points its `server.url` here. Vapi posts a `tool-calls`
 * server message; we run the tool against the Xano bridge and answer with
 * `{ results: [{ toolCallId, result }] }`.
 *
 * A failing tool returns 200 with an error sentence in `result` on purpose:
 * a dropped integration must never end a vulnerable caller's conversation.
 */

import { NextResponse } from 'next/server';
import { ensureVoiceAdaptersRegistered } from '../../../../lib/adapters/register-voice';
import { M1_VOICE_TOOL_NAMES } from '../../../../lib/contract';
import { runToolCallsForCall } from '../../../../lib/voice/run-for-call';
import { parseVapiServerMessage, toolResponse } from '../../../../lib/voice/vapi-messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Optional shared secret — set VAPI_SERVER_SECRET on both ends to enable. */
function secretRejected(request: Request): boolean {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (!expected) return false;
  const provided =
    request.headers.get('x-vapi-secret') ?? request.headers.get('x-vapi-signature') ?? '';
  return provided !== expected;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The phone number on the other end of the call, when Vapi knows it
 * (`message.call.customer.number` for phone calls; absent for browser calls).
 * Only ever used as a default for `caller_phone` / `to`; never spoken back.
 */
function callerPhoneOf(raw: Record<string, unknown>): string | null {
  const call = record(raw.call);
  const customer = record(call.customer ?? raw.customer);
  const number = customer.number;
  return typeof number === 'string' && number.trim() ? number.trim() : null;
}

export async function POST(request: Request): Promise<Response> {
  if (secretRejected(request)) {
    return NextResponse.json({ error: 'Invalid server secret' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const message = parseVapiServerMessage(body);
  if (message.toolCalls.length === 0) {
    // Vapi also sends status-update / transcript here when the assistant-level
    // server URL is set to this route. Acknowledge without doing anything.
    return NextResponse.json({ results: [], received: message.type });
  }

  // finalize_document must run through the document engine, not the fixture.
  ensureVoiceAdaptersRegistered();

  const callerPhone = callerPhoneOf(message.raw);
  const results = await runToolCallsForCall(message, callerPhone);

  return NextResponse.json(toolResponse(results));
}

/** Health check used by scripts/vapi/verify-assistant.mjs. */
export function GET(): Response {
  return NextResponse.json({
    ok: true,
    tools: M1_VOICE_TOOL_NAMES,
    demoMode: process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  });
}
