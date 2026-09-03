'use client';

/**
 * The inline cards of the conversation timeline. Each one reads its content
 * from the case bundle / progress / completeness it is handed; the event that
 * created it only decides where in the timeline it sits.
 *
 * Wording rules: never approved, eligible, qualified, submitted, sent, filed
 * or signed as a state of the application. Accessibility status is literal.
 */

import type { ReactNode } from 'react';
import {
  NEED_CATEGORY_LABELS,
  SAFE_COPY,
  type AccessibilityStatus,
  type CaseBundle,
  type CaseEvent,
  type CaseProgress,
  type CompletenessSummary,
  type Id,
} from '../../lib/contract';
import type { NeedCategory } from '../../lib/m1/contract';
import { eligibilityCopy, notSubmittedCopy } from '../safe-copy';
import { ApproveAndSend } from './ApproveAndSend';
import { documentHref } from './DocumentsStrip';
import {
  filledValues,
  formatClock,
  humanizeFieldId,
  maskPhone,
  searchCardState,
  sectionsWithFields,
  type FilledValue,
  type SearchCardState,
} from './timeline-model';

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export function CardShell({
  kind,
  title,
  sub,
  children,
  tone,
  label,
}: {
  kind: string;
  title: string;
  sub?: ReactNode;
  children?: ReactNode;
  tone?: 'warn' | 'ok';
  label?: string;
}) {
  const className = ['af-cv-card', tone ? `af-cv-card--${tone}` : ''].filter(Boolean).join(' ');
  return (
    <section className={className} aria-label={label ?? `${kind}: ${title}`}>
      <h2 className="af-cv-card__ttl">
        <span className="af-cv-kind">{kind}</span>
        {title}
      </h2>
      {sub ? <p className="af-cv-card__sub">{sub}</p> : null}
      {children}
    </section>
  );
}

function organizationName(bundle: CaseBundle | null): string | null {
  return bundle?.organization?.name?.trim() || bundle?.hospital?.name?.trim() || null;
}

function categoryLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return (NEED_CATEGORY_LABELS as Record<string, string>)[value as NeedCategory] ?? null;
}

/* ------------------------------------------------------------------ */
/* Situation chip                                                      */
/* ------------------------------------------------------------------ */

