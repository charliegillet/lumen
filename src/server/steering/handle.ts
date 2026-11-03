import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentId } from '../../shared/events.js';
import type { MessageView } from '../../shared/reducer.js';
import { parseTargets } from '../../shared/targets.js';
import type { ConversationActor } from '../actor.js';
import { AGENT_IDS } from '../agents/personas.js';
import { generateStructured } from '../llm/stream.js';
import { reopenGeneration, type Generation } from '../orchestrator/generation.js';
import { runTurn } from '../orchestrator/turn.js';
import { classifySteer, type SteerDecision } from './classify.js';

/** A finished message is rewritten in place when a steer lands this soon after it. */
export const REWRITE_WINDOW_MS = 2000;
/** Finished messages the classifier is shown as context. */
export const RECENT_MS = 10_000;
/** Caps on the classifier and judge calls; on timeout each falls back like a failure. */
export const CLASSIFY_TIMEOUT_MS = 6000;
export const JUDGE_TIMEOUT_MS = 8000;

export interface SendInput {
  clientMsgId: string;
  text: string;
  typingStartedAt: number | null;
  /** messageId -> chars the client has displayed */
  rendered: Record<string, number>;
}

/** Steers applied to a generation's current segment, for debouncing and the judge. */
interface Pending {
  segment: number;
  mode: 'continue' | 'replace';
  /** The segment's own truncate point; a merged steer reuses it. */
  keep: number;
  steers: string[];
  /** actor.lastSeq right after the segment started. */
  startSeq: number;
}
const pending = new WeakMap<Generation, Pending>();
/** One compliance check per generation, shared by every steer that hit it. */
const judged = new WeakMap<Generation, Promise<void>>();
/**
 * Stop stamps: the seq of the latest stop_all, and per agent the seq of the
 * latest stop that hit it. Queued work (a forced reply after waiting, a reopen,
 * a compliance redo) never starts an agent stopped after its trigger.
 */
interface Stops {
  all: number;
  agent: Map<AgentId, number>;
}
const stopsOf = new WeakMap<ConversationActor, Stops>();
function stops(a: ConversationActor): Stops {
  let s = stopsOf.get(a);
  if (!s) stopsOf.set(a, (s = { all: 0, agent: new Map() }));
  return s;
}
const stoppedAllSince = (a: ConversationActor, seq: number) => stops(a).all > seq;
const stoppedSince = (a: ConversationActor, id: AgentId, seq: number) =>
  stoppedAllSince(a, seq) || (stops(a).agent.get(id) ?? 0) > seq;
/** User messages still waiting for their steer_resolved: messageId -> seq. */
const unresolvedOf = new WeakMap<ConversationActor, Map<string, number>>();
function unresolved(a: ConversationActor): Map<string, number> {
  let m = unresolvedOf.get(a);
  if (!m) unresolvedOf.set(a, (m = new Map()));
  return m;
}

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
  unresolved(actor).set(messageId, ev.seq);
  const settled = handle(actor, messageId, ev.seq, i).catch((err: unknown) => {
    console.warn(`conversation ${actor.id}: handling message ${messageId} failed`, err);
  });
  return { seq: ev.seq, settled };
}

/**
 * Stops every live generation at what the client displayed and aborts the
 * running turn (including one still gating, before anyone speaks).
 * Idempotent per clientReqId. Appends nothing and returns seq null only when
 * nothing is live and no turn is active.
 *
 * clientReqId convention: the Stop button sends its own id; a stop typed as
 * a chat message uses `msg:<clientMsgId>`, so retrying that send is idempotent too.
 */
export function handleStop(
  actor: ConversationActor,
  i: { clientReqId: string; rendered: Record<string, number> },
): { seq: number | null } {
  const prior = actor.findStopAll(i.clientReqId);
  if (prior) return { seq: prior.seq };
  const live = [...actor.generations.values()];
  const turn = actor.turnAbort;
  const turnActive = turn !== null && !turn.signal.aborted;
  if (live.length === 0 && !turnActive) return { seq: null };
  const ev = actor.append({ type: 'stop_all', clientReqId: i.clientReqId });
  stops(actor).all = ev.seq;
  turn?.abort();
  for (const g of live) stopAt(actor, g, i.rendered);
  return { seq: ev.seq };
}

// ---------------------------------------------------------------------------

