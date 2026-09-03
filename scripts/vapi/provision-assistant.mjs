/**
 * Idempotent provisioning for the AccessForm Vapi assistant.
 *
 *   node scripts/vapi/provision-assistant.mjs
 *   VAPI_SERVER_URL=https://<tunnel> node scripts/vapi/provision-assistant.mjs
 *   node scripts/vapi/provision-assistant.mjs --dry-run
 *
 * Creates the assistant if no assistant with ASSISTANT_NAME exists, otherwise
 * updates that one in place. It never touches the other assistants in the
 * account, and it never repoints a phone number — call routing is a live
 * setting and stays a deliberate manual step.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ASSISTANT_NAME,
  FIRST_MESSAGE,
  NEED_CATEGORIES,
  TOOL_NAMES,
  buildAssistantPayload,
} from './assistant.config.mjs';
import { APP_DIR, env, isLocalUrl, serverBaseUrl } from './env.mjs';
import { vapi } from './vapi-client.mjs';

const dryRun = process.argv.includes('--dry-run');

/** Read a `const NAME = [ 'a', 'b', ... ]` tuple out of the TypeScript contract. */
function readTupleFromContract(source, constName) {
  const match = source.match(new RegExp(`export const ${constName} = \\[([\\s\\S]*?)\\]`));
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

/**
 * The tool names and the category enum must match app/lib/m1/contract.ts
 * (M1_VOICE_TOOL_NAMES, NEED_CATEGORIES) — the server router keys on them and
 * discover_program validates `category` against the same list.
 */
function checkConfigMatchesContract() {
  const contractPath = path.join(APP_DIR, 'lib', 'm1', 'contract.ts');
  if (!fs.existsSync(contractPath)) {
    console.warn(`! Could not find ${contractPath}; skipping the contract check.`);
    return;
  }
  const source = fs.readFileSync(contractPath, 'utf8');
  const problems = [];

  const toolNames = readTupleFromContract(source, 'M1_VOICE_TOOL_NAMES');
  if (!toolNames) {
    problems.push('could not read M1_VOICE_TOOL_NAMES from the contract');
  } else if (JSON.stringify(toolNames) !== JSON.stringify(TOOL_NAMES)) {
    problems.push(
      `TOOL_NAMES differs from M1_VOICE_TOOL_NAMES\n    contract: ${toolNames.join(', ')}\n    config  : ${TOOL_NAMES.join(', ')}`,
    );
  }

  const categories = readTupleFromContract(source, 'NEED_CATEGORIES');
  if (!categories) {
    problems.push('could not read NEED_CATEGORIES from the contract');
  } else if (JSON.stringify(categories) !== JSON.stringify(NEED_CATEGORIES)) {
    problems.push(
      `NEED_CATEGORIES differs from the contract\n    contract: ${categories.join(', ')}\n    config  : ${NEED_CATEGORIES.join(', ')}`,
    );
  }

  const assistantPath = path.join(APP_DIR, 'lib', 'voice', 'assistant.ts');
  if (fs.existsSync(assistantPath) && !fs.readFileSync(assistantPath, 'utf8').includes(`'${ASSISTANT_NAME}'`)) {
    problems.push(`ASSISTANT_NAME "${ASSISTANT_NAME}" is not the name in app/lib/voice/assistant.ts`);
  }

  if (problems.length) {
    throw new Error(`assistant.config.mjs is out of sync with the app:\n  ${problems.join('\n  ')}`);
  }
  console.log(`✓ ${TOOL_NAMES.length} tool names and ${NEED_CATEGORIES.length} categories match app/lib/m1/contract.ts`);
  console.log(`✓ assistant name matches app/lib/voice/assistant.ts`);
}

/** The first message the caller hears should match the simulated script (soft check). */
function checkFirstMessageMatchesScript() {
  const scriptPath = path.join(APP_DIR, 'lib', 'voice', 'script.ts');
  if (!fs.existsSync(scriptPath)) return;
  const source = fs.readFileSync(scriptPath, 'utf8');
  if (!source.includes(FIRST_MESSAGE)) {
    console.warn('! FIRST_MESSAGE differs from app/lib/voice/script.ts — the demo simulation will open differently.');
  } else {
    console.log('✓ first message matches the simulated script');
  }
}

async function main() {
  checkConfigMatchesContract();
  checkFirstMessageMatchesScript();

  const baseUrl = serverBaseUrl();
  const payload = buildAssistantPayload(baseUrl);
  console.log(`\nAssistant : ${ASSISTANT_NAME}`);
  console.log(`Tools     : ${payload.model.tools.map((tool) => tool.function.name).join(', ')}`);
  console.log(`Tool URL  : ${payload.model.tools[0].server.url}`);
  console.log(`Server URL: ${payload.server.url}`);
  if (isLocalUrl(baseUrl)) {
    console.log(
      '\n! The tool URLs point at localhost. Vapi cannot reach that from a real call.\n' +
        '  Browser sessions still work end to end. For phone calls, expose the app\n' +
        '  (cloudflared tunnel --url http://localhost:3000) and re-run with\n' +
        '  VAPI_SERVER_URL=https://<tunnel>.',
    );
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing sent to Vapi.');
    console.log(JSON.stringify(payload, null, 2).slice(0, 1200) + '\n…');
    return;
  }

  const assistants = await vapi.assistants();
  const existing = Array.isArray(assistants)
    ? assistants.filter((assistant) => assistant.name === ASSISTANT_NAME)
    : [];

  let result;
  if (existing.length === 0) {
    console.log('\nNo assistant with that name — creating one.');
    result = await vapi.createAssistant(payload);
  } else {
    if (existing.length > 1) {
      console.warn(
        `! ${existing.length} assistants share the name. Updating the oldest and leaving the rest alone.`,
      );
    }
    const target = existing.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    console.log(`\nUpdating existing assistant ${target.id}.`);
    result = await vapi.updateAssistant(target.id, payload);
  }

  const toolNames = (result.model?.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
  console.log(`\n✓ ${existing.length === 0 ? 'Created' : 'Updated'} ${result.id}`);
  console.log(`  name  : ${result.name}`);
  console.log(`  model : ${result.model?.provider}/${result.model?.model}`);
  console.log(`  voice : ${result.voice?.provider}/${result.voice?.voiceId}`);
  console.log(`  tools : ${toolNames.length} (${toolNames.join(', ')})`);

  if (!env.VAPI_ASSISTANT_ID) {
    console.log(
      `\nOptional: add this to app/.env.local to skip the by-name lookup at runtime:\n` +
        `  VAPI_ASSISTANT_ID=${result.id}`,
    );
  }
  console.log(
    '\nPhone numbers were NOT changed. Both numbers still point at their existing\n' +
      'assistant. Repointing one is a live routing change — do it yourself in the\n' +
      'Vapi dashboard (Phone Numbers -> pick a number -> Assistant -> ' +
      `"${ASSISTANT_NAME}").`,
  );
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exitCode = 1;
});
