import { generateText, streamText, Output, type ModelMessage } from 'ai';
import type { z } from 'zod';
import type { AgentId, Effort } from '../../shared/events.js';
import { modelFor, modelSpec, type Role } from './registry.js';

export const EFFORT: Record<
  Effort,
  { reasoning: 'none' | 'low' | 'medium'; maxOutputTokens: number; lengthHint: string }
> = {
  low: { reasoning: 'none', maxOutputTokens: 300, lengthHint: 'Reply in one or two sentences.' },
  medium: { reasoning: 'low', maxOutputTokens: 900, lengthHint: 'Reply in a short paragraph.' },
  high: { reasoning: 'medium', maxOutputTokens: 3000, lengthHint: 'Give a thorough answer.' },
};

type Reasoning = 'none' | 'low' | 'medium';

/**
 * The reasoning effort to send, or undefined to send none: OpenAI-compatible
 * endpoints (`compat:`) may reject reasoning_effort, and MODEL_REASONING=off
 * turns it off everywhere.
 */
export function reasoningFor(spec: string, effort: Reasoning): Reasoning | undefined {
  if (spec.startsWith('compat:') || process.env.MODEL_REASONING === 'off') return undefined;
  return effort;
}

export interface ReqMeta {
  kind: 'reply' | 'gate' | 'dedup' | 'classify' | 'continue' | 'replace' | 'judge';
  agentId?: AgentId;
}

const metaHeaders = (m: ReqMeta): Record<string, string> => ({
  'x-req-kind': m.kind,
  ...(m.agentId ? { 'x-agent-id': m.agentId } : {}),
});

/** Provider retries (429, 5xx, network) before the first token, with backoff that honours retry-after. */
const RETRIES = 2;

/** A stream with no part for this long is treated as hung. */
export const STREAM_IDLE_MS = 25_000;
/** No stream may run longer than this in total. */
export const STREAM_TOTAL_MS = 120_000;
let limitOverride: { idleMs?: number; totalMs?: number } = {};
/** Override the stream limits (tests); call with no argument to restore. Env STREAM_IDLE_MS / STREAM_TOTAL_MS also work. */
export function setStreamTimeouts(o: { idleMs?: number; totalMs?: number } = {}): void {
  limitOverride = o;
}
const envMs = (k: string) => {
  const n = Number(process.env[k]);
  return process.env[k] && Number.isFinite(n) && n > 0 ? n : undefined;
};
function streamLimits(): { idleMs: number; totalMs: number } {
  return {
    idleMs: limitOverride.idleMs ?? envMs('STREAM_IDLE_MS') ?? STREAM_IDLE_MS,
    totalMs: limitOverride.totalMs ?? envMs('STREAM_TOTAL_MS') ?? STREAM_TOTAL_MS,
  };
}

/** Thrown when a provider stream goes silent or runs too long. Not an AbortError, so callers fail the message. */
export class StreamTimeoutError extends Error {
  constructor(what: 'idle' | 'total', ms: number) {
    super(`model stream ${what === 'idle' ? 'sent nothing for' : 'ran longer than'} ${ms} ms`);
    this.name = 'StreamTimeoutError';
  }
}

/**
 * Yields text deltas only (reasoning and other parts are dropped). No call site
 * sets temperature/top_p/top_k, so there are no per-model sampling quirks to apply.
 * On abort the iterator throws an AbortError (callers catch it). A stream with
 * no part for the idle limit, or past the total limit, throws StreamTimeoutError.
 */