async function handle(actor: ConversationActor, userMessageId: string, userSeq: number, i: SendInput): Promise<void> {
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
        else for (const g of hit) stopAt(actor, g, i.rendered);
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
    if (stoppedAllSince(actor, userSeq)) return; // stopped while classifying: the stop wins

    if (d.kind === 'stop') {
      const live = [...actor.generations.values()];
      const hit = named.length > 0 ? live.filter((g) => named.includes(g.agentId)) : live;
      if (named.length === 0) handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered });
      else for (const g of hit) stopAt(actor, g, i.rendered);
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
          if (stoppedSince(actor, id, userSeq)) continue; // stopped after this steer was sent
          const g = steerAgent(actor, id, d.apply, i);
          if (g) {
            targets.push(id);
            waits.push(judgeWhenDone(actor, g));
          } else forced.push(id);
        }
        const fresh = forced.filter((id) => startable(actor, id, userSeq));
        if (fresh.length > 0) then = () => runTurn(actor, { triggerMessageId: userMessageId, forced: fresh });
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
      if (stoppedAllSince(actor, userSeq)) return;
      if (forced.length === 0) return runTurn(actor, { triggerMessageId: userMessageId, forced });
      const now = forced.filter((id) => startable(actor, id, userSeq));
      if (now.length > 0) await runTurn(actor, { triggerMessageId: userMessageId, forced: now });
    };
  };

  try {
    await decide();
  } finally {
    unresolved(actor).delete(userMessageId);
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
  if (live && restartLive(actor, live, apply, i)) return live;

  const m = latestBy(actor, agentId);
  if (!m || !justFinished(m, i.typingStartedAt, Date.now()) || actor.generations.has(m.id)) return null;
  const g = reopenGeneration(actor, m.id, [i.text]);
  pending.set(g, { segment: g.segment, mode: 'replace', keep: 0, steers: [i.text], startSeq: actor.lastSeq });
  return g;
}

/**
 * Debounce: while the previous steer's segment has produced nothing yet,
 * a new steer is merged and the segment restarted with all of them, from
 * that segment's own truncate point (the client's newer `rendered` may still
 * count text from before the first steer).
 */
function restartLive(actor: ConversationActor, g: Generation, apply: 'continue' | 'replace', i: SendInput): boolean {
  const p = pending.get(g);
  const merge = p !== undefined && p.segment === g.segment && !g.firstTokenSeen;
  const steers = merge ? [...p.steers, i.text] : [i.text];
  const mode = merge && p.mode === 'replace' ? 'replace' : apply;
  const keep =
    mode === 'replace' ? 0 : merge ? p.keep : shown(i.rendered, g.messageId, g.textSoFar().length);
  if (!g.restart(mode, keep, steers)) return false;
  pending.set(g, { segment: g.segment, mode, keep, steers, startSeq: actor.lastSeq });
  return true;
}

// ---------------------------------------------------------------------------
// Compliance retry

const JudgeSchema = z.object({ complies: z.boolean() });
const JUDGE_SYSTEM = `You check whether a reply in a group chat follows what the person asked for.
Answer complies=false only when the reply clearly ignores or contradicts the request (wrong language, far too long after asking for brevity, missing the asked-for point). When unsure, answer complies=true.
Respond with the JSON object only.`;

function judgeWhenDone(actor: ConversationActor, g: Generation): Promise<void> {
  let w = judged.get(g);
  if (!w) {
    w = judgeAndRetry(actor, g).catch((err: unknown) => {
      console.warn(`generation ${g.messageId}: compliance check failed`, err);
    });
    judged.set(g, w);
  }
  return w;
}

/** After a steered message completes, ask the judge; redo it once (replace) if it ignored the steer. */
async function judgeAndRetry(actor: ConversationActor, g: Generation): Promise<void> {
  if ((await g.done) !== 'completed') return;
  const p = pending.get(g);
  const m = byId(actor, g.messageId);
  if (!p || !m || m.status !== 'done' || m.segment !== p.segment) return;
  if (await complies(p.steers, m.text)) return;

  // Skip the redo if anything moved on meanwhile: the agent was stopped, a
  // human message sent after the segment started is still undecided (it may
  // steer this very message), the agent has a newer message, or this one was
  // reopened.
  const now = byId(actor, g.messageId);
  const undecided = [...unresolved(actor).values()].some((seq) => seq > p.startSeq);
  if (stoppedSince(actor, g.agentId, p.startSeq) || undecided) return;
  if (latestBy(actor, g.agentId)?.id !== g.messageId) return;
  if (!now || now.status !== 'done' || now.segment !== p.segment || actor.generations.has(g.messageId)) return;
  await reopenGeneration(actor, g.messageId, p.steers).done; // final, not judged again
}

async function complies(steers: string[], text: string): Promise<boolean> {
  try {
    const r = await generateStructured({
      role: 'classifier',
      system: JUDGE_SYSTEM,
      prompt: `The person asked: «${steers.join(' / ')}»\n\nThe reply:\n${text}`,
      schema: JudgeSchema,
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      meta: { kind: 'judge' },
    });
    return JudgeSchema.parse(r).complies;
  } catch {
    return true; // a failed judge never blocks or redoes an answer
  }
}

// ---------------------------------------------------------------------------

function stopAt(actor: ConversationActor, g: Generation, rendered: Record<string, number>): void {
  try {
    g.stop(shown(rendered, g.messageId, g.textSoFar().length));
  } catch (err) {
    console.warn(`generation ${g.messageId}: stop failed`, err); // stop() still ends it
  } finally {
    stops(actor).agent.set(g.agentId, actor.lastSeq);
  }
}

/** May queued work for the message at `seq` still start this agent? */
const startable = (a: ConversationActor, id: AgentId, seq: number) => !stoppedSince(a, id, seq);

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
