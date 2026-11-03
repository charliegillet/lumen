// Model latency spike: TTFT at reasoning none/low + abort check.
// Usage: npm run spike   (needs OPENAI_API_KEY in .env or env)
import { streamText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';

try {
  process.loadEnvFile?.();
} catch {
  /* no .env file */
}

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set. Add it to .env (see .env.example) and re-run `npm run spike`.');
  process.exit(1);
}

const MODEL = (process.env.SPIKE_MODEL ?? process.env.MODEL_AGENT ?? 'openai:gpt-6-luna').replace(/^openai:/, '');
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
const RUNS = 5;
const levels = ['none', 'low'] as const;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

async function once(reasoning: (typeof levels)[number]) {
  const t0 = performance.now();
  let ttft = NaN;
  const result = streamText({
    model: openai(MODEL),
    reasoning,
    prompt: 'In two sentences, explain why the sky is blue.',
  });
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta' && Number.isNaN(ttft)) ttft = performance.now() - t0;
    if (part.type === 'error') throw part.error;
  }
  return { ttft, total: performance.now() - t0 };
}

console.log(`model=${MODEL}`);
console.log('reasoning | median TTFT ms | median total ms');
for (const level of levels) {
  const rs = [];
  for (let i = 0; i < RUNS; i++) rs.push(await once(level));
  const withText = rs.filter((r) => !Number.isNaN(r.ttft));
  const noText = rs.length - withText.length;
  if (withText.length === 0) {
    console.error(`${level}: all ${RUNS} runs produced no text; check model id / key`);
    process.exit(1);
  }
  console.log(
    `${level.padEnd(9)} | ${median(withText.map((r) => r.ttft)).toFixed(0).padStart(14)} | ${median(withText.map((r) => r.total)).toFixed(0).padStart(15)}` +
      (noText ? `  (${noText}/${RUNS} runs produced no text, excluded)` : ''),
  );
}

// Abort check
const ac = new AbortController();
const result = streamText({
  model: openai(MODEL),
  reasoning: 'none',
  prompt: 'Write a very long essay (2000 words) about the history of the bicycle.',
  abortSignal: ac.signal,
  onError: () => {},
});
let afterAbort = 0;
let beforeAbort = 0;
let streamError: unknown;
let aborted = false;
setTimeout(() => {
  ac.abort();
  aborted = true;
}, 1000);
try {
  for await (const part of result.fullStream) {
    if (part.type === 'text-delta') {
      if (aborted) afterAbort++;
      else beforeAbort++;
    } else if (part.type === 'error' && !aborted) {
      streamError = part.error;
    }
  }
} catch (e) {
  if (!aborted) streamError = e;
}
if (streamError) {
  console.error('abort check invalid: request errored before abort:', streamError);
  process.exit(1);
}
if (beforeAbort === 0) {
  console.error('abort check invalid: no text arrived within 1 s before abort');
  process.exit(1);
}
if (afterAbort > 0) {
  console.error(`abort FAILED: ${afterAbort} text deltas after abort`);
  process.exit(1);
}
console.log(`abort ok (${beforeAbort} deltas before abort, 0 after)`);
