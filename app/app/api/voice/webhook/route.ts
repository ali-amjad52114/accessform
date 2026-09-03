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
import { runVoiceTool } from '../../../../lib/voice/tool-handlers';
import { parseVapiServerMessage, toolResponse } from '../../../../lib/voice/vapi-messages';
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
    const results = await Promise.all(
      message.toolCalls.map(async (call) => {
        const args =
          message.caseId && typeof call.args === 'object' && call.args
            ? { case_id: message.caseId, ...(call.args as Record<string, unknown>) }
            : call.args;
        const outcome = await runVoiceTool(call.name, args);
        return { toolCallId: call.id, result: outcome.result };
      }),
    );
    return NextResponse.json(toolResponse(results));
  }

  if (message.caseId) {
    await recordLifecycle(message.caseId, message.type, message.raw);
  }

  return NextResponse.json({ received: message.type });
}

export function GET(): Response {
  return NextResponse.json({ ok: true, endpoint: 'vapi-server-webhook' });
}
