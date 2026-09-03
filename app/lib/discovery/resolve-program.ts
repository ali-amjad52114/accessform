/**
 * Program discovery — `{ category, organization?, location }` -> a verified
 * official program, or an honest `found: false`.
 *
 * Order (docs/M1_CONTRACT.md §3.2), stopping at the first hit:
 *   1. Catalog: Xano `GET /programs/resolve`, else the verified manifest
 *      `spike/catalog.json` while that endpoint is not deployed. Zero searches.
 *   2. Live SerpApi: two templated queries, allowlisted by authority
 *      (.gov/.edu, per-category registries, known transit agencies, and the
 *      named organization's own domain), within `SERPAPI_RUN_BUDGET`.
 *   3. OpenAI verdict (gpt-4o, strict schema, `url` enum = the candidates):
 *      "is this the official application for <org> in <region>?"
 *   4. Byte verification with pdf-lib: `%PDF`, field count, pages, sha256.
 *   5. Persist via `POST /organizations` + `POST /programs/catalog` when live.
 *
 * INVARIANT: `found: true` only with a verified official source for the SAME
 * organization the caller named (or the official authority for the category in
 * that region when none was named). Never another organization's form. Never a
 * fixture outside demo mode.
 */

import {
  CATALOG_SUBMISSION_INSTRUCTIONS,
  FORM_KINDS,
  NEED_CATEGORY_LABELS,
  OPENAI_JUDGMENT_MODEL,
  ORGANIZATION_KINDS,
  type DiscoveredSource,
  type FormKind,
  type Id,
  type NeedCategory,
  type OrganizationKind,
  type ProgramCandidate,
  type ProgramResolution,
  type ResolveProgramInput,
  type ResolvedProgram,
  type UpsertCatalogProgramRequest,
} from '../contract';
import {
  buildDiscoveryQueries,
  discoveryPolicyFor,
  extractDocumentLinks,
  hostOf,
  inferOrganizationDomain,
  isAllowedDomain,
  looksLikePdf,
  pickPolicyUrl,
  rankSources,
  registrableDomain,
  type DiscoveryPolicy,
} from '../adapters/discovery-rules';
import { isDemoMode, serpApiKey } from '../adapters/env';
import { getSerpBudget, queryGap, serpOrganicSearch, type SerpHit } from '../adapters/serp';
import { createXanoAdapter } from '../adapters/xano';
import { completeStrictJson, hasOpenAiKey, type JsonSchema } from '../need/openai-json';
import { organizationMatches } from '../voice/tool-handlers';
import {
  catalogRequestForEntry,
  isAbsoluteHttps,
  manifestOrganizationDomain,
  matchCatalogEntries,
  programFromCatalogEntry,
  readCatalogManifest,
  regionMatches,
  xanoResolveProgram,
  xanoUpsertCatalogProgram,
  xanoUpsertOrganization,
  type ManifestMatch,
} from './catalog';
import { inspectDocument } from './verify-pdf';

/** Credits one resolveProgram() call may spend. */
export const MAX_LIVE_QUERIES_PER_CALL = 2;
/** Candidates shown to the verdict model. */
const MAX_VERDICT_CANDIDATES = 5;
/** Candidate documents downloaded for byte verification. */
const MAX_DOWNLOADS = 3;
/** Document links followed from one official HTML page. */
const MAX_PAGE_LINKS = 2;

/**
 * Optional test/replay seam. `hits` replaces the SerpApi step with recorded
 * results (zero credits) so the verdict + byte verification can be re-run.
 */
