/**
 * POST /api/voice/webhook — the assistant-level Vapi server URL.
 *
 * Receives lifecycle messages (status-update, end-of-call-report, transcript)
 * and records the ones that matter as Xano case events, so the /live feed keeps
 * showing what actually happened. Tool calls that arrive here (Vapi falls back
 * to the assistant-level URL when a tool has no `server.url` of its own) are
 * delegated to the same handlers as /api/voice/tools.
 */

import { NextResponse } from 'next/server';
import { ensureVoiceAdaptersRegistered } from '../../../../lib/adapters/register-voice';
import { runVoiceTool } from '../../../../lib/voice/tool-handlers';
import {
  parseVapiServerMessage,
  parseVapiTranscript,
  toolResponse,
} from '../../../../lib/voice/vapi-messages';
import { getXanoAdapter } from '../../../../lib/voice/xano-bridge';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

/** Same rule as /api/voice/tools: the call's customer number, phone calls only. */
function callerPhoneOf(raw: Record<string, unknown>): string | null {
  const call = record(raw.call);
  const customer = record(call.customer ?? raw.customer);
  const number = customer.number;
  return typeof number === 'string' && number.trim() ? number.trim() : null;
}

/**
 * Persist one FINAL transcript turn as a `transcript_turn` event so the
 * conversation timeline can be rendered from the case record alone. Partial
 * transcripts are dropped (Vapi re-sends the same words as they firm up).
 * Never throws — Vapi must always get a 200 for a transcript message.
 */
async function recordTranscript(caseId: string, callId: string | null, raw: Record<string, unknown>) {
  const turn = parseVapiTranscript(raw);
  if (!turn || turn.transcript_type !== 'final') return;
  try {
    await getXanoAdapter().appendEvent(caseId, {
      actor: turn.role === 'user' ? 'user' : 'voice_agent',
      event_type: 'transcript_turn',
      message: turn.text,
      metadata_json: { role: turn.role, transcript_type: 'final', call_id: callId },
    });
  } catch (error) {
    console.warn('[voice] webhook could not record transcript turn:', (error as Error).message);
  }
}

async function recordLifecycle(caseId: string, type: string, raw: Record<string, unknown>) {
  const xano = getXanoAdapter();
  try {
    if (type === 'status-update') {
      const status = typeof raw.status === 'string' ? raw.status : 'unknown';
      if (status === 'in-progress') {
        await xano.appendEvent(caseId, {
          actor: 'user',
          event_type: 'call_started',
          message: 'Call started',
          metadata_json: { status },
        });
      } else if (status === 'ended') {
        await xano.appendEvent(caseId, {
          actor: 'voice_agent',
          event_type: 'call_ended',
          message: 'Call ended',
          metadata_json: { status },
        });
      }
    } else if (type === 'end-of-call-report') {
      await xano.appendEvent(caseId, {
        actor: 'voice_agent',
        event_type: 'call_report',
        message: 'Call summary recorded',
        metadata_json: {
          ended_reason: typeof raw.endedReason === 'string' ? raw.endedReason : null,
        },
      });
    }
  } catch (error) {
    console.warn('[voice] webhook could not record lifecycle event:', (error as Error).message);
  }
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

  if (message.toolCalls.length > 0) {
    // finalize_document must run through the document engine, not the fixture.
    ensureVoiceAdaptersRegistered();
    const callerPhone = callerPhoneOf(message.raw);
    const results = await Promise.all(
      message.toolCalls.map(async (call) => {
        const given = typeof call.args === 'object' && call.args ? (call.args as Record<string, unknown>) : {};
        const args: Record<string, unknown> = {
          ...(message.caseId ? { case_id: message.caseId } : {}),
          ...(callerPhone ? { caller_phone: callerPhone } : {}),
          ...given,
        };
        const outcome = await runVoiceTool(call.name, args);
        return { toolCallId: call.id, result: outcome.result };
      }),
    );
    return NextResponse.json(toolResponse(results));
  }

  if (message.caseId) {
    if (message.type === 'transcript') {
      await recordTranscript(message.caseId, message.callId, message.raw);
    } else {
      await recordLifecycle(message.caseId, message.type, message.raw);
    }
  }

  return NextResponse.json({ received: message.type });
}

export function GET(): Response {
  return NextResponse.json({ ok: true, endpoint: 'vapi-server-webhook' });
}
