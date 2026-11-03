import { z } from 'zod';
import type { AgentId } from '../../shared/events.js';
import type { ConversationActor } from '../actor.js';
import { buildPrompt } from '../agents/prompt.js';
import { generateStructured } from '../llm/stream.js';

export const BidSchema = z.object({
  should_respond: z.boolean(),
  novelty: z.number().int().min(0).max(3),
  gist: z.string().max(200),
  addresses: z.array(z.enum(['maya', 'theo', 'priya', 'user'])),
  effort: z.enum(['low', 'medium', 'high']),
});
export type Bid = z.infer<typeof BidSchema> & { agentId: AgentId };

const KNOWN = new Set(['maya', 'theo', 'priya', 'user']);

// Lenient on the wire (gist length and unknown addresses are coerced afterwards).
const WireSchema = z.object({
  should_respond: z.boolean(),
  novelty: z.number().int().min(0).max(3),
  gist: z.string(),
  addresses: z.array(z.string()),
  effort: z.enum(['low', 'medium', 'high']),
});

const isAbort = (e: unknown, signal: AbortSignal) =>
  signal.aborted || (e instanceof Error && e.name === 'AbortError');

/** One agent's private bid. Never throws except AbortError; failures mean "stay quiet". */
export async function runGate(
  actor: ConversationActor,
  agentId: AgentId,
  cutoffSeq: number,
  hop: number,
  signal: AbortSignal,
): Promise<Bid> {
  const { system, messages } = buildPrompt(agentId, actor.eventsUpTo(cutoffSeq), cutoffSeq, {
    kind: 'gate',
    hop,
  });
  try {
    const raw = await generateStructured({
      role: 'gate',
      system,
      messages,
      schema: WireSchema,
      signal,
      meta: { kind: 'gate', agentId },
    });
    return {
      agentId,
      should_respond: raw.should_respond,
      novelty: raw.novelty,
      gist: raw.gist.trim().slice(0, 200),
      addresses: raw.addresses.filter((a): a is Bid['addresses'][number] => KNOWN.has(a)),
      effort: raw.effort,
    };
  } catch (e) {
    if (isAbort(e, signal)) {
      throw e instanceof Error && e.name === 'AbortError'
        ? e
        : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    return { agentId, should_respond: false, novelty: 0, gist: '', addresses: [], effort: 'low' };
  }
}