export interface ResolveProgramOptions {
  hits?: SerpHit[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clean(text: string | undefined): string | undefined {
  const trimmed = (text ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function describeRequest(input: { category: NeedCategory; organization?: string; location?: string }): string {
  if (input.organization) return input.organization;
  const label = NEED_CATEGORY_LABELS[input.category].toLowerCase();
  return input.location ? `${label} in ${input.location}` : label;
}

function notFoundReason(input: { category: NeedCategory; organization?: string; location?: string }): string {
  return `I could not verify an official form for ${describeRequest(input)}.`;
}

function kindForCategory(category: NeedCategory): OrganizationKind {
  switch (category) {
    case 'hospital_financial_assistance':
      return 'hospital';
    case 'paratransit':
      return 'transit_agency';
    case 'disability_accommodation':
    case 'scholarship_financial_aid':
      return 'college';
    case 'benefits':
      return 'agency';
    default:
      return 'other';
  }
}

async function appendCaseEvent(
  caseId: Id | undefined,
  event: { actor: 'serpapi' | 'xano'; event_type: string; message: string; metadata_json?: Record<string, unknown> },
): Promise<void> {
  if (!caseId || isDemoMode()) return;
  try {
    await createXanoAdapter().appendEvent(caseId, {
      actor: event.actor,
      event_type: event.event_type,
      message: event.message,
      metadata_json: event.metadata_json ?? null,
    });
  } catch (error) {
    console.warn(
      `[accessform] resolveProgram: event ${event.event_type} not written — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Candidates recorded on a feed event — enough for a timeline, not a dump. */
const MAX_EVENT_CANDIDATES = 8;

/** What the search step did, carried onto the discovery events for the timeline. */
interface SearchTrace {
  /** The templated queries that were (or would have been) sent to SerpApi. */
  queries: string[];
  candidates: ProgramCandidate[];
  searches_used: number;
}

function traceMetadata(trace: SearchTrace): Record<string, unknown> {
  return {
    queries: trace.queries,
    candidates: trace.candidates.slice(0, MAX_EVENT_CANDIDATES),
    searches_used: trace.searches_used,
  };
}

async function recordSearchStarted(caseId: Id | undefined, input: ResolveProgramInput, queries: string[]): Promise<void> {
  await appendCaseEvent(caseId, {
    actor: 'serpapi',
    event_type: 'search_started',
    message: `Searching official sources for ${describeRequest(input)}`,
    metadata_json: { queries },
  });
}

async function recordFound(
  caseId: Id | undefined,
  program: ResolvedProgram,
  organization: string,
  fromCatalog: boolean,
  trace: SearchTrace,
): Promise<void> {
  await appendCaseEvent(caseId, {
    actor: 'serpapi',
    event_type: 'program_discovered',
    message: `Official ${organization} program found`,
    metadata_json: {
      program_id: program.id,
      program_name: program.name,
      application_url: program.application_url,
      policy_url: program.policy_url,
      form_kind: program.form_kind,
      from_catalog: fromCatalog,
      organization,
      source_domain: program.source_domain,
      ...traceMetadata(trace),
    },
  });
  await appendCaseEvent(caseId, {
    actor: 'serpapi',
    event_type: 'source_verified',
    message: `Official source verified: ${program.source_domain}`,
    metadata_json: {
      source_domain: program.source_domain,
      field_count: program.field_count,
      page_count: program.page_count,
      sha256: program.sha256,
    },
  });
}

async function recordNotFound(
  caseId: Id | undefined,
  input: ResolveProgramInput,
  detail: string,
  reason: string,
  trace: SearchTrace,
): Promise<void> {
  await appendCaseEvent(caseId, {
    actor: 'serpapi',
    event_type: 'source_not_verified',
    message: `No verified official source for ${describeRequest(input)}`,
    metadata_json: {
      requested: input.organization ?? '',
      category: input.category,
      location: input.location ?? '',
      detail,
      reason,
      ...traceMetadata(trace),
    },
  });
}

function candidateFromProgram(program: ResolvedProgram, reason: string): ProgramCandidate {
  return {
    title: program.name,
    url: program.application_url,
    source_domain: program.source_domain,
    verified: program.verified,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* 1. Catalog                                                          */
/* ------------------------------------------------------------------ */

interface CatalogOutcome {
  program: ResolvedProgram | null;
  organization_name: string;
  /** The organization's own domain when the catalog knows it. */
  organization_domain: string;
  /** Expected sha256 of the official PDF when the catalog knows it (byte-identity check). */
  expected_sha256: string;
  alternatives: ResolvedProgram[];
  reason: string;
  /** A manifest entry matched the request but has no recorded https URL yet. */
  unresolvable_entry: string;
}

function acceptable(program: ResolvedProgram | null, input: ResolveProgramInput, organizationName: string): boolean {
  if (!program || !program.verified || !isAbsoluteHttps(program.application_url)) return false;
  if (program.category !== input.category) return false;
  if (input.organization) {
    const known = `${organizationName} ${program.name}`;
    if (!organizationMatches(input.organization, known)) return false;
  } else if (input.location && program.region && !regionMatches(input.location, program.region)) {
    return false;
  }
  return true;
}

async function resolveFromCatalog(input: ResolveProgramInput): Promise<CatalogOutcome> {
  const empty: CatalogOutcome = {
    program: null,
    organization_name: '',
    organization_domain: '',
    expected_sha256: '',
    alternatives: [],
    reason: '',
    unresolvable_entry: '',
  };

  // 1a. Xano programs table.
  const xano = await xanoResolveProgram({
    category: input.category,
    location: input.location,
    organization: input.organization,
  });
  if (xano) {
    const organizationName = xano.organization?.name ?? '';
    if (xano.found && acceptable(xano.program, input, organizationName)) {
      return {
        ...empty,
        program: xano.program,
        organization_name: organizationName || input.organization || '',
        organization_domain: xano.organization?.domain ?? '',
        expected_sha256: xano.program?.sha256 ?? '',
        alternatives: xano.alternatives,
      };
    }
    // Xano answered but had nothing acceptable. Still consult the manifest for
    // an organization-domain hint before a live search.
    empty.alternatives = xano.alternatives;
    empty.reason = xano.reason;
  }

  // 1b. Verified manifest (spike/catalog.json).
  const entries = await readCatalogManifest();
  const match: ManifestMatch = matchCatalogEntries(entries, input);
  const alternatives = empty.alternatives.length
    ? empty.alternatives
    : match.alternatives.filter((entry) => isAbsoluteHttps(entry.application_url)).map((entry) => programFromCatalogEntry(entry));

  if (!match.entry) {
    return { ...empty, alternatives, reason: empty.reason || match.reason };
  }
  if (!isAbsoluteHttps(match.entry.application_url)) {
    return {
      ...empty,
      alternatives,
      organization_name: match.entry.organization,
      organization_domain: manifestOrganizationDomain(match.entry),
      expected_sha256: match.entry.sha256,
      reason: `the catalog lists ${match.entry.organization}'s ${match.entry.program} but its official form URL is not recorded yet`,
      unresolvable_entry: match.entry.organization,
    };
  }

  // Persist the manifest entry so the program gets a real id when Xano is live;
  // otherwise serve it with a `catalog:` id (upsert is idempotent by URL).
  const persisted = await xanoUpsertCatalogProgram({ ...catalogRequestForEntry(match.entry), case_id: input.case_id });
  const program = persisted ?? programFromCatalogEntry(match.entry);
  return {
    ...empty,
    program,
    organization_name: match.entry.organization,
    organization_domain: manifestOrganizationDomain(match.entry),
    expected_sha256: match.entry.sha256,
    alternatives,
  };
}

/* ------------------------------------------------------------------ */
/* 3. OpenAI verdict                                                   */
/* ------------------------------------------------------------------ */

interface Verdict {
  url: string;
  is_official_application: boolean;
  organization_matches: boolean;
  form_kind: FormKind;
  organization_name: string;
  organization_kind: OrganizationKind;
  program_name: string;
  reason: string;
}

interface VerdictOutput {
  verdicts: Verdict[];
}

function verdictSchema(urls: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            url: { type: 'string', enum: [...urls] },
            is_official_application: { type: 'boolean' },
            organization_matches: { type: 'boolean' },
            form_kind: { type: 'string', enum: [...FORM_KINDS] },
            organization_name: { type: 'string' },
            organization_kind: { type: 'string', enum: [...ORGANIZATION_KINDS] },
            program_name: { type: 'string' },
            reason: { type: 'string' },
          },
          required: [
            'url',
            'is_official_application',
            'organization_matches',
            'form_kind',
            'organization_name',
            'organization_kind',
            'program_name',
            'reason',
          ],
        },
      },
    },
    required: ['verdicts'],
  };
}

