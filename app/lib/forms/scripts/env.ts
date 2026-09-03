/**
 * Minimal .env.local loader for the lib/forms scripts (they run under `npx
 * tsx`, outside Next.js, so nothing else loads the file). Never prints values.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadEnvLocal(): void {
  const candidates = [
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), 'app', '.env.local'),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return;
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Repo root, whether the script runs from app/ or the repo root. */
export function repoRoot(): string {
  const cwd = process.cwd();
  return existsSync(path.join(cwd, 'spike')) ? cwd : path.resolve(cwd, '..');
}
