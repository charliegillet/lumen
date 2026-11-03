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
    'Group agents whose points say substantially the same thing. Agents with distinct points stay alone.',
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
  } catch {
    return singletons();
  }
}

/** Pure and deterministic. See Task 6 brief for the rules. */
export function selectSpeakers(
  bids: Bid[],
  clusters: AgentId[][],
  o: { forced: AgentId[]; hop: number; excluded: AgentId[] },
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
        (byId.get(b)?.novelty ?? 0) - (byId.get(a)?.novelty ?? 0) ||
        order(a) - order(b),
    );
    chosen.add(cands[0]!);
  }
  for (const id of forced) chosen.add(id); // forced always speak, even if clustered out

  if (chosen.size === 0 && o.hop === 0) {
    const pool = bids.filter((b) => !excluded.has(b.agentId));
    pool.sort((a, b) => b.novelty - a.novelty || order(a.agentId) - order(b.agentId));
    if (pool[0]) chosen.add(pool[0].agentId);
  }

  return [...chosen]
    .sort((a, b) => order(a) - order(b))
    .map((id) => {
      const b = byId.get(id);
      return { agentId: id, effort: b?.effort ?? 'medium', gist: b?.gist ?? '' };
    });
}
