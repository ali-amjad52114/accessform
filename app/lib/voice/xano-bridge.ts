/**
 * Server-side Xano access for the voice tool routes.
 *
 * Resolution order, per request:
 *   1. a real `XanoAdapter` registered by the adapter layer (see
 *      `registerXanoAdapter`) — this is how `lib/adapters/xano.ts` plugs in;
 *   2. a direct HTTP client against `XANO_API_BASE`, using exactly the seven
 *      endpoints in specs/API_INTEGRATIONS.md;
 *   3. the in-memory fixture store, so the demo never breaks.
 *
 * Every method degrades individually: a single failing Xano call falls back to
 * the fixture answer instead of failing the voice turn.
 */

import type {
  Answer,
  Case,
  CaseBundle,
  CaseDocument,
  CaseEvent,
  CaseProgress,
  CompletenessSummary,
  CreateCaseInput,
  DiscoveryResult,
  FormSchemaField,
  Id,
  NewCaseEvent,
  Program,
  SaveAnswerInput,
  SaveDocumentInput,
  XanoAdapter,
} from '../contract';
import * as fixtures from './case-store';
import { interviewPlanAsFormSchema } from './form-plan';

/* ------------------------------------------------------------------ */
/* Registration hook for the real adapter                              */
/* ------------------------------------------------------------------ */

const REGISTRY_KEY = Symbol.for('accessform.voice.xanoAdapter');

type Registry = { adapter?: XanoAdapter };

function registry(): Registry {
  const globalRegistry = globalThis as unknown as Record<symbol, Registry | undefined>;
  let existing = globalRegistry[REGISTRY_KEY];
  if (!existing) {
    existing = {};
    globalRegistry[REGISTRY_KEY] = existing;
  }
  return existing;
}

/**
 * Called by the adapter layer (`lib/adapters/xano.ts`) to hand the voice tools
 * the real, live adapter. Until that happens the bridge uses HTTP + fixtures.
 */
export function registerXanoAdapter(adapter: XanoAdapter): void {
  registry().adapter = adapter;
}

export function registeredXanoAdapter(): XanoAdapter | null {
  return registry().adapter ?? null;
}

/* ------------------------------------------------------------------ */
/* HTTP client                                                         */
/* ------------------------------------------------------------------ */

function xanoBaseUrl(): string | null {
  const base =
    process.env.XANO_API_BASE ??
    process.env.XANO_BASE_URL ??
    process.env.NEXT_PUBLIC_XANO_API_BASE ??
    '';
  return base ? base.replace(/\/+$/, '') : null;
}

function xanoHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = process.env.XANO_API_KEY ?? process.env.XANO_AUTH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function xanoFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const base = xanoBaseUrl();
  if (!base) throw new Error('XANO_API_BASE is not configured');
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...xanoHeaders(), ...(init?.headers ?? {}) },
    cache: 'no-store',
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Xano ${init?.method ?? 'GET'} ${path} -> ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as T;
}

/** Xano's numeric primary keys cross the boundary as strings. */
function stringifyIds<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stringifyIds) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        (key === 'id' || key.endsWith('_id')) && typeof entry === 'number'
          ? String(entry)
          : stringifyIds(entry);
    }
    return out as T;
  }
  return value;
}

/**
 * True when a live Xano is reachable in principle. Used only for logging —
 * every call still falls back on its own.
 */
export function xanoConfigured(): boolean {
  return Boolean(xanoBaseUrl());
}

async function viaHttpOrFixture<T>(
  label: string,
  http: () => Promise<T>,
  fixture: () => T,
): Promise<T> {
  if (!xanoBaseUrl()) return fixture();
  try {
    return stringifyIds(await http());
  } catch (error) {
    console.warn(`[voice] Xano ${label} failed, using fixture store:`, (error as Error).message);
    return fixture();
  }
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

const bridgeAdapter: XanoAdapter = {
  createCase(input: CreateCaseInput): Promise<Case> {
    return viaHttpOrFixture(
      'POST /cases',
      () => xanoFetch<Case>('/cases', { method: 'POST', body: JSON.stringify(input) }),
      () => fixtures.createCase(input),
    );
  },

  getCase(caseId: Id): Promise<CaseBundle> {
    return viaHttpOrFixture(
      'GET /cases/:id',
      () => xanoFetch<CaseBundle>(`/cases/${encodeURIComponent(caseId)}`),
      () => fixtures.requireBundle(caseId),
    );
  },

  appendEvent(caseId: Id, event: NewCaseEvent): Promise<CaseEvent> {
    return viaHttpOrFixture(
      'POST /cases/:id/events',
      () =>
        xanoFetch<CaseEvent>(`/cases/${encodeURIComponent(caseId)}/events`, {
          method: 'POST',
          body: JSON.stringify(event),
        }),
      () => fixtures.appendEvent(caseId, event),
    );
  },

  saveAnswer(caseId: Id, fieldId: string, input: SaveAnswerInput): Promise<Answer> {
    return viaHttpOrFixture(
      'PUT /cases/:id/answers/:fieldId',
      () =>
        xanoFetch<Answer>(
          `/cases/${encodeURIComponent(caseId)}/answers/${encodeURIComponent(fieldId)}`,
          { method: 'PUT', body: JSON.stringify(input) },
        ),
      () => fixtures.saveAnswer(caseId, fieldId, input),
    );
  },

  getCaseProgress(caseId: Id): Promise<CaseProgress> {
    return viaHttpOrFixture(
      'GET /cases/:id/progress',
      () => xanoFetch<CaseProgress>(`/cases/${encodeURIComponent(caseId)}/progress`),
      () => fixtures.computeProgress(fixtures.requireBundle(caseId)),
    );
  },

  validateCase(caseId: Id): Promise<CompletenessSummary> {
    return viaHttpOrFixture(
      'POST /cases/:id/validate',
      () =>
        xanoFetch<CompletenessSummary>(`/cases/${encodeURIComponent(caseId)}/validate`, {
          method: 'POST',
        }),
      () => fixtures.validateCase(caseId),
    );
  },

  saveDiscoveredProgram(result: DiscoveryResult): Promise<Program> {
    return viaHttpOrFixture(
      'POST /programs/discovered',
      () =>
        xanoFetch<Program>('/programs/discovered', {
          method: 'POST',
          body: JSON.stringify(result),
        }),
      () => {
        throw new Error('saveDiscoveredProgram requires a case id in fixture mode');
      },
    );
  },

  getFormSchema(programId: Id): Promise<FormSchemaField[]> {
    return viaHttpOrFixture(
      'GET /form_schema',
      () => xanoFetch<FormSchemaField[]>(`/programs/${encodeURIComponent(programId)}/form_schema`),
      () => interviewPlanAsFormSchema(programId),
    );
  },

  saveDocument(caseId: Id, input: SaveDocumentInput): Promise<CaseDocument> {
    return viaHttpOrFixture(
      'POST /cases/:id/documents',
      () =>
        xanoFetch<CaseDocument>(`/cases/${encodeURIComponent(caseId)}/documents`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      () => fixtures.saveDocument(caseId, input),
    );
  },
};

/**
 * The adapter the voice tool routes call. Prefers a registered live adapter,
 * otherwise the HTTP + fixture bridge above.
 */
export function getXanoAdapter(): XanoAdapter {
  return registeredXanoAdapter() ?? bridgeAdapter;
}