export async function* streamChat(a: {
  role: Role;
  agentId?: AgentId;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  effort: Effort;
  /** Skip reasoning whatever the effort: the person is waiting on the first word. */
  fast?: boolean;
  meta: ReqMeta;
}): AsyncIterable<string> {
  const e = EFFORT[a.effort];
  const { idleMs, totalMs } = streamLimits();
  const timeout = new AbortController();
  let timedOut: StreamTimeoutError | null = null;
  const expire = (what: 'idle' | 'total', ms: number) => () => {
    timedOut = new StreamTimeoutError(what, ms);
    timeout.abort(timedOut);
  };
  const total = setTimeout(expire('total', totalMs), totalMs);
  let idle = setTimeout(expire('idle', idleMs), idleMs);
  const reasoning = reasoningFor(modelSpec(a.role, a.agentId), a.fast ? 'none' : e.reasoning);
  const result = streamText({
    model: modelFor(a.role, a.agentId),
    system: a.system,
    messages: wellFormed(a.messages),
    abortSignal: AbortSignal.any([a.signal, timeout.signal]),
    ...(reasoning ? { reasoning } : {}),
    maxOutputTokens: e.maxOutputTokens,
    headers: metaHeaders(a.meta),
    maxRetries: RETRIES,
    onError: () => {}, // errors surface through fullStream below
  });
  // A caller's abort always wins over a timeout that fired at the same moment.
  const check = () => {
    if (a.signal.aborted) throw abortError();
    if (timedOut) throw timedOut;
  };
  try {
    for await (const part of result.fullStream) {
      check();
      clearTimeout(idle);
      idle = setTimeout(expire('idle', idleMs), idleMs);
      if (part.type === 'text-delta') yield part.text;
      else if (part.type === 'error') throw part.error;
      else if (part.type === 'abort') throw abortError();
    }
  } catch (err) {
    check();
    logFailure(a.meta, modelSpec(a.role, a.agentId), err);
    throw err;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
  check();
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** Calls on the steer and turn critical path skip reasoning; the judge keeps the provider default. */
const FAST_KINDS: ReadonlySet<ReqMeta['kind']> = new Set(['gate', 'dedup', 'classify']);

export async function generateStructured<T>(a: {
  role: Role;
  system: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  meta: ReqMeta;
} & ({ prompt: string; messages?: undefined } | { messages: ModelMessage[]; prompt?: undefined })): Promise<T> {
  const input = a.messages ? { messages: wellFormed(a.messages) } : { prompt: a.prompt as string };
  const spec = modelSpec(a.role, a.meta.agentId);
  const reasoning = FAST_KINDS.has(a.meta.kind) ? reasoningFor(spec, 'none') : undefined;
  const t0 = performance.now();
  let ok = false;
  try {
    const { output } = await generateText({
      model: modelFor(a.role, a.meta.agentId),
      system: a.system,
      ...input,
      output: Output.object({ schema: a.schema }),
      abortSignal: a.signal,
      ...(reasoning ? { reasoning } : {}),
      headers: metaHeaders(a.meta),
      maxRetries: RETRIES,
    });
    ok = true;
    return output as T;
  } catch (err) {
    if (!a.signal?.aborted) logFailure(a.meta, spec, err);
    throw err;
  } finally {
    if (a.meta.kind === 'classify') logLatency(spec, t0, ok);
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** Replaces lone UTF-16 surrogates with U+FFFD (String.prototype.toWellFormed, which the TS lib here lacks). */
export const toWellFormed = (t: string): string => t.replace(LONE_SURROGATE, '\ufffd');

/** A lone surrogate in history makes the provider reject every request ("failed to parse JSON"), so fix it here too. */
export function wellFormed(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { ...m, content: toWellFormed(m.content) } as ModelMessage;
    return {
      ...m,
      content: (m.content as { type: string; text?: string }[]).map((p) =>
        p.type === 'text' && typeof p.text === 'string' ? { ...p, text: toWellFormed(p.text) } : p,
      ),
    } as ModelMessage;
  });
}

/** Say why a model call failed; callers fall back silently otherwise. Silent under tests. */
function logFailure(meta: ReqMeta, spec: string, err: unknown): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  const e = err as { name?: string; message?: string; statusCode?: number; cause?: { message?: string } };
  const why = [e?.name, e?.statusCode, e?.message ?? String(err), e?.cause?.message].filter(Boolean).join(' ');
  console.warn(`model call failed kind=${meta.kind}${meta.agentId ? ` agent=${meta.agentId}` : ''} model=${spec}: ${why}`);
}

/** One line per classify call, like the ttft log; silent under tests. */
function logLatency(spec: string, t0: number, ok: boolean): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
  console.info(`classify model=${spec} ok=${ok} ms=${Math.round(performance.now() - t0)}`);
}
