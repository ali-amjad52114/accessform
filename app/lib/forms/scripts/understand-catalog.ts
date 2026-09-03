/**
 * Run understandForm() on every catalog PDF and report counts.
 *
 *   cd app && npx tsx lib/forms/scripts/understand-catalog.ts [--force] [--xano]
 *
 * Reads spike/catalog.json for the local files; the Cedars PDF (no local
 * file in the catalog) is fetched from its verified HCAI URL. Never touches
 * Xano unless --xano is passed (the live Cedars program is the regression).
 *
 * Asserts the Cedars regression from docs/M1_CONTRACT.md §3.3: the 26
 * interview fields come out required with their legacy sections; every
 * other Cedars field is required: false.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CEDARS_APPLICATION_PDF_URL, DEMO_PROGRAM_ID, type CatalogEntry } from '../../contract';
import { CEDARS_REGRESSION_FIELDS } from '../cedars-regression';
import { countFormSchema, understandFormFromBytes, type UnderstoodField } from '../understand-form';
import { loadEnvLocal, repoRoot } from './env';

loadEnvLocal();

const force = process.argv.includes('--force');
const xano = process.argv.includes('--xano') ? 'auto' : 'never';
const onlyArg = process.argv.find((arg) => arg.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).toLowerCase() : null;
const root = repoRoot();

async function bytesFor(entry: CatalogEntry): Promise<Uint8Array | null> {
  if (entry.local_file) return new Uint8Array(readFileSync(path.join(root, entry.local_file)));
  if (entry.application_url === CEDARS_APPLICATION_PDF_URL) {
    const response = await fetch(entry.application_url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cedars PDF fetch failed: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  return null;
}

function cedarsRegression(fields: UnderstoodField[]): string[] {
  const problems: string[] = [];
  const byId = new Map(fields.map((f) => [f.field_id, f]));
  const expected = new Set(CEDARS_REGRESSION_FIELDS.map((f) => f.field_id));
  for (const want of CEDARS_REGRESSION_FIELDS) {
    const got = byId.get(want.field_id);
    if (!got) {
      problems.push(`missing: ${want.field_id}`);
      continue;
    }
    if (!got.required) problems.push(`not required: ${want.field_id}`);
    if (got.section !== want.section) {
      problems.push(`section: ${want.field_id} -> ${got.section} (want ${want.section})`);
    }
  }
  for (const field of fields) {
    if (field.required && !expected.has(field.field_id)) {
      problems.push(`extra required: ${field.field_id} [${field.section}]`);
    }
  }
  return problems;
}

async function main(): Promise<void> {
  const catalog = JSON.parse(readFileSync(path.join(root, 'spike', 'catalog.json'), 'utf8')) as CatalogEntry[];
  let exitCode = 0;
  for (const entry of catalog) {
    if (only && !entry.organization.toLowerCase().includes(only)) continue;
    const bytes = await bytesFor(entry);
    if (!bytes) {
      console.log(`SKIP ${entry.organization}: no local file and no absolute URL`);
      continue;
    }
    const programId = entry.application_url === CEDARS_APPLICATION_PDF_URL ? DEMO_PROGRAM_ID : `catalog:${entry.sha256}`;
    const result = await understandFormFromBytes(programId, bytes, {
      xano,
      force,
      formTitle: `${entry.organization} — ${entry.program}`,
      log: (line) => console.log(`  ${line}`),
    });
    const counts = countFormSchema(result.fields);
    const withDeps = result.fields.filter((f) => f.dependency_rule).length;
    console.log(
      `${entry.organization} | ${entry.program}\n` +
        `  sha256 ${result.sha16} (catalog ${entry.sha256}) pages ${result.page_count} (catalog ${entry.pages})\n` +
        `  fields ${counts.fields} (catalog ${entry.field_count}) asked ${counts.asked} skipped ${counts.skipped} required ${counts.required} dependency_rules ${withDeps}\n` +
        `  sections (${counts.sections.length}): ${counts.sections.join(', ')}\n` +
        `  origin ${result.origin}, model calls ${result.model_calls}`,
    );
    if (result.sha16 !== entry.sha256 || result.field_count !== entry.field_count) {
      console.log('  !! sha256 or field count differs from spike/catalog.json');
      exitCode = 1;
    }
    if (programId === DEMO_PROGRAM_ID) {
      const problems = cedarsRegression(result.fields);
      if (problems.length === 0) {
        console.log('  Cedars regression: OK — 26 required fields with legacy sections, nothing else required');
      } else {
        console.log(`  Cedars regression: ${problems.length} problem(s)`);
        for (const problem of problems) console.log(`    - ${problem}`);
        exitCode = 1;
      }
    }
    if (process.argv.includes('--dump')) {
      for (const f of result.fields) {
        console.log(
          `    ${String(f.order).padStart(3)} [${f.section}] ${f.required ? 'REQ' : '   '} ${f.type.padEnd(9)} ${JSON.stringify(f.field_id)} -> ${f.normalized_key}` +
            (f.options.length ? ` opts=${JSON.stringify(f.options)}` : '') +
            (f.dependency_rule ? ` dep="${f.dependency_rule}"` : '') +
            `\n         Q: ${f.conversational_prompt || '(never asked)'}`,
        );
      }
    }
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
