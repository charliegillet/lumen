import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { serve } from '@hono/node-server';

// Load .env from the project root without overriding variables already set in the shell.
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
  }
}

// Dynamic imports so model registry etc. see the merged environment.
const { openDb } = await import('./db.js');
const { createApp } = await import('./http.js');
const { setFakeScript } = await import('./llm/fake.js');
const { fakeScripts } = await import('./llm/fake-scripts.js');

const dbPath = process.env.DB_PATH ?? './data/chat.db';
const port = Number(process.env.PORT ?? 8080);

const usesFake = ['MODEL_AGENT', 'MODEL_GATE', 'MODEL_CLASSIFIER'].some((k) =>
  process.env[k]?.startsWith('fake:'),
);
if (usesFake) {
  const name = process.env.FAKE_SCRIPT ?? 'default';
  const script = fakeScripts[name];
  if (!script) throw new Error(`unknown FAKE_SCRIPT "${name}"`);
  setFakeScript(script);
}

const { modelProblems } = await import('./llm/registry.js');
const problems = modelProblems();
if (problems.length > 0) {
  console.error(`model configuration is not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  console.error('Fix .env or the environment (see .env.example), or run ./run.sh --fake.');
  process.exit(1);
}

const db = openDb(dbPath);
const server = serve({ fetch: createApp(db).fetch, port }, () => {
  console.log(`listening on http://localhost:${port}`);
});
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE'
      ? `port ${port} is already in use; stop the other process or set PORT to a free port`
      : `server error: ${err.message}`,
  );
  process.exit(1);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
