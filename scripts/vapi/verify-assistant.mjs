/**
 * Verification: list the account's assistants over the API and confirm the
 * AccessForm one exists with all six tools attached.
 *
 *   node scripts/vapi/verify-assistant.mjs
 *
 * Exits non-zero if the assistant is missing, a tool is missing, or a tool has
 * no server URL. Also prints the phone numbers so it is obvious that neither
 * has been repointed.
 */

import { ASSISTANT_NAME, FIELD_KEYS } from './assistant.config.mjs';
import { vapi } from './vapi-client.mjs';

const EXPECTED_TOOLS = [
  'create_case',
  'discover_program',
  'save_answer',
  'get_case_progress',
  'validate_case',
  'finalize_document',
];

async function main() {
  const assistants = await vapi.assistants();
  console.log(`Assistants in account: ${assistants.length}`);
  for (const assistant of assistants) {
    const tools = (assistant.model?.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
    const marker = assistant.name === ASSISTANT_NAME ? '*' : ' ';
    console.log(
      `${marker} ${assistant.id}  ${JSON.stringify(assistant.name)}  tools=[${tools.join(', ')}]`,
    );
  }

  const match = assistants.find((assistant) => assistant.name === ASSISTANT_NAME);
  if (!match) {
    throw new Error(`No assistant named "${ASSISTANT_NAME}". Run provision-assistant.mjs first.`);
  }

  const full = await vapi.assistant(match.id);
  const tools = full.model?.tools ?? [];
  const names = tools.map((tool) => tool.function?.name);
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));

  console.log(`\nAccessForm assistant ${full.id}`);
  console.log(`  model        : ${full.model?.provider}/${full.model?.model}`);
  console.log(`  voice        : ${full.voice?.provider}/${full.voice?.voiceId}`);
  console.log(`  transcriber  : ${full.transcriber?.provider}/${full.transcriber?.model}`);
  console.log(`  server url   : ${full.server?.url ?? '(none)'}`);
  console.log(`  serverMsgs   : ${(full.serverMessages ?? []).join(', ')}`);
  console.log(`  systemPrompt : ${String(full.model?.messages?.[0]?.content ?? '').length} chars`);
  console.log('  tools        :');
  for (const tool of tools) {
    const parameters = tool.function?.parameters ?? {};
    const properties = Object.keys(parameters.properties ?? {});
    const required = parameters.required ?? [];
    const enumSize = parameters.properties?.field_id?.enum?.length;
    console.log(
      `    - ${tool.function?.name}  url=${tool.server?.url ?? '(none)'}  ` +
        `params=[${properties.join(', ')}]  required=[${required.join(', ')}]` +
        (enumSize ? `  field_id enum=${enumSize}` : ''),
    );
  }

  const withoutServer = tools.filter((tool) => !tool.server?.url).map((t) => t.function?.name);
  const problems = [];
  if (missing.length) problems.push(`missing tools: ${missing.join(', ')}`);
  if (withoutServer.length) problems.push(`tools without a server URL: ${withoutServer.join(', ')}`);
  const fieldEnum = tools.find((tool) => tool.function?.name === 'save_answer')?.function?.parameters
    ?.properties?.field_id?.enum;
  if (!fieldEnum || fieldEnum.length !== FIELD_KEYS.length) {
    problems.push(
      `save_answer field_id enum has ${fieldEnum ? fieldEnum.length : 0} entries, expected ${FIELD_KEYS.length}`,
    );
  }

  const numbers = await vapi.phoneNumbers();
  console.log('\nPhone numbers (unchanged by provisioning):');
  for (const number of numbers) {
    console.log(`  ${number.number}  provider=${number.provider}  assistantId=${number.assistantId ?? '(none)'}`);
  }

  if (problems.length) {
    throw new Error(problems.join('; '));
  }
  console.log(`\n✓ "${ASSISTANT_NAME}" exists with all ${EXPECTED_TOOLS.length} tools attached.`);
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
