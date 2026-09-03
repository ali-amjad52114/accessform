/**
 * Organization-agnostic status wording, usable from server and client
 * components alike (no 'use client', no React). Never renders "submitted",
 * "approved", "eligible", "qualified" or "signed" as a claim about the
 * caller's application.
 */

/** "Not submitted. <Organization> decides." */
export function notSubmittedCopy(organization: string | null): string {
  return organization
    ? `Not submitted. ${organization} decides.`
    : 'Not submitted. The organization decides.';
}

/** "AccessForm cannot determine eligibility. <Organization> makes that decision." */
export function eligibilityCopy(organization: string | null): string {
  return `AccessForm cannot determine eligibility. ${organization ?? 'The organization'} makes that decision.`;
}
