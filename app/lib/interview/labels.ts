/**
 * Human wording for requirement labels that reach a caller's ears or phone.
 *
 * Xano derives some requirement labels from raw PDF field ids (e.g.
 * "Signature1_es_:signer:signature"). Nothing like that may be read aloud or
 * texted, so every surfaced label passes through here first.
 */

const SIGNATURE = /signature|sign here|signer/i;

export function humanizeRequirementLabel(label: string): string {
  const raw = (label ?? '').trim();
  if (!raw) return '';
  if (SIGNATURE.test(raw)) return 'Your signature';
  return raw
    .replace(/_es_:.*$/i, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+\d+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}
