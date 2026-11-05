import { z } from 'zod';
import type { AgentId } from '../../shared/events.js';
import type { ConversationActor } from '../actor.js';
import { buildPromptFromView } from '../agents/prompt.js';
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

const failedBids = new WeakSet<Bid>();
/** The gate gave no answer, as opposed to answering "no". */
export const isFailedBid = (b: Bid): boolean => failedBids.has(b);
export function markFailedBid(b: Bid): Bid {
  failedBids.add(b);
  return b;
}

/** A model answer the strict schema refused: fenced, prefixed with reasoning, wrong case, novelty out of range. */
export function salvageBid(text: string): z.infer<typeof WireSchema> | null {
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  if (open < 0 || close <= open) return null;
  try {
    const o = JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>;
    const should = o.should_respond;
    const flag = typeof should === 'string' && /^(?:true|false)$/i.test(should) ? should.toLowerCase() === 'true' : should;
    const novelty = Math.round(Number(o.novelty ?? 0));
    const effort = String(o.effort ?? 'medium').toLowerCase();
    return WireSchema.parse({
      should_respond: flag,
      novelty: Number.isFinite(novelty) ? Math.min(3, Math.max(0, novelty)) : 0,
      gist: typeof o.gist === 'string' ? o.gist : '',
      addresses: Array.isArray(o.addresses) ? o.addresses.map((a) => String(a).toLowerCase()) : [],
      effort: effort === 'low' || effort === 'high' ? effort : 'medium',
    });
  } catch {
    return null;
  }
}

const wrongShapeText = (e: unknown): string | null => {
  const t = (e as { text?: unknown } | null)?.text;
  return typeof t === 'string' ? t : null;
};

/** One agent's private bid. Never throws except AbortError; failures mean "stay quiet" and are marked. */
export async function runGate(
  actor: ConversationActor,
  agentId: AgentId,
  cutoffSeq: number,
  hop: number,
  signal: AbortSignal,
): Promise<Bid> {
  const { system, messages } = buildPromptFromView(agentId, actor.viewAt(cutoffSeq), { kind: 'gate', hop });
  try {
    const raw = await generateStructured({
      role: 'gate',
      system,
      messages,
      schema: WireSchema,
      signal,
      meta: { kind: 'gate', agentId },
    });
    return toBid(agentId, raw);
  } catch (e) {
    if (isAbort(e, signal)) {
      throw e instanceof Error && e.name === 'AbortError'
        ? e
        : Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    const text = wrongShapeText(e);
    const salvaged = text === null ? null : salvageBid(text);
    if (salvaged) return toBid(agentId, salvaged);
    console.warn(`gate ${actor.id}/${agentId}: no usable bid, counting it as a miss:`, e instanceof Error ? e.message : e);
    return markFailedBid({ agentId, should_respond: false, novelty: 0, gist: '', addresses: [], effort: 'low' });
  }
}

const toBid = (agentId: AgentId, raw: z.infer<typeof WireSchema>): Bid => ({
  agentId,
  should_respond: raw.should_respond,
  novelty: raw.novelty,
  gist: raw.gist.trim().slice(0, 200),
  addresses: raw.addresses.filter((a): a is Bid['addresses'][number] => KNOWN.has(a)),
  effort: raw.effort,
});
