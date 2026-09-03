/**
 * Runs the tool calls of one Vapi server message with the per-call registry
 * applied, so that one phone call stays one case:
 *
 *   - a case id known for this call (from the registry, or the browser
 *     session's variable) is the default `case_id` of every tool call;
 *   - a second `create_case` on the same call returns the existing case
 *     instead of opening another one;
 *   - the first `create_case` binds the call to its case and flushes any
 *     transcript turns spoken before the case existed.
 *
 * Shared by /api/voice/tools and /api/voice/webhook. Server-only.
 */

import { getXanoAdapter } from './xano-bridge';
import {
  caseForCall,
  drainTranscripts,
  rememberCaseForCall,
  type PendingTurn,
} from './call-registry';
import { runVoiceTool } from './tool-handlers';
import type { VapiServerMessage } from './vapi-messages';

export interface ToolCallResult {
  toolCallId: string;
  result: Record<string, unknown>;
}

/** Write buffered pre-case transcript turns onto the case, oldest first. */
export async function flushPendingTranscripts(callId: string | null, caseId: string): Promise<void> {
  const turns: PendingTurn[] = drainTranscripts(callId);
  if (turns.length === 0) return;
  const xano = getXanoAdapter();
  for (const turn of turns) {
    try {
      await xano.appendEvent(caseId, {
        actor: turn.role === 'user' ? 'user' : 'voice_agent',
        event_type: 'transcript_turn',
        message: turn.text,
        metadata_json: { role: turn.role, transcript_type: 'final', call_id: callId, spoken_at: turn.at },
      });
    } catch (error) {
      console.warn('[voice] could not flush a buffered transcript turn:', (error as Error).message);
    }
  }
}

function caseIdFromResult(result: Record<string, unknown>): string | null {
  const value = result.case_id ?? result.id;
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : null;
}

export async function runToolCallsForCall(
  message: VapiServerMessage,
  callerPhone: string | null,
): Promise<ToolCallResult[]> {
  const callId = message.callId;
  const results: ToolCallResult[] = [];

  // Sequential on purpose: create_case must bind the call before a sibling
  // tool call in the same message looks the case up.
  for (const call of message.toolCalls) {
    const given = typeof call.args === 'object' && call.args ? (call.args as Record<string, unknown>) : {};
    const knownCase = message.caseId ?? caseForCall(callId);

    if (call.name === 'create_case' && knownCase) {
      // One call, one case. Hand back the case this call already opened.
      let status: unknown = 'CREATED';
      try {
        status = (await getXanoAdapter().getCase(knownCase)).case.status;
      } catch {
        /* the id is still the right answer */
      }
      results.push({
        toolCallId: call.id,
        result: {
          case_id: knownCase,
          status,
          note: 'This call already has a case. Keep using this case_id; call resolve_need again if what the caller needs has changed.',
        },
      });
      continue;
    }

    const args: Record<string, unknown> = {
      ...(knownCase ? { case_id: knownCase } : {}),
      ...(callerPhone ? { caller_phone: callerPhone } : {}),
      ...given,
      // The registry's case wins over anything the model typed for this call.
      ...(knownCase && call.name !== 'create_case' ? { case_id: knownCase } : {}),
    };

    const outcome = await runVoiceTool(call.name, args);

    if (call.name === 'create_case' && outcome.ok) {
      const created = caseIdFromResult(outcome.result);
      if (created) {
        rememberCaseForCall(callId, created);
        await flushPendingTranscripts(callId, created);
      }
    }

    results.push({ toolCallId: call.id, result: outcome.result });
  }

  return results;
}