async function judgeCandidates(
  input: ResolveProgramInput,
  candidates: readonly SerpHit[],
): Promise<Verdict[]> {
  if (candidates.length === 0) return [];
  const label = NEED_CATEGORY_LABELS[input.category];
  const target = input.organization
    ? `the organization the caller named: "${input.organization}"${input.location ? ` (caller is in ${input.location})` : ''}`
    : `the official authority responsible for ${label.toLowerCase()} in ${input.location ?? 'the caller\'s region'} (the caller named no organization)`;

  const system = [
    'You judge whether a search result is the OFFICIAL application form for a specific program, for a phone assistant that fills official forms for people with disabilities.',
    'Return JSON only, one verdict per candidate URL, in the given order. Use each URL exactly as given.',
    '',
    'Definitions:',
    '- is_official_application: true only if this URL is (or directly is the download of) the application/eligibility form itself, published by the organization or by an official government registry on its behalf. Policy pages, instructions-only pages, news, third-party guides and aggregators are false.',
    '- organization_matches: true only if the form belongs to the target organization/authority. A different hospital, agency, college or county is false, even if the form looks similar. When the caller named no organization, true means this is the official authority for that category in that place.',
    '- form_kind: fillable_pdf or flat_pdf when the URL is a PDF (guess fillable_pdf unless it is clearly a scan), online_form for a web form, in_person when the page says to apply in person only.',
    '- organization_name: the full official name of the organization that owns the form. organization_kind: its kind.',
    '- program_name: the official name of the program/form, e.g. "ADA Paratransit Eligibility Application".',
    '- reason: one short sentence.',
    'Be strict: when in doubt, answer false.',
  ].join('\n');

  const user = [
    `Category: ${label}`,
    `Target: ${target}`,
    '',
    'Candidates:',
    ...candidates.map(
      (hit, index) =>
        `${index + 1}. url: ${hit.url}\n   domain: ${hit.source_domain}\n   title: ${hit.title}\n   snippet: ${hit.snippet || '(none)'}`,
    ),
  ].join('\n');

  const output = await completeStrictJson<VerdictOutput>({
    model: OPENAI_JUDGMENT_MODEL,
    name: 'official_source_verdicts',
    schema: verdictSchema(candidates.map((hit) => hit.url)),
    system,
    user,
    maxTokens: 1500,
  });
  const allowed = new Set(candidates.map((hit) => hit.url));
  // The schema pins `url` to the enum; post-filter anyway so nothing invented survives.
  return output.verdicts.filter((verdict) => allowed.has(verdict.url));
}

