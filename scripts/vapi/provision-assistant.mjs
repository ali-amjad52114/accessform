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
  FIELD_KEYS,
  FIRST_MESSAGE,
  buildAssistantPayload,
} from './assistant.config.mjs';
import { APP_DIR, env, isLocalUrl, serverBaseUrl } from './env.mjs';
import { vapi } from './vapi-client.mjs';

const dryRun = process.argv.includes('--dry-run');

/** The tool enum must match the interview plan the server resolves against. */
function checkFieldKeysMatchFormPlan() {
  const planPath = path.join(APP_DIR, 'lib', 'voice', 'form-plan.ts');
  if (!fs.existsSync(planPath)) {
    console.warn(`! Could not find ${planPath}; skipping the field-key check.`);
    return;
  }
  const source = fs.readFileSync(planPath, 'utf8');
  const keys = [...source.matchAll(/normalizedKey:\s*'([^']+)'/g)].map((match) => match[1]);
  const missing = keys.filter((key) => !FIELD_KEYS.includes(key));
  const extra = FIELD_KEYS.filter((key) => !keys.includes(key));
  if (missing.length || extra.length) {
    throw new Error(
      `Tool field_id enum is out of sync with lib/voice/form-plan.ts.\n` +
        `  missing from assistant.config.mjs: ${missing.join(', ') || '(none)'}\n` +
        `  not in the form plan: ${extra.join(', ') || '(none)'}`,
    );
  }
  console.log(`✓ field_id enum matches lib/voice/form-plan.ts (${keys.length} fields)`);
}

/** The first message the caller hears must match the simulated script. */
function checkFirstMessageMatchesScript() {
  const scriptPath = path.join(APP_DIR, 'lib', 'voice', 'script.ts');
  if (!fs.existsSync(scriptPath)) return;
  const source = fs.readFileSync(scriptPath, 'utf8');
  if (!source.includes(FIRST_MESSAGE)) {
    console.warn('! FIRST_MESSAGE differs from app/lib/voice/script.ts — the demo will drift.');
  } else {
    console.log('✓ first message matches the simulated script');
  }
}

async function main() {
  checkFieldKeysMatchFormPlan();
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
