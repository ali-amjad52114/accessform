/**
 * /review — the last screen of the slice.
 *
 * Left ~65%: the real, filled Cedars-Sinai application, rendered by the
 * Nutrient Viewer. Right ~35%: the completeness summary and the outstanding
 * items. Nothing here says submitted, approved, eligible or signed — the
 * status wording all comes from SAFE_COPY.
 */

import type { Metadata } from 'next';

import Link from 'next/link';

import {
  DEMO_CASE_BUNDLE,
  DEMO_CASE_ID,
  DEMO_COMPLETENESS,
  SAFE_COPY,
  type CaseBundle,
  type CompletenessSummary,
  type Requirement,
} from '../../lib/contract';
import { getXanoAdapter, isDemoMode } from '../../lib/adapters';
import { describeDocument } from '../api/document/_lib/generate';
import type { GeneratedDocument } from '../api/document/_lib/types';

import ReviewClient from './ReviewClient';
import styles from './review.module.css';

export const metadata: Metadata = {
  title: 'Application ready — AccessForm',
  description:
    'Review the filled Cedars-Sinai financial assistance application and see what is still needed.',
};

export const dynamic = 'force-dynamic';

interface ReviewPageProps {
  searchParams: Promise<{ case?: string }>;
}

/** Which case to show: `?case=` when given; the demo case only in demo mode. */
async function resolveCase(
  requested: string | undefined,
): Promise<{ bundle: CaseBundle; completeness: CompletenessSummary } | null> {
  if (isDemoMode()) {
    return { bundle: DEMO_CASE_BUNDLE, completeness: DEMO_COMPLETENESS };
  }
  if (!requested) return null;
  const xano = getXanoAdapter();
  const bundle = await xano.getCase(requested);
  const completeness = await xano.validateCase(requested);
  return { bundle, completeness };
}

export default async function ReviewPage({ searchParams }: ReviewPageProps) {
  const { case: requestedCase } = await searchParams;
  const resolved = await resolveCase(requestedCase);

  if (!resolved) {
    return (
      <div className={styles.page}>
        <header className={styles.masthead}>
          <span className={styles.mark} aria-hidden="true" />
          <span className={styles.brand}>AccessForm</span>
        </header>
        <main className={styles.main} id="main">
          <div className={styles.titleBlock}>
            <h1>No application to review yet</h1>
            <p className={styles.subtitle}>
              Start a call and AccessForm will bring you here when the application is ready.
            </p>
            <p>
              <Link className="af-btn af-btn--primary" href="/live">
                Start a call
              </Link>
            </p>
          </div>
        </main>
      </div>
    );
  }

  const { bundle, completeness } = resolved;
  const caseId = bundle.case.id || DEMO_CASE_ID;
  const programName = bundle.program?.name ?? 'financial assistance application';
  const documentUrl = `/api/document/${encodeURIComponent(caseId)}`;

  /* Cached-only so the first paint is instant and never blocked on Nutrient.
     ReviewClient re-reads the live status as soon as it mounts. */
  let initialDocument: GeneratedDocument;
  try {
    initialDocument = await describeDocument({
      caseId,
      answers: bundle.answers,
      sourceUrl: bundle.program?.application_url || undefined,
      cachedOnly: true,
    });
  } catch {
    initialDocument = {
      caseId,
      documentUrl,
      sourceUrl: bundle.program?.application_url ?? '',
      accessibilityStatus: 'pending',
      versionHash: 'pending',
      fieldsFilled: bundle.answers.length,
      byteLength: 0,
      origin: 'live',
      note: null,
    };
  }

  const completedRequirements: Requirement[] = bundle.requirements.filter(
    (requirement) => requirement.status === 'complete',
  );
  const missingRequirements: Requirement[] = bundle.requirements.filter(
    (requirement) => requirement.status === 'missing',
  );

  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.brand}>AccessForm</span>
        <span className={styles.caseId}>Case {caseId}</span>
      </header>

      {/* `id="main"` is the target of the skip link in app/layout.tsx. */}
      <main className={styles.main} id="main">
        <div className={styles.titleBlock}>
          <h1>Application ready</h1>
          <p className={styles.subtitle}>{programName}</p>
          <p className={styles.readyBadge}>
            <span aria-hidden="true">●</span>
            {SAFE_COPY.readyForReview} — {SAFE_COPY.notSubmitted}
          </p>
        </div>

        <ReviewClient
          caseId={caseId}
          patientDisplayName={bundle.case.patient_display_name}
          programName={programName}
          program={bundle.program}
          completeness={completeness}
          completedRequirements={completedRequirements}
          missingRequirements={missingRequirements}
          documentUrl={documentUrl}
          initialDocument={initialDocument}
        />
      </main>
    </div>
  );
}
