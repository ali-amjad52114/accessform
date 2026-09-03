/**
 * GET /api/voice/session — what the browser needs to start a voice session.
 *
 * The /live screen calls this once. It returns the publishable Vapi key, the
 * AccessForm assistant id, and whether the session must run in deterministic
 * simulation mode. The private key never leaves the server: when
 * `VAPI_ASSISTANT_ID` is not set, the id is looked up by assistant name with
 * the private key and cached in memory.
 */

import { NextResponse } from 'next/server';
import { ACCESSFORM_ASSISTANT_NAME } from '../../../../lib/voice/assistant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CachedLookup {
  assistantId: string | null;
  fetchedAt: number;
}

const CACHE_KEY = Symbol.for('accessform.voice.assistantLookup');
const CACHE_TTL_MS = 5 * 60 * 1000;

function cache(): { value?: CachedLookup } {
  const globalCache = globalThis as unknown as Record<symbol, { value?: CachedLookup } | undefined>;
  let existing = globalCache[CACHE_KEY];
  if (!existing) {
    existing = {};
    globalCache[CACHE_KEY] = existing;
  }
  return existing;
}

async function lookupAssistantId(): Promise<string | null> {
  const explicit = process.env.VAPI_ASSISTANT_ID ?? process.env.NEXT_PUBLIC_VAPI_ASSISTANT_ID;
  if (explicit) return explicit;

  const store = cache();
  const cached = store.value;
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.assistantId;

  const privateKey = process.env.VAPI_PRIVATE_KEY;
  if (!privateKey) return null;

  try {
    const response = await fetch('https://api.vapi.ai/assistant', {
      headers: { authorization: `Bearer ${privateKey}` },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const assistants = (await response.json()) as { id?: string; name?: string }[];
    const match = Array.isArray(assistants)
      ? assistants.find((assistant) => assistant.name === ACCESSFORM_ASSISTANT_NAME)
      : undefined;
    const assistantId = match?.id ?? null;
    store.value = { assistantId, fetchedAt: Date.now() };
    return assistantId;
  } catch (error) {
    console.warn('[voice] could not look up the Vapi assistant:', (error as Error).message);
    store.value = { assistantId: null, fetchedAt: Date.now() };
    return null;
  }
}

export async function GET(): Promise<Response> {
  const publicKey =
    process.env.NEXT_PUBLIC_VAPI_PUBLIC_KEY ?? process.env.VAPI_PUBLIC_KEY ?? null;
  const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
  const assistantId = await lookupAssistantId();

  return NextResponse.json({
    assistantName: ACCESSFORM_ASSISTANT_NAME,
    assistantId,
    publicKey,
    demoMode,
    /** True when the browser must replay the scripted conversation instead. */
    simulationOnly: demoMode || !publicKey || !assistantId,
  });
}
