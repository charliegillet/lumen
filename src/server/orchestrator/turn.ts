import { randomUUID } from 'node:crypto';
import type { AgentId } from '../../shared/events.js';
import { parseTargets } from '../../shared/targets.js';
import type { ConversationActor } from '../actor.js';
import { AGENT_IDS } from '../agents/personas.js';
import { clusterGists, selectSpeakers } from './dedup.js';
import { runGate, type Bid } from './gate.js';
import { startGeneration, type Generation } from './generation.js';

export const BUDGET = { maxAgentMessages: 7, maxHops: 3, turnTimeoutMs: 90_000 };
/** Per-call cap on one gate or dedup request, so one hung call cannot stall a wave. */
export const GATE_TIMEOUT_MS = 8000;

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

interface Spoken {
  agentId: AgentId;
  messageId: string;
  /** Final persisted text, or null when the message did not complete. */
  text: string | null;
  addresses: Bid['addresses'];
}

/**
 * Runs one human-triggered turn as a series of waves. Each wave: gate the free,
 * unforced agents in parallel, dedup their gists, pick speakers, stream them
 * concurrently and wait for all to finish. Agents @mentioned (or addressed in a
 * bid) by a wave are forced into the next one. Hop, message and time budgets
 * end agent-to-agent exchanges on their own.
 *
 * Starting a new turn aborts the previous turn's signal: that stops its gating
 * and any further waves, but never in-flight generations. Never rejects.
 */
export async function runTurn(
  actor: ConversationActor,
  a: { triggerMessageId: string; forced: AgentId[] },
): Promise<void> {
  actor.turnAbort?.abort();
  const ctrl = new AbortController();
  actor.turnAbort = ctrl;
  try {
    await waves(actor, a.triggerMessageId, a.forced, ctrl.signal);
  } catch (err) {
    if (!isAbort(err)) console.warn(`turn in ${actor.id}: unexpected error`, err);
  } finally {
    if (actor.turnAbort === ctrl) actor.turnAbort = null;
  }
}

async function waves(
  actor: ConversationActor,
  triggerMessageId: string,
  initialForced: AgentId[],
  signal: AbortSignal,
): Promise<void> {
  const turnId = randomUUID();
  const t0 = Date.now();
  const inTime = () => Date.now() - t0 < BUDGET.turnTimeoutMs;
  let hop = 0;
  let forced: AgentId[] = [...new Set(initialForced)];
  let lastWave: AgentId[] = [];
  let lastSpoken: Spoken[] = [];
  let started = 0;

  while (hop <= BUDGET.maxHops && started < BUDGET.maxAgentMessages && inTime() && !signal.aborted) {
    const live = new Set([...actor.generations.values()].map((g) => g.agentId));
    // Forced agents already speaking are skipped for this wave, not queued.
    const forcedNow = forced.filter((id) => !live.has(id));
    const candidates = AGENT_IDS.filter((id) => !live.has(id) && !forced.includes(id));

    const cutoff = actor.lastSeq;
    const bids = await Promise.all(
      candidates.map((id) =>
        runGate(actor, id, cutoff, hop, capped(signal)).catch((err: unknown) => {
          if (signal.aborted) throw err; // the turn itself was aborted
          return declined(id); // timed out: same as staying quiet
        }),
      ),
    );
    if (signal.aborted) return;
    const clusters = await clusterGists(bids, capped(signal)); // swallows aborts and timeouts
    if (signal.aborted || !inTime()) return;

    const selected = selectSpeakers(bids, clusters, {
      forced: forcedNow,
      hop,
      excluded: hop > 0 ? lastWave : [],
    });
    const speakers = cutToBudget(selected, forcedNow, BUDGET.maxAgentMessages - started);
    if (speakers.length === 0) return;

    const wave: { gen: Generation; addresses: Bid['addresses'] }[] = [];
    for (const s of speakers) {
      try {
        const gen = startGeneration(actor, {
          agentId: s.agentId,
          turnId,
          hop,
          replyTo: replyToFor(s.agentId, hop, lastSpoken, triggerMessageId),
          effort: s.effort,
          gist: s.gist,
          othersReplying: speakers.map((o) => o.agentId).filter((id) => id !== s.agentId),
        });
        started++;
        wave.push({ gen, addresses: bids.find((b) => b.agentId === s.agentId)?.addresses ?? [] });
      } catch (err) {
        console.warn(`turn ${turnId}: could not start ${s.agentId}`, err);
      }
    }

    const outcomes = await Promise.allSettled(wave.map((w) => w.gen.done));
    lastSpoken = wave.map((w, i) => {
      const o = outcomes[i];
      const completed = o?.status === 'fulfilled' && o.value === 'completed';
      return {
        agentId: w.gen.agentId,
        messageId: w.gen.messageId,
        text: completed ? (actor.view.messages.find((m) => m.id === w.gen.messageId)?.text ?? '') : null,
        addresses: w.addresses,
      };
    });
    if (signal.aborted) return;

    forced = hop === BUDGET.maxHops ? [] : nextForced(lastSpoken);
    lastWave = wave.map((w) => w.gen.agentId);
    hop++;
    if (wave.length === 0) return;
  }
}

const capped = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(GATE_TIMEOUT_MS)]);

const declined = (agentId: AgentId): Bid => ({
  agentId,
  should_respond: false,
  novelty: 0,
  gist: '',
  addresses: [],
  effort: 'low',
});

/** Keep at most `room` speakers, forced ones first; launch order stays AGENT_IDS order. */
function cutToBudget<T extends { agentId: AgentId }>(speakers: T[], forced: AgentId[], room: number): T[] {
  if (speakers.length <= room) return speakers;
  const isForced = (s: T) => forced.includes(s.agentId);
  const kept = new Set([...speakers.filter(isForced), ...speakers.filter((s) => !isForced(s))].slice(0, room));
  return speakers.filter((s) => kept.has(s));
}

/** Agents a wave's completed messages @mention or address, minus each speaker itself. */
function nextForced(spoken: Spoken[]): AgentId[] {
  const out = new Set<AgentId>();
  for (const s of spoken) {
    if (s.text === null) continue; // stopped or failed messages force no one
    for (const id of parseTargets(s.text).targets) if (id !== s.agentId) out.add(id);
    for (const id of s.addresses) if (id !== 'user' && id !== s.agentId) out.add(id);
  }
  return AGENT_IDS.filter((id) => out.has(id));
}

/** Wave 0 replies to the trigger; later waves to the message that @mentioned the agent. */
function replyToFor(agentId: AgentId, hop: number, prev: Spoken[], trigger: string): string {
  if (hop === 0) return trigger;
  const by = prev.find((s) => s.text !== null && s.agentId !== agentId && parseTargets(s.text).targets.includes(agentId));
  return by?.messageId ?? trigger;
}
