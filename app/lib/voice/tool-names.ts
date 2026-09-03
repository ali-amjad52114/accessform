/**
 * Client-safe tool-name helpers.
 *
 * `tool-handlers.ts` is server-only (it touches the Xano bridge), so browser
 * code that just needs to recognise a tool name imports this instead.
 */

import { VAPI_TOOL_NAMES, type VapiToolName } from '../contract';

export function isVapiToolNameLoose(name: string): name is VapiToolName {
  return (VAPI_TOOL_NAMES as readonly string[]).includes(name);
}

/** Short, human sentences for the sponsor-visibility feed on /live. */
export const TOOL_ACTIVITY_LABELS: Readonly<Record<VapiToolName, string>> = {
  create_case: 'Xano · Case created',
  discover_program: 'SerpApi · Official Cedars program found',
  save_answer: 'Xano · Answer saved',
  get_case_progress: 'Xano · Progress checked',
  validate_case: 'Xano · Completeness checked',
  finalize_document: 'Nutrient · Completed PDF generated',
};
