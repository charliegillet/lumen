import { randomUUID } from 'node:crypto';
import type { AgentId } from '../../shared/events.js';
import type { MessageView } from '../../shared/reducer.js';
import { parseTargets } from '../../shared/targets.js';
import type { ConversationActor } from '../actor.js';
import { AGENT_IDS } from '../agents/personas.js';
import { reopenGeneration, type Generation } from '../orchestrator/generation.js';
import { runTurn } from '../orchestrator/turn.js';
import { classifySteer, type SteerDecision } from './classify.js';

/** A finished message is rewritten in place when a steer lands this soon after it. */
export const REWRITE_WINDOW_MS = 2000;
/** Finished messages the classifier is shown as context. */
export const RECENT_MS = 10_000;
/** Cap on the classifier call; on timeout it falls back like a failure. */
export const CLASSIFY_TIMEOUT_MS = 6000;

export interface SendInput {
  clientMsgId: string;
  text: string;
  typingStartedAt: number | null;
  /** messageId -> chars the client has displayed */
  rendered: Record<string, number>;
}

/** Steers applied to a generation's current segment, for debouncing. */
interface Pending {
  segment: number;
  mode: 'continue' | 'replace';
  steers: string[];
}
const pending = new WeakMap<Generation, Pending>();
/** Bumped by every stop_all; work queued before a stop must not start after it. */
const stopEpochs = new WeakMap<ConversationActor, number>();
const stopEpoch = (a: ConversationActor) => stopEpochs.get(a) ?? 0;

/**
 * Records the human's message, then (asynchronously, in `settled`) decides
 * whether it stops, steers or simply starts a turn. Resolves right after the
 * user_message append. Every message ends with one steer_resolved, which is
 * what lets clients unfreeze. `settled` never rejects.
 */
export async function handleUserMessage(
  actor: ConversationActor,
  i: SendInput,
): Promise<{ seq: number; settled: Promise<void> }> {
  const dup = actor.findUserMessage(i.clientMsgId);
  if (dup) return { seq: dup.seq, settled: Promise.resolve() };
  const messageId = randomUUID();
  const ev = actor.append({ type: 'user_message', messageId, clientMsgId: i.clientMsgId, text: i.text });
  const settled = handle(actor, messageId, i).catch((err: unknown) => {
    console.warn(`conversation ${actor.id}: handling message ${messageId} failed`, err);
  });
  return { seq: ev.seq, settled };
}

/**
 * Stops every live generation at what the client displayed. Idempotent per
 * clientReqId; with nothing live it appends nothing and returns seq null.
 */
export function handleStop(
  actor: ConversationActor,
  i: { clientReqId: string; rendered: Record<string, number> },
): { seq: number | null } {
  const prior = actor.findStopAll(i.clientReqId);
  if (prior) return { seq: prior.seq };
  const live = [...actor.generations.values()];
  if (live.length === 0) return { seq: null };
  const ev = actor.append({ type: 'stop_all', clientReqId: i.clientReqId });
  stopEpochs.set(actor, stopEpoch(actor) + 1);
  actor.turnAbort?.abort();
  for (const g of live) stopAt(g, i.rendered);
  return { seq: ev.seq };
}

// ---------------------------------------------------------------------------

async function handle(actor: ConversationActor, userMessageId: string, i: SendInput): Promise<void> {
  const epoch = stopEpoch(actor);
  const liveAtSend = [...actor.generations.values()];
  const regex = parseTargets(i.text);
  const targets: AgentId[] = [];
  const waits: Promise<unknown>[] = [];
  let then = null as (() => Promise<void>) | null; // set inside decide()

  const decide = async (): Promise<void> => {
    // 1. Regex stop: immediate, no classifier. A "stop" with nothing to stop
    //    ("wait, what about pricing?") is an ordinary message.
    if (regex.stop) {
      const all = regex.broadcast || regex.targets.length === 0;
      const hit = all ? liveAtSend : liveAtSend.filter((g) => regex.targets.includes(g.agentId));
      if (hit.length > 0) {
        if (all) handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered });
        else for (const g of hit) stopAt(g, i.rendered);
        targets.push(...uniq(hit.map((g) => g.agentId)));
        return;
      }
    }

    // 2. Classify against what the person could see.
    const now = Date.now();
    const d = await classify(actor, i, liveAtSend, now);
    const named = d.targets.length > 0 ? d.targets : regex.targets;

    // 3. Standing instructions are recorded before any restart so its prompt sees them.
    for (const id of d.revokes) actor.append({ type: 'instruction_revoked', instructionId: id });
    if (d.scope === 'standing') {
      actor.append({
        type: 'instruction_set',
        instructionId: randomUUID(),
        scope: named.length === 1 ? named[0]! : 'all',
        text: d.standing_text ?? i.text,
      });
    }
    if (stopEpoch(actor) !== epoch) return; // stopped while classifying: the stop wins

    if (d.kind === 'stop') {
      const live = [...actor.generations.values()];
      const hit = named.length > 0 ? live.filter((g) => named.includes(g.agentId)) : live;
      if (named.length === 0) handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered });
      else for (const g of hit) stopAt(g, i.rendered);
      targets.push(...uniq(hit.map((g) => g.agentId)));
      return;
    }

    if (d.kind === 'steer') {
      let want = named.length > 0 ? named : uniq(liveAtSend.map((g) => g.agentId));
      if (want.length === 0) {
        // Nobody named and nobody was writing: aim at whatever just finished.
        want = AGENT_IDS.filter((id) => justFinished(latestBy(actor, id), i.typingStartedAt, Date.now()));
      }
      if (want.length > 0) {
        const forced: AgentId[] = [];
        for (const id of want) {
          const g = steerAgent(actor, id, d.apply, i);
          if (g) {
            targets.push(id);
            waits.push(g.done);
          } else forced.push(id);
        }
        if (forced.length > 0) {
          then = async () => {
            if (stopEpoch(actor) === epoch) await runTurn(actor, { triggerMessageId: userMessageId, forced });
          };
        }
        return;
      }
    }

    // 4. New message. Never dropped: if the agents who would answer are all
    //    still writing, wait for them, then take a turn.
    const forced = regex.targets;
    const live = [...actor.generations.values()];
    const busy = forced.length > 0 ? live.filter((g) => forced.includes(g.agentId)) : live;
    const mustWait =
      forced.length > 0 ? busy.length > 0 : AGENT_IDS.every((id) => live.some((g) => g.agentId === id));
    then = async () => {
      if (mustWait) await Promise.allSettled(busy.map((g) => g.done));
      if (stopEpoch(actor) === epoch) await runTurn(actor, { triggerMessageId: userMessageId, forced });
    };
  };

  try {
    await decide();
  } finally {
    actor.append({ type: 'steer_resolved', userMessageId, targets });
  }

  await Promise.all([...waits, then?.()]);
}

