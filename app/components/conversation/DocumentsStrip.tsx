import type { CaseDocument, Id } from '../../lib/contract';
import { isAbsoluteUrl } from './timeline-model';

interface DocLink {
  label: string;
  href: string | null;
}

/** Where a document row can be opened from, or null when it cannot. */
export function documentHref(doc: CaseDocument | undefined, caseId: Id): string | null {
  if (!doc) return null;
  if (isAbsoluteUrl(doc.generated_url)) return doc.generated_url;
  if (doc.type === 'source_application') {
    return isAbsoluteUrl(doc.source_url) ? doc.source_url : null;
  }
  if (doc.type === 'filled_application') {
    return `/api/document/${encodeURIComponent(caseId)}`;
  }
  return null;
}

/** Thin row under the call bar: the official form and the filled form. */
export function DocumentsStrip({ documents, caseId }: { documents: CaseDocument[]; caseId: Id }) {
  const source = documents.find((doc) => doc.type === 'source_application');
  const filled = documents.find((doc) => doc.type === 'filled_application');

  const links: DocLink[] = [
    { label: 'Official form', href: documentHref(source, caseId) },
    { label: 'Filled form', href: documentHref(filled, caseId) },
  ];

  return (
    <nav className="af-cv-docs" aria-label="Documents">
      <span>Documents:</span>
      {links.map((link) =>
        link.href ? (
          <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer">
            {link.label}
            <span className="af-sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          <span key={link.label} className="af-cv-docs__off" aria-disabled="true">
            {link.label}
            <span className="af-sr-only"> — not available yet</span>
          </span>
        ),
      )}
    </nav>
  );
}
