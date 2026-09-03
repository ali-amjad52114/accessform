/**
 * POST /api/voice/tools — the Vapi tool-call webhook.
 *
 * Every one of the six voice tools points its `server.url` here. Vapi posts a
 * `tool-calls` server message; we run the tool against the Xano bridge and
 * answer with `{ results: [{ toolCallId, result }] }`.
 *
 * A failing tool returns 200 with an error sentence in `result` on purpose:
 * a dropped integration must never end a vulnerable caller's conversation.
 */

import { NextResponse } from 'next/server';
import { VAPI_TOOL_NAMES } from '../../../../lib/contract';
import { runVoiceTool } from '../../../../lib/voice/tool-handlers';
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

/** Health check used by scripts/vapi/verify-assistant.mjs. */
export function GET(): Response {
  return NextResponse.json({
    ok: true,
    tools: VAPI_TOOL_NAMES,
    demoMode: process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  });
}