async function classify(
  actor: ConversationActor,
  i: SendInput,
  liveAtSend: Generation[],
  now: number,
): Promise<SteerDecision> {
  const streaming = liveAtSend
    .filter((g) => actor.generations.has(g.messageId))
    .map((g) => {
      const text = g.textSoFar();
      return { agentId: g.agentId, partial: text.slice(0, shown(i.rendered, g.messageId, text.length)) };
    });
  const recentlyFinished = actor.view.messages.flatMap((m) =>
    m.author.kind === 'agent' && m.status === 'done' && m.completedAt !== null && now - m.completedAt <= RECENT_MS
      ? [{ agentId: m.author.agentId, text: m.text }]
      : [],
  );
  try {
    return await classifySteer(
      { text: i.text, streaming, recentlyFinished, instructions: actor.view.instructions },
      AbortSignal.timeout(CLASSIFY_TIMEOUT_MS),
    );
  } catch {
    // Timed out: same fallback classifySteer uses on failure.
    return {
      kind: streaming.length > 0 ? 'steer' : 'new_message',
      targets: parseTargets(i.text).targets,
      apply: 'continue',
      scope: 'one_off',
      standing_text: null,
      revokes: [],
    };
  }
}

/**
 * Steer one agent: restart its live generation, or rewrite its just-finished
 * message in place. Returns the generation now carrying the steer, or null
 * when neither applies (the caller gives the agent a fresh turn).
 */
function steerAgent(
  actor: ConversationActor,
  agentId: AgentId,
  apply: 'continue' | 'replace',
  i: SendInput,
): Generation | null {
  const live = liveBy(actor, agentId);
  if (live && restartLive(live, apply, i)) return live;

  const m = latestBy(actor, agentId);
  if (!m || !justFinished(m, i.typingStartedAt, Date.now()) || actor.generations.has(m.id)) return null;
  const g = reopenGeneration(actor, m.id, [i.text]);
  pending.set(g, { segment: g.segment, mode: 'replace', steers: [i.text] });
  return g;
}

/**
 * Debounce: while the previous steer's segment has produced nothing yet,
 * a new steer is merged and the segment restarted with all of them.
 */
function restartLive(g: Generation, apply: 'continue' | 'replace', i: SendInput): boolean {
  const p = pending.get(g);
  const merge = p !== undefined && p.segment === g.segment && !g.firstTokenSeen;
  const steers = merge ? [...p.steers, i.text] : [i.text];
  const mode = merge && p.mode === 'replace' ? 'replace' : apply;
  const keep = mode === 'replace' ? 0 : shown(i.rendered, g.messageId, g.textSoFar().length);
  if (!g.restart(mode, keep, steers)) return false;
  pending.set(g, { segment: g.segment, mode, steers });
  return true;
}

// ---------------------------------------------------------------------------

function stopAt(g: Generation, rendered: Record<string, number>): void {
  try {
    g.stop(shown(rendered, g.messageId, g.textSoFar().length));
  } catch (err) {
    console.warn(`generation ${g.messageId}: stop failed`, err); // stop() still ends it
  }
}

/** Chars the client displayed, or `fallback` when it sent nothing usable. */
function shown(rendered: Record<string, number>, messageId: string, fallback: number): number {
  const n = rendered[messageId];
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), fallback) : fallback;
}

function justFinished(m: MessageView | undefined, typingStartedAt: number | null, now: number): boolean {
  if (!m || m.status !== 'done' || m.completedAt === null) return false;
  return now - m.completedAt <= REWRITE_WINDOW_MS || (typingStartedAt !== null && typingStartedAt < m.completedAt);
}

const byId = (a: ConversationActor, id: string) => a.view.messages.find((m) => m.id === id);
const latestBy = (a: ConversationActor, id: AgentId) =>
  a.view.messages.findLast((m) => m.author.kind === 'agent' && m.author.agentId === id);
function liveBy(a: ConversationActor, id: AgentId): Generation | undefined {
  let found: Generation | undefined;
  for (const g of a.generations.values()) if (g.agentId === id) found = g;
  return found;
}
const uniq = <T>(xs: T[]) => [...new Set(xs)];
