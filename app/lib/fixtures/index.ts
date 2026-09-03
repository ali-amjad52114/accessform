/**
 * Deterministic fixture implementations of every adapter.
 *
 * Together they drive the exact Jane demo path end to end — empty case ->
 * discovery -> form extraction -> 26 voice answers -> two missing requirements
 * -> filled, accessibility-processed PDF -> READY_FOR_REVIEW — with no network
 * and no credentials.
 *
 * Nothing in this folder imports `node:*`, so these modules are safe to import
 * from client components as well as from route handlers.
 */

export {
  CACHED_DISCOVERY,
  CACHED_DISCOVERY_SEARCHES_USED,
} from './discovery-cache';

export {
  CEDARS_FORM_FIELDS,
  exportValues,
  findFormField,
} from './cedars-fields';

export {
  FIELD_GROUP_KEYS,
  FIXTURE_FORM_SCHEMA,
  FIXTURE_FORM_SCHEMA_FIELDS,
  FIXTURE_REQUIRED_FIELD_COUNT,
  REQUIREMENT_GROUPS,
  REQUIREMENT_GROUP_KEYS,
  fieldsInGroup,
  resolveField,
  type FieldGroupKey,
  type FixtureFormField,
  type RequirementGroupDefinition,
  type RequirementGroupKey,
} from './form-schema';

export {
  FIXTURE_LATENCY,
  delay,
  getFixtureLatencyScale,
  setFixtureLatencyScale,
} from './latency';

export { FixtureSerpAdapter, cachedDiscovery, fixtureSerpAdapter } from './serp';

export {
  FIXTURE_DISCOVERY,
  FIXTURE_DOCUMENT_URL,
  FixtureXanoAdapter,
  fixtureXanoAdapter,
  markFixtureMilestone,
  peekCase,
  peekEvents,
  resetFixtureStore,
  setFixtureCaseStatus,
  type FixtureSeed,
} from './xano';

export {
  CEDARS_APPLICATION_PAGE_COUNT,
  FIXTURE_EXTRACTED_FIELD_COUNT,
  FixtureNutrientAdapter,
  fixtureNutrientAdapter,
} from './nutrient';

export {
  FixtureVoiceAdapter,
  SIMULATED_TOOL_NAMES,
  fixtureVoiceAdapter,
  type FixtureVoiceAdapterOptions,
} from './voice';

export {
  AFTER_DISCOVERY,
  ANSWER_VALUES,
  CLOSING,
  DOCUMENTS_SECTION,
  OPENING,
  SECTION_INTROS,
  SPOKEN_ANSWERS,
  speakingTimeMs,
  type ScriptedTurn,
} from './transcript';
