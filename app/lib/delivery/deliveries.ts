/**
 * The `deliveries` rows — POST /cases/{id}/deliveries on Xano.
 *
 * Kept out of lib/adapters/xano.ts (another builder's file). Uses the same
 * http helper so errors carry the same shape. When Xano cannot take the row
 * (endpoint not deployed yet, network down) the would-be row is returned with
 * `id: ""` and `persisted: false` so the caller can still report honestly;
 * a delivery is never claimed persisted when it was not.
 */

import { xanoCredentials } from '../adapters/env';
import { AdapterError } from '../adapters/errors';
import { requestJson } from '../adapters/http';
import {
  DELIVERY_CHANNELS,
  DELIVERY_STATUSES,
  M1_XANO_ENDPOINTS,
  type CreateDeliveryRequest,
  type Delivery,
  type DeliveryChannel,
  type DeliveryStatus,
  type Id,
} from '../contract';

export interface DeliveryWrite {
  delivery: Delivery;
  /** False when Xano did not accept the row; `delivery.id` is then "". */
  persisted: boolean;
  /** Why it was not persisted; "" when it was. */
  error: string;
}

function str(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

function epochToIso(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return new Date(n).toISOString();
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function normalizeStatus(value: unknown, fallback: DeliveryStatus): DeliveryStatus {
  const s = str(value);
  return (DELIVERY_STATUSES as readonly string[]).includes(s) ? (s as DeliveryStatus) : fallback;
}

/** Xano row -> contract row. "" not null; epoch ms -> ISO; numeric id -> string. */
export function normalizeDelivery(raw: unknown, fallback: Delivery): Delivery {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: str(r.id, fallback.id),
    case_id: str(r.case_id, fallback.case_id),
    channel: (DELIVERY_CHANNELS as readonly string[]).includes(str(r.channel))
      ? (str(r.channel) as DeliveryChannel)
      : fallback.channel,
    to: str(r.to, fallback.to),
    message: str(r.message, fallback.message),
    document_url: str(r.document_url, fallback.document_url),
    status: normalizeStatus(r.status, fallback.status),
    provider_id: str(r.provider_id, fallback.provider_id),
    error: str(r.error, fallback.error),
    created_at: r.created_at !== undefined ? epochToIso(r.created_at) : fallback.created_at,
  };
}

/** The row as it would look, before/without Xano. */
export function wouldBeDelivery(caseId: Id, input: CreateDeliveryRequest): Delivery {
  return {
    id: '',
    case_id: caseId,
    channel: input.channel,
    to: input.to,
    message: input.message,
    document_url: input.document_url,
    status: input.status,
    provider_id: input.provider_id ?? '',
    error: input.error ?? '',
    created_at: new Date().toISOString(),
  };
}

/**
 * POST /cases/{id}/deliveries. The endpoint edits in place when `provider_id`
 * matches an existing row for the case, inserts otherwise, and sets
 * cases.delivery_status itself (contract §5).
 */
export async function createDelivery(caseId: Id, input: CreateDeliveryRequest): Promise<DeliveryWrite> {
  const fallback = wouldBeDelivery(caseId, input);
  const creds = xanoCredentials();
  if (!creds) {
    return { delivery: fallback, persisted: false, error: 'XANO_BASE_URL is not set' };
  }
  const path = M1_XANO_ENDPOINTS.createDelivery.path.replace('{id}', encodeURIComponent(caseId));
  const body: CreateDeliveryRequest = {
    channel: input.channel,
    to: input.to,
    message: input.message,
    document_url: input.document_url,
    status: input.status,
    provider_id: input.provider_id ?? '',
    error: input.error ?? '',
  };
  try {
    const raw = await requestJson<unknown>('xano', 'createDelivery', creds.baseUrl + path, {
      method: M1_XANO_ENDPOINTS.createDelivery.method,
      headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
      json: body,
      timeoutMs: 15_000,
    });
    return { delivery: normalizeDelivery(raw, fallback), persisted: true, error: '' };
  } catch (error) {
    const reason =
      error instanceof AdapterError
        ? `${error.message}${error.detail ? ` — ${error.detail.slice(0, 120)}` : ''}`
        : error instanceof Error
          ? error.message
          : String(error);
    console.warn(`[delivery] deliveries row not persisted for case ${caseId}: ${reason}`);
    return { delivery: fallback, persisted: false, error: reason };
  }
}
