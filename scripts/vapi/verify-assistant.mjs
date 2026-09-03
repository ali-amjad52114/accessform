/**
 * Verification: list the account's assistants over the API and confirm the
 * AccessForm one exists with every M1 tool attached.
 *
 *   node scripts/vapi/verify-assistant.mjs
 *
 * Exits non-zero if the assistant is missing, a tool is missing, a tool has
 * no server URL, or discover_program's category enum does not match the
 * config. Also prints the phone numbers so it is obvious that neither has
 * been repointed.
 */

import { ASSISTANT_NAME, NEED_CATEGORIES, TOOL_NAMES } from './assistant.config.mjs';
import { vapi } from './vapi-client.mjs';

const EXPECTED_TOOLS = TOOL_NAMES;

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
  console.log(`  firstMessage : ${JSON.stringify(full.firstMessage ?? '')}`);
  console.log(`  systemPrompt : ${String(full.model?.messages?.[0]?.content ?? '').length} chars`);
  console.log('  tools        :');
  for (const tool of tools) {
    const parameters = tool.function?.parameters ?? {};
    const properties = Object.keys(parameters.properties ?? {});
    const required = parameters.required ?? [];
    const enumSize = parameters.properties?.category?.enum?.length;
    console.log(
      `    - ${tool.function?.name}  url=${tool.server?.url ?? '(none)'}  ` +
        `params=[${properties.join(', ')}]  required=[${required.join(', ')}]` +
        (enumSize ? `  category enum=${enumSize}` : ''),
    );
  }

  const withoutServer = tools.filter((tool) => !tool.server?.url).map((t) => t.function?.name);
  const problems = [];
  if (missing.length) problems.push(`missing tools: ${missing.join(', ')}`);
  if (withoutServer.length) problems.push(`tools without a server URL: ${withoutServer.join(', ')}`);
  const categoryEnum = tools.find((tool) => tool.function?.name === 'discover_program')?.function
    ?.parameters?.properties?.category?.enum;
  if (!categoryEnum || JSON.stringify(categoryEnum) !== JSON.stringify(NEED_CATEGORIES)) {
    problems.push(
      `discover_program category enum is [${(categoryEnum ?? []).join(', ')}], expected [${NEED_CATEGORIES.join(', ')}]`,
    );
  }
  const fieldEnum = tools.find((tool) => tool.function?.name === 'save_answer')?.function?.parameters
    ?.properties?.field_id?.enum;
  if (fieldEnum) {
    problems.push('save_answer field_id still has an enum; M1 validates field_id server-side against form_schema');
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
