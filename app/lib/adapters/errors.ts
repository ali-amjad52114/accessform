/**
 * Adapter error handling.
 *
 * Hard rule for this slice: a failed live call must never throw into the UI.
 * Every live adapter method is wrapped by `withFallback`, which logs the real
 * failure server-side and returns the deterministic fixture result instead.
 */

export type IntegrationName = 'serpapi' | 'xano' | 'nutrient' | 'vapi';

export class AdapterError extends Error {
  readonly integration: IntegrationName;
  readonly operation: string;
  readonly status?: number;
  readonly detail?: string;

  constructor(
    integration: IntegrationName,
    operation: string,
    message: string,
    options: { status?: number; detail?: string; cause?: unknown } = {},
  ) {
    super(`[${integration}] ${operation}: ${message}`);
    this.name = 'AdapterError';
    this.integration = integration;
    this.operation = operation;
    this.status = options.status;
    this.detail = options.detail;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** One recorded fallback, so /live can honestly label a simulated event. */
export interface FallbackRecord {
  integration: IntegrationName;
  operation: string;
  reason: string;
  at: string;
}

const fallbackLog: FallbackRecord[] = [];
const MAX_FALLBACK_LOG = 50;

export function recordFallback(record: FallbackRecord): void {
  fallbackLog.push(record);
  if (fallbackLog.length > MAX_FALLBACK_LOG) fallbackLog.shift();
}

/** Read-only copy of the fallbacks recorded in this process. */
export function getFallbackLog(): readonly FallbackRecord[] {
  return fallbackLog.slice();
}

export function clearFallbackLog(): void {
  fallbackLog.length = 0;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Run a live call; on any failure record it and fall back to the fixture.
 * If the fixture itself fails the error propagates — that is a real bug.
 */
export async function withFallback<T>(
  integration: IntegrationName,
  operation: string,
  live: () => Promise<T>,
  fixture: () => Promise<T>,
): Promise<T> {
  try {
    return await live();
  } catch (error) {
    const reason = describe(error);
    recordFallback({
      integration,
      operation,
      reason,
      at: new Date().toISOString(),
    });
    if (typeof console !== 'undefined') {
      console.warn(
        `[accessform] ${integration}.${operation} failed, using fixture. ${reason}`,
      );
    }
    return fixture();
  }
}
