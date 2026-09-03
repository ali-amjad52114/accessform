/**
 * Client-safe tool-name helpers.
 *
 * `tool-handlers.ts` is server-only (it touches the Xano bridge), so browser
 * code that just needs to recognise a tool name imports this instead.
 *
 * M1: the tool set is `M1_VOICE_TOOL_NAMES` (eight tools plus the
 * `get_case_progress` alias). Every legacy name is still in that list, so the
 * loose predicate keeps accepting the old six and gains the new ones.
 */

import { M1_VOICE_TOOL_NAMES, type M1VoiceToolName } from '../contract';

export function isM1VoiceToolName(name: string): name is M1VoiceToolName {
  return (M1_VOICE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Loose check used by the browser voice adapter. The predicate is the M1
 * union, which is a superset of the legacy `VapiToolName` union, so callers
 * that still cast to `VapiToolName` keep compiling.
 */
export function isVapiToolNameLoose(name: string): name is M1VoiceToolName {
  return isM1VoiceToolName(name);
}

/**
 * Short, human sentences for the sponsor-visibility feed on /live. Generic on
 * purpose: the product is need-first, not hospital-first.
 */
export const TOOL_ACTIVITY_LABELS: Readonly<Record<M1VoiceToolName, string>> = {
  create_case: 'Xano · Case opened',
  resolve_need: 'OpenAI · Understanding the need',
  find_nearby_organizations: 'SerpApi · Looking for places nearby',
  discover_program: 'SerpApi · Searching official sources',
  get_next_question: 'Xano · Next question fetched',
  save_answer: 'Xano · Answer saved',
  validate_case: 'Xano · Completeness checked',
  finalize_document: 'Document · Filling the official form',
  send_summary: 'Twilio · Sending the summary text',
  get_case_progress: 'Xano · Progress checked',
};
