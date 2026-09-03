/**
 * Prove the mapper end to end on real PDFs.
 *
 *   cd app && npx tsx lib/forms/scripts/prove-fill.ts <out-dir>
 *
 * 1. Cedars: DEMO_ANSWERS (Jane, 26) -> mapAnswers -> fillAndFlatten (local
 *    engine) -> <out-dir>/cedars_jane_filled.pdf. Asserts 26 values, none
 *    unmapped, no value starting with "$".
 * 2. LA Access Services: 12 plausible paratransit answers, some saved under
 *    keys that are NOT on the schema, -> the same pipeline ->
 *    <out-dir>/la_access_filled.pdf.
 * Render the pages with pypdfium2 afterwards and look at them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CEDARS_APPLICATION_PDF_URL, DEMO_ANSWERS, DEMO_PROGRAM_ID, type Answer, type FormSchemaField } from '../../contract';
import { fillAndFlatten } from '../../document/engine';
import { mapAnswers, toInstantJson } from '../map-answers';
import { understandFormFromBytes } from '../understand-form';
import { loadEnvLocal, repoRoot } from './env';

loadEnvLocal();

const outDir = process.argv[2] ?? path.join(process.cwd(), '.formcache', 'proof');
mkdirSync(outDir, { recursive: true });
const root = repoRoot();

async function cedarsBytes(): Promise<Uint8Array> {
  const cached = path.join(outDir, 'cedars_source.pdf');
  if (existsSync(cached)) return new Uint8Array(readFileSync(cached));
  const response = await fetch(CEDARS_APPLICATION_PDF_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  writeFileSync(cached, bytes);
  return bytes;
}

function answer(fieldId: string, value: string, n: number): Answer {
  return {
    id: `a_${n}`,
    case_id: 'proof',
    field_id: fieldId,
    value_json: value,
    source: 'voice',
    confirmed: true,
    updated_at: new Date(Date.UTC(2026, 8, 3, 12, 0, n)).toISOString(),
  };
}

async function run(
  name: string,
  bytes: Uint8Array,
  programId: string,
  answers: Answer[],
  expectValues: number | null,
): Promise<void> {
  console.log(`\n=== ${name}`);
  const understood = await understandFormFromBytes(programId, bytes, { xano: 'never' });
  const schema: FormSchemaField[] = understood.fields;
  console.log(`schema: ${schema.length} rows (${understood.origin})`);
  const mapped = await mapAnswers({ schema, answers }, { log: (line) => console.log(`  ${line}`) });
  console.log(`mapped ${mapped.values.length} values, unmapped: ${JSON.stringify(mapped.unmapped)}`);
  for (const v of mapped.values) console.log(`  ${JSON.stringify(v.pdf_field_name)} = ${JSON.stringify(v.value)}`);
  const dollar = mapped.values.filter((v) => v.value.includes('$'));
  if (dollar.length > 0) throw new Error(`values with "$": ${JSON.stringify(dollar)}`);
  if (expectValues !== null && mapped.values.length !== expectValues) {
    throw new Error(`expected ${expectValues} values, got ${mapped.values.length}`);
  }
  if (expectValues !== null && mapped.unmapped.length !== 0) {
    throw new Error(`expected nothing unmapped, got ${JSON.stringify(mapped.unmapped)}`);
  }
  const fill = await fillAndFlatten(bytes, toInstantJson(mapped), 'local');
  console.log(`fill: engine ${fill.engine}, written ${fill.fieldsWritten}, skipped ${JSON.stringify(fill.fieldsSkipped)}`);
  const target = path.join(outDir, `${name}.pdf`);
  writeFileSync(target, fill.pdfBytes);
  console.log(`wrote ${target} (${fill.pdfBytes.byteLength} bytes)`);
}

async function main(): Promise<void> {
  await run('cedars_jane_filled', await cedarsBytes(), DEMO_PROGRAM_ID, DEMO_ANSWERS, 26);

  const la = new Uint8Array(readFileSync(path.join(root, 'spike', 'la_access_application_en.pdf')));
  const laAnswers: Answer[] = [
    answer('Last name_1', 'Rivera', 1), // comb: spreads one letter per box
    answer('First name_1', 'Marisol', 2),
    answer('Date of birth', 'March 3, 1959', 3), // -> 03/03/1959
    answer('Home street address', '456 S Vermont Ave', 4),
    answer('City', 'Los Angeles', 5),
    answer('State', 'CA', 6),
    answer('Zip', '90020', 7),
    answer('Primary phone number', '(213) 555-0177', 8),
    answer('Gender', 'female', 9), // option match, case-insensitive
    answer('Is this a permanent disability or health condition', 'yes', 10), // -> "Yes_2"
    answer('mobility_aid', 'I use a walker', 11), // not on the schema -> model places it on the Walker checkbox
    answer('emergency_contact_name', 'Luis Rivera', 12), // saved under the normalized key
  ];
  await run('la_access_filled', la, 'catalog:85ed7b740f964722', laAnswers, null);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
