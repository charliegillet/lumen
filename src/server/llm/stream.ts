import { generateText, streamText, Output, type ModelMessage } from 'ai';
import type { z } from 'zod';
import type { AgentId, Effort } from '../../shared/events.js';
import { modelFor, type Role } from './registry.js';

export const EFFORT: Record<
  Effort,
  { reasoning: 'none' | 'low' | 'medium'; maxOutputTokens: number; lengthHint: string }
> = {
  low: { reasoning: 'none', maxOutputTokens: 300, lengthHint: 'Reply in one or two sentences.' },
  medium: { reasoning: 'low', maxOutputTokens: 900, lengthHint: 'Reply in a short paragraph.' },
  high: { reasoning: 'medium', maxOutputTokens: 3000, lengthHint: 'Give a thorough answer.' },
};

export interface ReqMeta {
  kind: 'reply' | 'gate' | 'dedup' | 'classify' | 'continue' | 'replace' | 'judge';
  agentId?: AgentId;
}

const metaHeaders = (m: ReqMeta): Record<string, string> => ({
  'x-req-kind': m.kind,
  ...(m.agentId ? { 'x-agent-id': m.agentId } : {}),
});

/**
 * Yields text deltas only (reasoning and other parts are dropped). No call site
 * sets temperature/top_p/top_k, so there are no per-model sampling quirks to apply.
 * On abort the iterator throws an AbortError (callers catch it).
 */
export async function* streamChat(a: {
  role: Role;
  agentId?: AgentId;
  system: string;
  messages: ModelMessage[];
  signal: AbortSignal;
  effort: Effort;
  meta: ReqMeta;
}): AsyncIterable<string> {
  const e = EFFORT[a.effort];
  const result = streamText({
    model: modelFor(a.role, a.agentId),
    system: a.system,
    messages: a.messages,
    abortSignal: a.signal,
    reasoning: e.reasoning,
    maxOutputTokens: e.maxOutputTokens,
    headers: metaHeaders(a.meta),
    maxRetries: 0,
    onError: () => {}, // errors surface through fullStream below
  });
  for await (const part of result.fullStream) {
    if (a.signal.aborted) throw abortError();
    if (part.type === 'text-delta') yield part.text;
    else if (part.type === 'error') throw part.error;
    else if (part.type === 'abort') throw abortError();
  }
  if (a.signal.aborted) throw abortError();
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

export async function generateStructured<T>(a: {
  role: Role;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
  meta: ReqMeta;
}): Promise<T> {
  const { output } = await generateText({
    model: modelFor(a.role, a.meta.agentId),
    system: a.system,
    prompt: a.prompt,
    output: Output.object({ schema: a.schema }),
    abortSignal: a.signal,
    headers: metaHeaders(a.meta),
    maxRetries: 0,
  });
  return output as T;
}
