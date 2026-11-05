import { z } from 'zod';
import type { AgentId, Effort } from '../../shared/events.js';
import { AGENT_IDS } from '../agents/personas.js';
import { generateStructured } from '../llm/stream.js';
import type { Bid } from './gate.js';

export function noveltyThreshold(hop: number): number {
  return hop <= 0 ? 1 : hop === 1 ? 2 : 3;
}

const ClusterSchema = z.object({ clusters: z.array(z.array(z.string())) });

/**
 * Groups responding agents whose gists say substantially the same thing.
 * The prompt contains only `agentId: gist` lines (no transcript, no notes).
 * Any failure degrades to one cluster per agent.
 */
export async function clusterGists(bids: Bid[], signal: AbortSignal): Promise<AgentId[][]> {
  const live = bids.filter((b) => b.should_respond);
  const singletons = (): AgentId[][] => live.map((b) => [b.agentId]);
  if (live.length < 2) return singletons();

  const prompt = [
    'Each line is an agent and the point it intends to make in a group chat.',
    'Group agents whose points say substantially the same thing. Agents with distinct points stay alone, and so do agents citing different facts, numbers or dates on the same topic.',
    'Answer with only a JSON object: {"clusters": [["agentId", ...], ...]} using every agent exactly once.',
    '',
    ...live.map((b) => `${b.agentId}: ${b.gist}`),
  ].join('\n');

  try {
    const { clusters } = await generateStructured({
      role: 'gate',
      system: 'You compare short statements and group the ones that make the same point.',
      prompt,
      schema: ClusterSchema,
      signal,
      meta: { kind: 'dedup' },
    });
    const valid = new Set<AgentId>(live.map((b) => b.agentId));
    const seen = new Set<AgentId>();
    const out: AgentId[][] = [];
    for (const c of clusters) {
      const members: AgentId[] = [];
      for (const id of c) {
        const a = id as AgentId;
        if (valid.has(a) && !seen.has(a)) {
          seen.add(a);
          members.push(a);
        }
      }
      if (members.length) out.push(members);
    }
    for (const b of live) if (!seen.has(b.agentId)) out.push([b.agentId]);
    return out;
  } catch (err) {
    if (!signal.aborted) console.warn('dedup failed, keeping every bid:', err instanceof Error ? err.message : err);
    return singletons();
  }
}

/** The stand-in id for what the chat already holds; shares the clusters schema. */
const ALREADY_SAID = 'already_said';
/** How much of each earlier message later gists are compared with. */
const SAID_CHARS = 600;

const FIGURE = /\$?\d[\d,.]*\d?\s?(?:k\b|m\b|%)?/gi;
const figures = (s: string) => (s.match(FIGURE) ?? []).map((f) => f.toLowerCase().replace(/[\s,]/g, ''));

/** The gist cites a number or date that appears nowhere in what was said. */
export function hasNewFigures(gist: string, said: string[]): boolean {
  const known = new Set(said.flatMap(figures));
  return figures(gist).some((f) => !known.has(f));
}

/**
 * Agents whose gist only repeats something already in the chat. Only later waves
 * need this; the gist is compared with the turn's earlier messages. Any failure
 * means no repeats.
 */