export function SituationCard({ event, bundle }: { event: CaseEvent; bundle: CaseBundle | null }) {
  const meta = event.metadata_json ?? {};
  const situation =
    bundle?.case.situation_text?.trim() ||
    (typeof meta.situation_text === 'string' ? meta.situation_text : '') ||
    event.message;
  const parts = [
    categoryLabel(meta.category) ?? categoryLabel(bundle?.case.need_category),
    (typeof meta.organization === 'string' && meta.organization) || organizationName(bundle),
    (typeof meta.location === 'string' && meta.location) || bundle?.case.location || null,
  ].filter((part): part is string => Boolean(part && part.trim()));

  return (
    <div className="af-cv-chip" role="group" aria-label="Your situation">
      <span className="af-cv-kind">Situation</span>
      <span className="af-cv-chip__text">{situation}</span>
      {parts.length > 0 ? <span className="af-cv-chip__meta">{parts.join(' · ')}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Search card                                                         */
/* ------------------------------------------------------------------ */

const FORM_KIND_WORD: Readonly<Record<string, string>> = {
  fillable_pdf: 'fillable PDF',
  flat_pdf: 'PDF without fillable fields',
  online_form: 'online form',
  in_person: 'in-person application',
};

export function SearchCard({ events, bundle }: { events: CaseEvent[]; bundle: CaseBundle | null }) {
  const state: SearchCardState = searchCardState(events);
  const organization = state.organization ?? organizationName(bundle);
  const programName = state.programName ?? bundle?.program?.name ?? null;
  const domain = state.sourceDomain ?? bundle?.program?.source_domain ?? null;
  const formKind = state.formKind ?? bundle?.program?.form_kind ?? null;

  const title = organization ? `Finding the official form for ${organization}` : 'Finding the official form';

  let summary: string;
  if (state.phase === 'found') {
    summary = ['Found the official form', programName, domain].filter(Boolean).join(' · ');
  } else if (state.phase === 'not_verified') {
    summary = organization
      ? `Could not verify an official source for ${organization}`
      : 'Could not verify an official source';
  } else {
    summary = 'Checking official sources…';
  }

  const official = state.candidates.filter((c) => c.verified).length;
  const unofficial = state.candidates.length - official;

  return (
    <CardShell kind="Search" title={title} tone={state.phase === 'not_verified' ? 'warn' : undefined}>
      <details className="af-cv-search" open={state.phase === 'searching'}>
        <summary>
          <span className="af-cv-chev" aria-hidden="true">
            ▶
          </span>
          <span className={state.phase === 'found' ? 'af-cv-found' : undefined}>{summary}</span>
        </summary>

        <div className="af-cv-search__body">
          {state.fromCatalog ? (
            <p className="af-cv-qline af-cv-qline--done">
              <span className="af-cv-spin" aria-hidden="true" />
              <span>From the verified program catalog — no live search needed</span>
            </p>
          ) : null}

          {state.queries.map((query) => (
            <p
              key={query}
              className={state.phase === 'searching' ? 'af-cv-qline' : 'af-cv-qline af-cv-qline--done'}
            >
              <span className="af-cv-spin" aria-hidden="true" />
              <span>
                <span className="af-sr-only">{state.phase === 'searching' ? 'Searching: ' : 'Searched: '}</span>
                {query}
              </span>
            </p>
          ))}

          {state.queries.length === 0 && state.phase === 'searching' ? (
            <p className="af-cv-qline">
              <span className="af-cv-spin" aria-hidden="true" />
              <span>Searching official sources</span>
            </p>
          ) : null}

          {state.candidates.length > 0 ? (
            <ul className="af-cv-results" aria-label="Sources considered">
              {state.candidates.map((candidate) => (
                <li
                  key={candidate.url}
                  className={candidate.verified ? 'af-cv-res' : 'af-cv-res af-cv-res--off'}
                >
                  <span>
                    <a href={candidate.url} target="_blank" rel="noopener noreferrer">
                      {candidate.title}
                    </a>
                    <br />
                    <span className="af-cv-dom">{candidate.source_domain}</span>
                    {candidate.reason ? <span className="af-cv-res__why"> · {candidate.reason}</span> : null}
                  </span>
                  <span className={candidate.verified ? 'af-cv-badge af-cv-badge--ok' : 'af-cv-badge af-cv-badge--mute'}>
                    {candidate.verified ? 'official source' : 'not official'}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {state.candidates.length > 0 && state.phase !== 'searching' ? (
            <p className="af-cv-search__tally">
              Checked {state.candidates.length} {state.candidates.length === 1 ? 'source' : 'sources'} ·{' '}
              {official} official, {unofficial} not official
              {state.searchesUsed !== null ? ` · ${state.searchesUsed} searches` : ''}
            </p>
          ) : null}
        </div>
      </details>

      {state.phase === 'found' ? (
        <p className="af-cv-foundline">
          {[
            programName ?? 'Official form found',
            domain ? `published at ${domain}` : null,
            formKind ? FORM_KIND_WORD[formKind] ?? formKind : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          {state.applicationUrl ? (
            <>
              {' · '}
              <a href={state.applicationUrl} target="_blank" rel="noopener noreferrer">
                open the official form
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {state.phase === 'not_verified' ? (
        <p className="af-cv-stop" role="status">
          {state.reason ??
            'AccessForm could not verify an official source for the organization you named, so it stopped here rather than fill the wrong form.'}
        </p>
      ) : null}
    </CardShell>
  );
}

/* ------------------------------------------------------------------ */
/* Form card                                                           */
/* ------------------------------------------------------------------ */

export function FormCard({
  bundle,
  progress,
  events,
}: {
  bundle: CaseBundle | null;
  progress: CaseProgress | null;
  events: CaseEvent[];
}) {
  const values = filledValues(bundle?.answers ?? [], events);
  const sections = sectionsWithFields(progress?.sections);
  const withFields = sections.filter((section) => section.fields.length > 0);
  const title = bundle?.program?.name?.trim() || 'The application';

  const blankFields = withFields.flatMap((section) => section.fields.filter((field) => field.leaveBlank));

  return (
    <CardShell kind="Form" title={title} sub="Filling in as you answer. Nothing is sent.">
      {withFields.length > 0 ? (
        <div className="af-cv-sections">
          {withFields.map((section) => (
            <div className="af-cv-sec" key={section.key}>
              <h3>
                {section.label}
                {section.total > 0 ? (
                  <span className="af-cv-sec__count"> · {section.answered} of {section.total}</span>
                ) : null}
              </h3>
              <div className="af-cv-fields">
                {section.fields
                  .filter((field) => !field.leaveBlank)
                  .map((field) => (
                    <FieldTile key={field.fieldId} label={field.label} value={values.get(field.fieldId) ?? null} />
                  ))}
              </div>
            </div>
          ))}
          {blankFields.length > 0 ? (
            <div className="af-cv-sec">
              <h3>Left blank for you</h3>
              <div className="af-cv-fields">
                {blankFields.map((field) => (
                  <div className="af-cv-f af-cv-f--blank" key={field.fieldId}>
                    <span className="af-cv-f__k">{field.label}</span>
                    <span className="af-cv-f__v">
                      {field.type === 'signature' ? 'yours to add' : 'never asked'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <FallbackFormBody progress={progress} values={values} />
      )}
    </CardShell>
  );
}

function FieldTile({ label, value }: { label: string; value: FilledValue | null }) {
  return (
    <div className={value ? 'af-cv-f af-cv-f--on' : 'af-cv-f'}>
      <span className="af-cv-f__k">{label}</span>
      <span className="af-cv-f__v">{value ? value.display : 'not yet'}</span>
    </div>
  );
}

/**
 * When Xano has not attached field lists to the sections, show each section's
 * count, then every answer saved so far under its section (when known).
 */
function FallbackFormBody({
  progress,
  values,
}: {
  progress: CaseProgress | null;
  values: Map<string, FilledValue>;
}) {
  const sections = progress?.sections ?? [];
  const steps = progress?.steps ?? [];
  const grouped = new Map<string, Array<[string, FilledValue]>>();
  for (const [fieldId, value] of values) {
    const key = value.section ?? '';
    const list = grouped.get(key) ?? [];
    list.push([fieldId, value]);
    grouped.set(key, list);
  }
  const groups = Array.from(grouped.entries()).sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : 0));

  return (
    <div className="af-cv-sections">
      {sections.length > 0 ? (
        <ul className="af-cv-seclist" aria-label="Sections of the form">
          {sections.map((section) => (
            <li key={section.key} className={`af-cv-seclist__row af-cv-seclist__row--${section.state}`}>
              <span>{section.label}</span>
              <span className="af-cv-sec__count">
                {section.field_count > 0 ? `${section.answered_count} of ${section.field_count} answered` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : steps.length > 0 ? (
        <ul className="af-cv-seclist" aria-label="Application steps">
          {steps.map((step) => (
            <li key={step.id} className={`af-cv-seclist__row af-cv-seclist__row--${step.state}`}>
              <span>{step.label}</span>
              <span className="af-cv-sec__count">
                {step.state === 'done' ? 'done' : step.state === 'active' ? 'in progress' : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {groups.length === 0 ? (
        <p className="af-cv-card__sub">No answers saved yet. The first one appears here.</p>
      ) : (
        groups.map(([section, entries]) => (
          <div className="af-cv-sec" key={section || '__answers'}>
            <h3>{section ? humanizeFieldId(section) : 'Answers so far'}</h3>
            <div className="af-cv-fields">
              {entries.map(([fieldId, value]) => (
                <FieldTile key={fieldId} label={value.label ?? humanizeFieldId(fieldId)} value={value} />
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Still missing                                                       */
/* ------------------------------------------------------------------ */

const COUNT_WORD = ['No', 'One', 'Two', 'Three', 'Four', 'Five'] as const;

const REQUIREMENT_HINT: Readonly<Record<string, string>> = {
  attachment: 'A copy or a photo. You can add it when you review the form.',
  signature: 'AccessForm never signs for you. Sign before it goes anywhere.',
  field: 'An answer the form still needs.',
};

export function MissingCard({
  completeness,
  bundle,
}: {
  completeness: CompletenessSummary | null;
  bundle: CaseBundle | null;
}) {
  const missing = completeness?.missingRequirements ?? [];
  const organization = organizationName(bundle);
  const count = missing.length;
  const word = count < COUNT_WORD.length ? COUNT_WORD[count] : String(count);
  const title =
    count === 0
      ? 'Nothing reported missing'
      : count === 1
        ? SAFE_COPY.missingWarningTitle
        : `${word} things before this can go anywhere`;

  return (
    <CardShell kind="Still missing" title={title} tone="warn">
      {completeness === null ? (
        <p className="af-cv-card__sub">Waiting for the completeness check.</p>
      ) : count === 0 ? (
        <p className="af-cv-card__sub">{SAFE_COPY.completenessBasis}</p>
      ) : (
        <ul className="af-cv-miss">
          {missing.map((requirement) => (
            <li key={requirement.id}>
              <span className="af-cv-miss__ic" aria-hidden="true">
                !
              </span>
              <div>
                <b>{requirement.label}</b>
                <span>{REQUIREMENT_HINT[requirement.type] ?? ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="af-cv-disc">{eligibilityCopy(organization)}</p>
    </CardShell>
  );
}

/* ------------------------------------------------------------------ */
/* Result                                                              */
/* ------------------------------------------------------------------ */

const ACCESSIBILITY_WORD: Readonly<Record<AccessibilityStatus, string | null>> = {
  processed: 'Accessibility processing ran on this PDF',
  preserved: 'The official form’s own accessibility tagging was preserved; no processing pass ran',
  failed: 'Accessibility processing failed',
  pending: 'Accessibility processing has not run',
  processing: 'Accessibility processing is running',
  not_applicable: null,
};

const ENGINE_WORD: Readonly<Record<string, string>> = {
  local: 'filled locally',
  nutrient: 'filled with Nutrient',
  fixture: 'demo fixture, not your answers',
};

export function ResultCard({
  event,
  bundle,
  progress,
  events,
  caseId,
  signedUrl = null,
}: {
  event: CaseEvent;
  bundle: CaseBundle | null;
  progress: CaseProgress | null;
  events: CaseEvent[];
  caseId: Id;
  signedUrl?: string | null;
}) {
  const organization = organizationName(bundle);
  const filledDoc = bundle?.documents.find((doc) => doc.type === 'filled_application');
  const sourceDoc = bundle?.documents.find((doc) => doc.type === 'source_application');
  const filledHref = documentHref(filledDoc, caseId, signedUrl ?? null);
  const sourceHref = documentHref(sourceDoc, caseId) ?? bundle?.program?.application_url ?? null;
  const engine = typeof event.metadata_json?.engine === 'string' ? event.metadata_json.engine : null;
  const fieldsFilled =
    typeof event.metadata_json?.fields_filled === 'number' ? event.metadata_json.fields_filled : null;
  const accessibility = filledDoc ? ACCESSIBILITY_WORD[filledDoc.accessibility_status] : null;

  const allDeliveries = bundle?.deliveries ?? [];
  const deliveries = allDeliveries.filter((d) => d.channel !== 'email');
  const emailDeliveries = allDeliveries.filter((d) => d.channel === 'email');
  const latest = deliveries.length > 0 ? deliveries[deliveries.length - 1] : null;
  const approve = (
    <ApproveAndSend
      caseId={caseId}
      emailDeliveries={emailDeliveries}
      organization={organization}
      disabled={!filledDoc && bundle?.program?.form_kind !== 'flat_pdf'}
    />
  );

  let texted: ReactNode;
  if (!latest) {
    texted = 'Not texted yet';
  } else if (latest.status === 'sent') {
    texted = `Link sent to ${maskPhone(latest.to)} · ${formatClock(latest.created_at)}`;
  } else if (latest.status === 'queued') {
    texted = `Text queued for ${maskPhone(latest.to)}`;
  } else {
    texted = (
      <>
        {latest.status === 'skipped' ? 'Text skipped' : 'Text failed'}
        {latest.error ? <span className="af-cv-status__err"> · {latest.error}</span> : null}
      </>
    );
  }

  const flat = bundle?.program?.form_kind === 'flat_pdf';

  if (flat) {
    const values = filledValues(bundle?.answers ?? [], events);
    return (
      <CardShell kind="Result" title="The official PDF and your answers">
        <p className="af-cv-card__sub">
          This form has no fillable fields. Here is the official PDF and every answer you gave, ready to copy in.
        </p>
        {sourceHref ? (
          <p className="af-cv-resultlink">
            <a href={sourceHref} target="_blank" rel="noopener noreferrer">
              Open the official PDF
            </a>
          </p>
        ) : null}
        {values.size === 0 ? (
          <p className="af-cv-card__sub">No answers were saved on this conversation.</p>
        ) : (
          <dl className="af-cv-answers">
            {Array.from(values.entries()).map(([fieldId, value]) => (
              <div key={fieldId} className="af-cv-answers__row">
                <dt>{value.label ?? humanizeFieldId(fieldId)}</dt>
                <dd>{value.display}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="af-cv-status">
          <div className="af-cv-status__row">
            <span className="af-cv-status__lbl">Texted</span>
            <span>{texted}</span>
          </div>
          <div className="af-cv-status__row">
            <span className="af-cv-status__lbl">Status</span>
            <span>{notSubmittedCopy(organization)}</span>
          </div>
        </div>
        {approve}
      </CardShell>
    );
  }

  const filledLine = (() => {
    const saved = progress?.answersSaved ?? null;
    const expected = progress?.answersExpected ?? null;
    const base =
      fieldsFilled !== null
        ? `${fieldsFilled} ${fieldsFilled === 1 ? 'answer' : 'answers'} written to the official PDF`
        : saved !== null && expected
          ? `${saved} of ${expected} answers written to the official PDF`
          : 'Written to the official PDF';
    const detail = engine ? ENGINE_WORD[engine] ?? engine : null;
    return detail ? `${base} · ${detail}` : base;
  })();

  return (
    <CardShell kind="Result" title={SAFE_COPY.readyForReview}>
      <div className="af-cv-resrow">
        {filledHref ? (
          <a className="af-cv-pdf" href={filledHref} target="_blank" rel="noopener noreferrer">
            <span className="af-cv-pdf__page" aria-hidden="true">
              <i className="h" />
              <i />
              <i className="fill" />
              <i className="fill" />
              <i />
              <i className="fill" />
              <i />
              <i className="fill" />
              <i className="fill" />
              <i />
              <i className="fill" />
            </span>
            <span className="af-cv-pdf__label">Open the filled form (PDF)</span>
          </a>
        ) : (
          <div className="af-cv-pdf af-cv-pdf--off" aria-disabled="true">
            <span className="af-cv-pdf__page" aria-hidden="true">
              <i className="h" />
              <i />
              <i />
              <i />
            </span>
            <span className="af-cv-pdf__label">Filled form not available yet</span>
          </div>
        )}

        <div className="af-cv-status">
          <div className="af-cv-status__row">
            <span className="af-cv-status__lbl">Filled</span>
            <span>{filledLine}</span>
          </div>
          {accessibility ? (
            <div className="af-cv-status__row">
              <span className="af-cv-status__lbl">Access</span>
              <span>{accessibility}</span>
            </div>
          ) : null}
          <div className="af-cv-status__row">
            <span className="af-cv-status__lbl">Texted</span>
            <span>{texted}</span>
          </div>
          <div className="af-cv-status__row">
            <span className="af-cv-status__lbl">Status</span>
            <span>{notSubmittedCopy(organization)}</span>
          </div>
        </div>
      </div>
      {approve}
      <p className="af-cv-disc">{SAFE_COPY.completenessBasis} {eligibilityCopy(organization)}</p>
    </CardShell>
  );
}