/* ------------------------------------------------------------------ */
/* 2 + 3 + 4 + 5. Live discovery                                        */
/* ------------------------------------------------------------------ */

interface LiveOutcome {
  program: ResolvedProgram | null;
  organization_name: string;
  candidates: ProgramCandidate[];
  searches_used: number;
  /** Queries sent to SerpApi (or the queries the replayed hits came from). */
  queries: string[];
  detail: string;
}

function rankCandidates(hits: readonly SerpHit[], policy: DiscoveryPolicy): SerpHit[] {
  const sources: DiscoveredSource[] = hits.map((hit) => ({
    query: hit.query,
    title: hit.title,
    url: hit.url,
    source_domain: hit.source_domain,
    verified: true,
  }));
  const byUrl = new Map(hits.map((hit) => [hit.url, hit]));
  const ranked = rankSources(sources, policy).map((source) => byUrl.get(source.url)!);
  const score = (hit: SerpHit): number => {
    const title = hit.title.toLowerCase();
    let value = 0;
    if (looksLikePdf(hit.url, hit.title)) value += 2;
    if (title.includes('application') || title.includes('apply')) value += 2;
    if (title.includes('eligibility')) value += 1;
    if (title.includes('instruction') || title.includes('policy')) value -= 1;
    return value;
  };
  return ranked
    .map((hit, index) => ({ hit, index, score: score(hit) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.hit);
}

/** What byte verification established for one accepted candidate. */
interface VerifiedDocument {
  url: string;
  form_kind: FormKind;
  field_count: number;
  page_count: number;
  sha256: string;
  /** The official HTML page the document was linked from, when it was reached that way. */
  page_url: string;
}

/**
 * Verify one accepted candidate. A PDF is verified directly. An official HTML
 * page is followed to its own application PDF (same allowlist, ranked by
 * link text); when it has none and the verdict called it an online form, it
 * is accepted as `online_form`. Returns null with a reason otherwise.
 */
async function verifyCandidate(
  verdict: Verdict,
  policy: DiscoveryPolicy,
): Promise<{ document: VerifiedDocument | null; reason: string }> {
  const inspection = await inspectDocument(verdict.url);
  if (inspection.ok) {
    const finalUrl = inspection.final_url.startsWith('https://') ? inspection.final_url : verdict.url;
    if (!isAllowedDomain(finalUrl, policy)) return { document: null, reason: 'redirected off the official domain' };
    return {
      document: {
        url: finalUrl,
        form_kind: inspection.field_count > 0 ? 'fillable_pdf' : 'flat_pdf',
        field_count: inspection.field_count,
        page_count: inspection.page_count,
        sha256: inspection.sha256,
        page_url: '',
      },
      reason: `PDF verified: ${inspection.field_count} fields, ${inspection.page_count} pages`,
    };
  }
  if (!inspection.is_html) return { document: null, reason: inspection.reason };

  // Official page: look for the application document it links to.
  const pageUrl = inspection.final_url.startsWith('https://') ? inspection.final_url : verdict.url;
  const links = inspection.html && isAllowedDomain(pageUrl, policy)
    ? extractDocumentLinks(inspection.html, pageUrl, policy).filter((link) => link.score > 0)
    : [];
  const tried: string[] = [];
  for (const link of links.slice(0, MAX_PAGE_LINKS)) {
    tried.push(link.url);
    const linked = await inspectDocument(link.url);
    if (!linked.ok) continue;
    const finalUrl = linked.final_url.startsWith('https://') ? linked.final_url : link.url;
    if (!isAllowedDomain(finalUrl, policy)) continue;
    return {
      document: {
        url: finalUrl,
        form_kind: linked.field_count > 0 ? 'fillable_pdf' : 'flat_pdf',
        field_count: linked.field_count,
        page_count: linked.page_count,
        sha256: linked.sha256,
        page_url: pageUrl,
      },
      reason: `official page links the application "${link.text}": ${linked.field_count} fields, ${linked.page_count} pages`,
    };
  }
  if (verdict.form_kind === 'online_form') {
    return {
      document: { url: pageUrl, form_kind: 'online_form', field_count: 0, page_count: 0, sha256: '', page_url: pageUrl },
      reason: 'official page; judged an online form, no PDF application linked',
    };
  }
  return {
    document: null,
    reason: tried.length ? `page links no verifiable application PDF (tried ${tried.length})` : 'HTML page, not an application document',
  };
}

async function discoverLive(
  input: ResolveProgramInput,
  hints: { organization_domain: string; expected_sha256: string; organization_name: string },
  options: ResolveProgramOptions,
): Promise<LiveOutcome> {
  const outcome: LiveOutcome = {
    program: null,
    organization_name: '',
    candidates: [],
    searches_used: 0,
    queries: [],
    detail: '',
  };

  if (isDemoMode()) {
    outcome.detail = 'demo mode: live discovery disabled';
    return outcome;
  }
  if (!hasOpenAiKey()) {
    outcome.detail = 'OPENAI_API_KEY not configured; cannot judge sources';
    return outcome;
  }

  // 2. Search (or replay recorded hits).
  const hits: SerpHit[] = [];
  const seen = new Set<string>();
  if (options.hits) {
    for (const hit of options.hits) {
      if (hit.query && !outcome.queries.includes(hit.query)) outcome.queries.push(hit.query);
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      hits.push(hit);
    }
  } else {
    if (!serpApiKey()) {
      outcome.detail = 'SERPAPI_API_KEY not configured';
      return outcome;
    }
    const budget = getSerpBudget();
    if (budget.remaining <= 0) {
      outcome.detail = `SerpApi run budget spent (${budget.used}/${budget.limit})`;
      return outcome;
    }
    const queries = buildDiscoveryQueries(input).slice(0, Math.min(MAX_LIVE_QUERIES_PER_CALL, budget.remaining));
    outcome.queries = [...queries];
    await recordSearchStarted(input.case_id, input, outcome.queries);
    for (const [index, query] of queries.entries()) {
      if (index > 0) await queryGap();
      try {
        const results = await serpOrganicSearch(query);
        outcome.searches_used += 1;
        for (const hit of results) {
          if (seen.has(hit.url)) continue;
          seen.add(hit.url);
          hits.push(hit);
        }
      } catch (error) {
        outcome.searches_used = getSerpBudget().used - budget.used;
        console.warn(
          `[accessform] resolveProgram: query failed "${query}" — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  if (hits.length === 0) {
    outcome.detail = 'no search results';
    return outcome;
  }

  // Allowlist for THIS request.
  const organizationDomain =
    hints.organization_domain ||
    (input.organization ? inferOrganizationDomain(input.organization, hits.map((hit) => hit.url)) : '');
  const policy = discoveryPolicyFor({ category: input.category, organization_domain: organizationDomain || undefined });

  const allowed = hits.filter((hit) => isAllowedDomain(hit.url, policy));
  outcome.candidates = hits.slice(0, 20).map((hit) => ({
    title: hit.title,
    url: hit.url,
    source_domain: hit.source_domain,
    verified: isAllowedDomain(hit.url, policy),
  }));
  if (allowed.length === 0) {
    outcome.detail = `no results on an official domain (${hits.length} results, org domain ${organizationDomain || 'unknown'})`;
    return outcome;
  }

  // 3. Verdict on the top candidates.
  const shortlist = rankCandidates(allowed, policy).slice(0, MAX_VERDICT_CANDIDATES);
  let verdicts: Verdict[];
  try {
    verdicts = await judgeCandidates(input, shortlist);
  } catch (error) {
    outcome.detail = `source verdict unavailable: ${error instanceof Error ? error.message : String(error)}`;
    return outcome;
  }
  const reasonByUrl = new Map(verdicts.map((verdict) => [verdict.url, verdict.reason]));
  outcome.candidates = outcome.candidates.map((candidate) => ({
    ...candidate,
    ...(reasonByUrl.has(candidate.url) ? { reason: reasonByUrl.get(candidate.url) } : {}),
  }));

  const accepted = verdicts.filter((verdict) => {
    if (!verdict.is_official_application || !verdict.organization_matches) return false;
    // Belt and braces: the model's organization must token-match the caller's.
    if (input.organization && !organizationMatches(input.organization, verdict.organization_name)) return false;
    return true;
  });
  if (accepted.length === 0) {
    outcome.detail = `no candidate judged official for ${describeRequest(input)}`;
    return outcome;
  }

  // 4. Verify bytes. PDFs first; an online form only when no PDF verifies.
  const order = [...accepted].sort((a, b) => {
    const rank = (v: Verdict): number =>
      v.form_kind === 'fillable_pdf' ? 0 : v.form_kind === 'flat_pdf' ? 1 : v.form_kind === 'online_form' ? 2 : 3;
    return rank(a) - rank(b);
  });
  let downloads = 0;
  for (const verdict of order) {
    if (downloads >= MAX_DOWNLOADS) break;
    if (!isAbsoluteHttps(verdict.url)) continue;
    downloads += 1;
    const verified = await verifyCandidate(verdict, policy);
    outcome.candidates = outcome.candidates.map((candidate) =>
      candidate.url === verdict.url ? { ...candidate, reason: verified.reason } : candidate,
    );
    if (!verified.document) continue;
    const document = verified.document;
    const sourceUrl = document.url;
    const formKind = document.form_kind;
    const fieldCount = document.field_count;
    const pageCount = document.page_count;
    const sha256 = document.sha256;

    // 5. Persist (when the M1 endpoints are live) and build the program.
    const organizationName = input.organization && organizationMatches(input.organization, verdict.organization_name)
      ? verdict.organization_name
      : input.organization ?? verdict.organization_name ?? hints.organization_name;
    const sourceDomain = hostOf(sourceUrl);
    const verifiedSources: DiscoveredSource[] = allowed.map((h) => ({
      query: h.query,
      title: h.title,
      url: h.url,
      source_domain: h.source_domain,
      verified: true,
    }));
    const policyUrl =
      pickPolicyUrl(verifiedSources, policy) ||
      (document.page_url && document.page_url !== sourceUrl ? document.page_url : '');
    const request: UpsertCatalogProgramRequest & { case_id?: Id } = {
      organization_name: organizationName,
      organization_kind: verdict.organization_kind ?? kindForCategory(input.category),
      organization_domain: organizationDomain || registrableDomain(sourceDomain),
      name: verdict.program_name || `${NEED_CATEGORY_LABELS[input.category]} application`,
      category: input.category,
      form_kind: formKind,
      application_url: sourceUrl,
      policy_url: policyUrl,
      source_domain: sourceDomain,
      region: input.location ?? '',
      submission_instructions: CATALOG_SUBMISSION_INSTRUCTIONS[registrableDomain(sourceDomain)] ?? '',
      field_count: fieldCount,
      page_count: pageCount,
      sha256,
      verified: true,
      retrieved_at: new Date().toISOString(),
      case_id: input.case_id,
    };
    await xanoUpsertOrganization({
      name: request.organization_name,
      kind: request.organization_kind,
      domain: request.organization_domain,
      region: request.region,
    });
    const persisted = await xanoUpsertCatalogProgram(request);
    const program: ResolvedProgram = persisted ?? {
      id: `discovered:${sha256 || registrableDomain(sourceDomain)}`,
      hospital_id: '',
      name: request.name,
      policy_url: request.policy_url,
      application_url: request.application_url,
      source_domain: request.source_domain,
      effective_date: null,
      retrieved_at: request.retrieved_at ?? new Date().toISOString(),
      verified: true,
      category: request.category,
      form_kind: request.form_kind,
      organization_id: null,
      submission_instructions: request.submission_instructions ?? '',
      field_count: fieldCount,
      region: request.region,
      page_count: pageCount,
      sha256,
    };
    outcome.program = program;
    outcome.organization_name = organizationName;
    outcome.detail = hints.expected_sha256 && sha256
      ? hints.expected_sha256 === sha256
        ? `bytes identical to the catalog-verified PDF (${sha256})`
        : `bytes differ from the catalog-verified PDF (${sha256} vs ${hints.expected_sha256})`
      : `verified ${sourceDomain}: ${formKind}, ${fieldCount} fields — ${verified.reason}`;
    return outcome;
  }

  outcome.detail = 'candidates judged official but none verified as a document';
  return outcome;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export async function resolveProgram(
  rawInput: ResolveProgramInput,
  options: ResolveProgramOptions = {},
): Promise<ProgramResolution> {
  const input: ResolveProgramInput = {
    category: rawInput.category,
    organization: clean(rawInput.organization),
    location: clean(rawInput.location),
    case_id: clean(rawInput.case_id),
  };

  // 1. Catalog — zero searches.
  const catalog = await resolveFromCatalog(input);
  if (catalog.program) {
    const candidates = [
      candidateFromProgram(catalog.program, 'catalog: verified by downloading the PDF and reading its fields'),
    ];
    await recordFound(input.case_id, catalog.program, catalog.organization_name, true, {
      queries: [],
      candidates,
      searches_used: 0,
    });
    return {
      found: true,
      program: catalog.program,
      candidates,
      searches_used: 0,
      from_catalog: true,
    };
  }

  const alternatives = catalog.alternatives.map((program) =>
    candidateFromProgram(program, 'catalog entry for another organization or region'),
  );

  if (!input.organization && !input.location) {
    const reason = 'I need to know which city or county you are in to find the right program.';
    await recordNotFound(input.case_id, input, 'no organization or location', reason, {
      queries: [],
      candidates: alternatives,
      searches_used: 0,
    });
    return { found: false, reason, candidates: alternatives, searches_used: 0, from_catalog: false };
  }

  // 2-5. Live discovery.
  const live = await discoverLive(
    input,
    {
      organization_domain: catalog.organization_domain,
      expected_sha256: catalog.expected_sha256,
      organization_name: catalog.organization_name,
    },
    options,
  );
  if (live.program) {
    console.info(`[accessform] resolveProgram: ${live.detail}`);
    await recordFound(input.case_id, live.program, live.organization_name, false, {
      queries: live.queries,
      candidates: live.candidates,
      searches_used: live.searches_used,
    });
    return {
      found: true,
      program: live.program,
      candidates: live.candidates,
      searches_used: live.searches_used,
      from_catalog: false,
    };
  }

  const detail = [catalog.reason, live.detail].filter(Boolean).join('; ');
  const reason = notFoundReason(input);
  const candidates = live.candidates.length ? live.candidates : alternatives;
  await recordNotFound(input.case_id, input, detail, reason, {
    queries: live.queries,
    candidates,
    searches_used: live.searches_used,
  });
  return {
    found: false,
    reason,
    candidates,
    searches_used: live.searches_used,
    from_catalog: false,
  };
}
