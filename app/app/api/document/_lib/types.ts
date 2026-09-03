/**
 * Types shared between the document route handlers (server) and /review
 * (client). Kept in their own module — with no node: imports — so a client
 * component can reference them without dragging fs/crypto across the boundary.
 */

import type { AccessibilityStatus, Id } from '../../../../lib/contract';

/** Where the bytes we are serving actually came from. */
export type DocumentOrigin = 'live' | 'cache' | 'fixture';

export interface GeneratedDocument {
  caseId: Id;
  /** Same-origin URL the Nutrient Viewer loads. */
  documentUrl: string;
  /** The official PDF the filled document was built from. */
  sourceUrl: string;
  accessibilityStatus: AccessibilityStatus;
  versionHash: string;
  fieldsFilled: number;
  byteLength: number;
  origin: DocumentOrigin;
  /** Non-fatal problem worth surfacing in the UI — never a claim of success. */
  note: string | null;
}