export async function findRepeats(
  bids: Bid[],
  said: string[],
  ask: string,
  signal: AbortSignal,
  returning: ReadonlySet<AgentId> = new Set(),
): Promise<Set<AgentId>> {
  const live = bids.filter((b) => b.should_respond);
  if (live.length === 0 || said.length === 0) return new Set();
  const comeback = live.map((b) => b.agentId).filter((id) => returning.has(id));
  const prompt = [
    `The person asked: «${ask}»`,
    'Each line starting with an agent id is the point that agent intends to make in the group chat.',
    `Lines starting with ${ALREADY_SAID} are already in the chat.`,
    `Group an agent with ${ALREADY_SAID} when its point restates what is there, only agrees with it, only says it does not know, or is news with no bearing on what the person asked. An agent stays alone if it corrects or contradicts that answer, or adds a fact not yet there that the answer depends on, such as what decides an outcome an earlier line left open. Same topic is not the same point.`,
    ...(comeback.length > 0
      ? [`${comeback.join(', ')} already answered, so the bar is higher: group them with ${ALREADY_SAID} unless their point corrects, contradicts or completes the answer. Related news and new detail do not count.`]
      : []),
    'Answer with only a JSON object: {"clusters": [["agentId", ...], ...]} using every agent exactly once.',
    '',
    ...said.map((t) => `${ALREADY_SAID}: ${t.slice(0, SAID_CHARS).replace(/\s+/g, ' ')}`),
    ...live.map((b) => `${b.agentId}: ${b.gist}`),
  ].join('\n');
  try {
    const { clusters } = await generateStructured({
      role: 'gate',
      system: 'You compare short statements and spot the ones that repeat what was already said.',
      prompt,
      schema: ClusterSchema,
      signal,
      meta: { kind: 'dedup' },
    });
    const dup = clusters.find((c) => c.includes(ALREADY_SAID)) ?? [];
    const ids = new Set<string>(live.map((b) => b.agentId));
    return new Set(dup.filter((id): id is AgentId => ids.has(id)));
  } catch (err) {
    if (!signal.aborted) console.warn('repeat check failed, allowing every bid:', err instanceof Error ? err.message : err);
    return new Set();
  }
}

/** Pure and deterministic. See Task 6 brief for the rules. */
export function selectSpeakers(
  bids: Bid[],
  clusters: AgentId[][],
  o: {
    forced: AgentId[];
    hop: number;
    excluded: AgentId[];
    /** Already speaking: wins its cluster over anyone not forced. */
    first?: AgentId;
    /** Tie-breaks when nobody bid: each agent's last message seq, then a hash of `seed`. */
    recency?: Map<AgentId, number>;
    seed?: string;
  },
): { agentId: AgentId; effort: Effort; gist: string }[] {
  const order = (id: AgentId) => AGENT_IDS.indexOf(id);
  const byId = new Map(bids.map((b) => [b.agentId, b]));
  const forced = new Set(o.forced);
  const excluded = new Set(o.excluded);
  const threshold = noveltyThreshold(o.hop);

  // Unlisted agents act as their own cluster.
  const listed = new Set(clusters.flat());
  const groups = [...clusters, ...bids.filter((b) => !listed.has(b.agentId)).map((b) => [b.agentId])];

  const eligible = (id: AgentId) => {
    const b = byId.get(id);
    return !!b && b.should_respond && b.novelty >= threshold && !excluded.has(id);
  };

  const chosen = new Set<AgentId>();
  for (const g of groups) {
    const cands = g.filter((id) => forced.has(id) || eligible(id));
    if (cands.length === 0) continue;
    cands.sort(
      (a, b) =>
        Number(forced.has(b)) - Number(forced.has(a)) ||
        Number(b === o.first) - Number(a === o.first) ||
        (byId.get(b)?.novelty ?? 0) - (byId.get(a)?.novelty ?? 0) ||
        order(a) - order(b),
    );
    chosen.add(cands[0]!);
  }
  for (const id of forced) chosen.add(id); // forced always speak, even if clustered out

  if (chosen.size === 0 && o.hop === 0) {
    const pool = bids.filter((b) => !excluded.has(b.agentId));
    const quiet = (id: AgentId) => o.recency?.get(id) ?? 0;
    const roll = (id: AgentId) => (o.seed === undefined ? order(id) : hash(`${o.seed}:${id}`));
    pool.sort(
      (a, b) =>
        b.novelty - a.novelty ||
        quiet(a.agentId) - quiet(b.agentId) ||
        roll(a.agentId) - roll(b.agentId) ||
        order(a.agentId) - order(b.agentId),
    );
    if (pool[0]) chosen.add(pool[0].agentId);
  }

  return [...chosen]
    .sort((a, b) => order(a) - order(b))
    .map((id) => {
      const b = byId.get(id);
      return { agentId: id, effort: b?.effort ?? 'medium', gist: b?.gist ?? '' };
    });
}

/** FNV-1a. Only needs to spread ties around, not be strong. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
