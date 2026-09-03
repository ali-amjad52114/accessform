/**
 * Hands the live document adapter to the voice tool handlers.
 *
 * `lib/voice/tool-handlers.ts` deliberately never imports the adapter layer:
 * it asks `lib/voice/adapter-registry.ts` for a Nutrient adapter and, when
 * none has been registered, records the bundled fixture document instead.
 * Until this module existed nothing registered one, so the `finalize_document`
 * voice tool never reached `lib/document/engine.ts` — every voice-driven
 * finalize wrote the fixture PDF with a `processed` status it had not earned.
 *
 * Every server entry point that runs voice tools (the /api/voice/tools and
 * /api/voice/webhook routes) calls `ensureVoiceAdaptersRegistered()` before
 * dispatching. It is idempotent and cheap.
 *
 * Only the document adapter is registered, and only when the adapter layer
 * resolves it as live: demo mode keeps the fixture path the voice layer
 * already has, and SerpApi is left unregistered so a tool call can never spend
 * search credit by accident.
 */

import { registerNutrientAdapter } from '../voice/adapter-registry';
import { isBrowser } from './env';
import { getNutrientAdapter, resolveModes } from './index';

let registered = false;

/** Register the live document adapter with the voice layer, once per process. */
export function ensureVoiceAdaptersRegistered(): void {
  if (registered || isBrowser()) return;
  if (resolveModes().nutrient !== 'live') return;
  registerNutrientAdapter(getNutrientAdapter());
  registered = true;
}
