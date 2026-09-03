/**
 * Optional integration adapters for the voice tool routes.
 *
 * The SerpApi and Nutrient adapters are owned by the adapter layer. The voice
 * tools never import them directly — the adapter layer registers itself here
 * (typically from a server module that runs on boot), and until that happens
 * the tools fall back to the verified fixtures. That keeps the demo working
 * with or without live credentials, and keeps file ownership clean.
 */

import type { NutrientAdapter, SerpAdapter } from '../contract';

const REGISTRY_KEY = Symbol.for('accessform.voice.integrationAdapters');

interface Registry {
  serp?: SerpAdapter;
  nutrient?: NutrientAdapter;
}

function registry(): Registry {
  const globalRegistry = globalThis as unknown as Record<symbol, Registry | undefined>;
  let existing = globalRegistry[REGISTRY_KEY];
  if (!existing) {
    existing = {};
    globalRegistry[REGISTRY_KEY] = existing;
  }
  return existing;
}

export function registerSerpAdapter(adapter: SerpAdapter): void {
  registry().serp = adapter;
}

export function registerNutrientAdapter(adapter: NutrientAdapter): void {
  registry().nutrient = adapter;
}

export function getSerpAdapter(): SerpAdapter | null {
  return registry().serp ?? null;
}

export function getNutrientAdapter(): NutrientAdapter | null {
  return registry().nutrient ?? null;
}
