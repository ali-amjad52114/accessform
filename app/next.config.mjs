/**
 * Next.js config.
 *
 * `distDir`: several Claude Code sessions run `next dev` in this folder at the
 * same time on different ports. Two dev servers writing the same `.next/`
 * corrupt each other's module graph (symptom: every dynamic route 404s and
 * the log shows "__webpack_modules__[moduleId] is not a function"). A server
 * started with `-p <port>` (any port other than 3000) therefore builds into
 * `.next-<port>/` instead. The default port keeps the default folder so
 * `next build` / `next start` are unaffected.
 */

function devPortFromArgv() {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-p' || argv[i] === '--port') return argv[i + 1];
    if (argv[i].startsWith('--port=')) return argv[i].slice('--port='.length);
  }
  return process.env.PORT ?? null;
}

const port = devPortFromArgv();
const distDir = port && port !== '3000' ? `.next-${port}` : '.next';

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir,
};

export default nextConfig;
