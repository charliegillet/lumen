// Real-model evals: `npm run eval [-- --case <name>] [--k <n>] [--write]`.
// Loads .env without overriding variables already set in the shell.
try {
  process.loadEnvFile?.();
} catch {
  // no .env: rely on the shell environment
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { modelSpec } from '../src/server/llm/registry.js';
import { CASES, type Case, type CaseResult } from './cases.js';
import { Chat } from './harness.js';

/** Conversation budget per run: past it the chat is stopped and graded as it stands. */
const CASE_TIMEOUT_MS = 90_000;
/** Hard cap including grading, in case a judge hangs. */
const HARD_TIMEOUT_MS = 150_000;
const RESULTS = 'docs/notes/eval-results.md';
const RUNS_DIR = 'evals/runs';
const BEGIN = '<!-- eval:begin -->';
const END = '<!-- eval:end -->';

interface Run extends CaseResult {
  ms: number;
}
interface Summary {
  name: string;
  runs: Run[];
}

function args() {
  const a = process.argv.slice(2);
  const get = (flag: string) => {
    const i = a.indexOf(flag);
    return i >= 0 ? a[i + 1] : undefined;
  };
  const k = Number(get('--k') ?? 3);
  if (!Number.isInteger(k) || k < 1) throw new Error('--k must be a positive integer');
  const only = get('--case');
  return { k, only, write: a.includes('--write') || only === undefined };
}

async function runOnce(c: Case, i: number): Promise<Run> {
  const chats: Chat[] = [];
  const t0 = Date.now();
  const ctx = {
    chat() {
      const ch = new Chat();
      ch.deadline = t0 + CASE_TIMEOUT_MS;
      chats.push(ch);
      return ch;
    },
  };
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CaseResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ pass: false, note: `aborted after ${HARD_TIMEOUT_MS / 1000}s`, failure: 'timed out' }),
      HARD_TIMEOUT_MS,
    );
  });
  let r: CaseResult;
  try {
    r = await Promise.race([c.run(ctx), timeout]);
  } catch (e) {
    r = { pass: false, note: `error: ${e instanceof Error ? e.message : String(e)}`, failure: 'harness error' };
  } finally {
    clearTimeout(timer);
  }
  const ms = Date.now() - t0;
  if (chats.some((ch) => ch.cut)) r = { ...r, note: `${r.note} (conversation cut at ${CASE_TIMEOUT_MS / 1000}s)` };
  mkdirSync(RUNS_DIR, { recursive: true });
  writeFileSync(
    join(RUNS_DIR, `${c.name}-${i + 1}.txt`),
    `${r.pass ? 'PASS' : 'FAIL'} ${r.note}\n${r.failure ?? ''}\n\n${chats.map((ch) => ch.transcript()).join('\n\n=====\n\n')}\n`,
  );
  for (const ch of chats) {
    ch.stop();
    if (r.note.startsWith('aborted')) continue; // background work may still write
    ch.close();
  }
  return { ...r, ms };
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function table(sums: Summary[]): string {
  const rows = sums.map((s) => {
    const passes = s.runs.filter((r) => r.pass).length;
    const score = scoreOf(s);
    const notes = [score, ...s.runs.map((r) => `${r.pass ? 'ok' : 'FAIL'}: ${r.note}`)].filter(Boolean).join(' | ');
    return [s.name, `${passes}/${s.runs.length}`, notes];
  });
  const w0 = Math.max(4, ...rows.map((r) => r[0]!.length));
  return [
    `${pad('case', w0)}  passes  notes`,
    ...rows.map((r) => `${pad(r[0]!, w0)}  ${pad(r[1]!, 6)}  ${r[2]}`),
  ].join('\n');
}

function scoreOf(s: Summary): string {
  const scored = s.runs.filter((r) => r.score);
  if (scored.length === 0) return '';
  const hit = scored.reduce((n, r) => n + r.score!.hit, 0);
  const total = scored.reduce((n, r) => n + r.score!.total, 0);
  return `accuracy ${hit}/${total} (${Math.round((100 * hit) / total)}%)`;
}

function markdown(sums: Summary[], k: number): string {
  const date = new Date().toISOString().slice(0, 10);
  const models = (['agent', 'gate', 'classifier', 'judge'] as const)
    .map((r) => `${r} \`${modelSpec(r)}\``)
    .join(', ');
  const lines = [
    `Latest run: ${date}, k=${k}. Models: ${models}.`,
    '',
    '| case | passes | pass rate | notes |',
    '|---|---|---|---|',
  ];
  const failures: string[] = [];
  for (const s of sums) {
    const passes = s.runs.filter((r) => r.pass).length;
    const rate = Math.round((100 * passes) / s.runs.length);
    const notes = [scoreOf(s), ...s.runs.map((r) => r.note)].filter(Boolean).join('; ').replace(/\|/g, '/');
    lines.push(`| ${s.name} | ${passes}/${s.runs.length} | ${rate}% | ${notes} |`);
    for (const r of s.runs.filter((x) => !x.pass && x.failure).slice(0, 2)) {
      failures.push(`- **${s.name}**: ${r.failure!.replace(/\n/g, ' ')}`);
    }
  }
  lines.push('', 'Representative failures:', '', ...(failures.length ? failures : ['- none']));
  return lines.join('\n');
}

function writeResults(md: string): void {
  const block = `${BEGIN}\n${md}\n${END}`;
  const prev = existsSync(RESULTS) ? readFileSync(RESULTS, 'utf8') : '';
  const next =
    prev.includes(BEGIN) && prev.includes(END)
      ? prev.slice(0, prev.indexOf(BEGIN)) + block + prev.slice(prev.indexOf(END) + END.length)
      : `# Eval results\n\n${block}\n`;
  writeFileSync(RESULTS, next);
}

async function main(): Promise<void> {
  const { k, only, write } = args();
  if (!process.env.OPENAI_API_KEY && modelSpec('agent').startsWith('openai:')) {
    throw new Error('OPENAI_API_KEY is not set (add it to .env)');
  }
  const cases = only ? CASES.filter((c) => c.name === only) : CASES;
  if (cases.length === 0) throw new Error(`unknown case ${only}; cases: ${CASES.map((c) => c.name).join(', ')}`);

  const sums: Summary[] = [];
  for (const c of cases) {
    // The k runs of a case are independent conversations, so they run concurrently.
    const runs = await Promise.all(Array.from({ length: k }, (_, i) => runOnce(c, i)));
    sums.push({ name: c.name, runs });
    const passes = runs.filter((r) => r.pass).length;
    const secs = Math.round(Math.max(...runs.map((r) => r.ms)) / 1000);
    console.log(`${c.name}: ${passes}/${k} (${secs}s)`);
  }
  console.log(`\n${table(sums)}\n`);
  if (write) {
    writeResults(markdown(sums, k));
    console.log(`wrote ${RESULTS}`);
  }
  console.log(`transcripts in ${RUNS_DIR}/`);
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
