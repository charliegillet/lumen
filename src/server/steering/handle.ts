import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentId } from '../../shared/events.js';
import type { MessageView } from '../../shared/reducer.js';
import { dropsTopic, parseResume, parseTargets } from '../../shared/targets.js';
import { setActorLoader, type ConversationActor } from '../actor.js';
import { AGENT_IDS } from '../agents/personas.js';
import { generateStructured } from '../llm/stream.js';
import { lastSentenceEnd, reopenGeneration, type Generation } from '../orchestrator/generation.js';
import { runGate } from '../orchestrator/gate.js';
import { smallTalkKind } from '../orchestrator/smalltalk.js';
import { GATE_TIMEOUT_MS, runTurn, type PrefetchedBids } from '../orchestrator/turn.js';
import { classifySteer, type ClassifiedSteer, type SteerDecision } from './classify.js';

/** A finished message is rewritten in place when a steer lands this soon after it. */
export const REWRITE_WINDOW_MS = 2000;
/** Finished messages the classifier is shown as context. */
export const RECENT_MS = 10_000;
/** Caps on the classifier and judge calls; on timeout each falls back like a failure. */
export const CLASSIFY_TIMEOUT_MS = Number(process.env.CLASSIFY_TIMEOUT_MS) || 6000;
export const JUDGE_TIMEOUT_MS = 8000;
/** A message waiting behind a stream gives up on it after this long without a token. */
export const QUEUE_STALL_MS = 3000;
/** ...or after this long, when what is arriving is only a drip. */
export const QUEUE_DRIP_MS = 8000;
const QUEUE_DRIP_CHARS_PER_S = 20;
/** Below this a continuation would restate the opening; a first sentence longer than this gets rewritten instead. */
const MIN_CONTINUE_CHARS = 40;
/** A limit a kept sentence already uses up: no continuation can make the whole message "one sentence". */
const SIZE_LIMIT =
  /\b(?:(?:one|a|single)\s+(?:short\s+|quick\s+)?(?:sentence|line|word)|one[- ]liner|tl;?dr|(?:a\s+)?few\s+words|(?:under|at most|max(?:imum)?(?:\s+of)?)\s+\w+\s+words)\b/i;

export interface SendInput {
  clientMsgId: string;
  text: string;
  typingStartedAt: number | null;
  /**
   * messageId -> chars the client has displayed. When given, a live message
   * missing from it was not on screen at all (0 chars); when absent, the
   * committed text counts as seen.
   */
  rendered?: Record<string, number>;
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
/** Is a user message sent before `seq` still undecided? */
const undecidedBefore = (a: ConversationActor, seq: number) => [...unresolved(a).values()].some((s) => s < seq);
/** Each undecided message's decision, so a correction can wait for what it corrects. */
const decisionsOf = new WeakMap<ConversationActor, Map<string, Promise<void>>>();
function decisions(a: ConversationActor): Map<string, Promise<void>> {
  let m = decisionsOf.get(a);
  if (!m) decisionsOf.set(a, (m = new Map()));
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
  return { seq: ev.seq, settled: track(actor, messageId, ev.seq, ev.at, i) };
}

function track(actor: ConversationActor, messageId: string, seq: number, at: number, i: SendInput): Promise<void> {
  const release = actor.hold(); // in-flight work keeps the actor from being evicted
  return handle(actor, messageId, seq, at, i)
    .catch((err: unknown) => {
      console.warn(`conversation ${actor.id}: handling message ${messageId} failed`, err);
    })
    .finally(release);
}

/** A message this old that a crash left undecided is closed without a reply; nobody is still waiting on it. */
export const RECOVER_REPLY_MS = 5 * 60_000;

/** The last process died while deciding these messages: finish the job, so no instruction or question is lost. */
setActorLoader((actor) => {
  for (const u of actor.undecidedAtBoot) {
    if (Date.now() - u.at > RECOVER_REPLY_MS) {
      actor.append({ type: 'steer_resolved', userMessageId: u.messageId, targets: [] });
      continue;
    }
    unresolved(actor).set(u.messageId, u.seq);
    void track(actor, u.messageId, u.seq, u.at, { clientMsgId: u.clientMsgId, text: u.text, typingStartedAt: null });
  }
});

/**
 * Stops every live generation at what the client displayed and aborts the
 * running turn (including one still gating, before anyone speaks). A user
 * message still being decided counts as work too: the stop stamp makes its
 * queued reply give up once the classifier answers.
 * Idempotent per clientReqId. Appends nothing and returns seq null only when
 * nothing is live, no turn is active and no earlier message is undecided.
 *
 * clientReqId convention: the Stop button sends its own id; a stop typed as
 * a chat message uses `msg:<clientMsgId>`, so retrying that send is idempotent too.
 *
 * `stampSeq` is the seq stop stamps record (default: the stop_all's own). A
 * stop typed as a message passes that message's seq, so messages sent while
 * it was being classified are not treated as stopped.
 */
export function handleStop(
  actor: ConversationActor,
  i: { clientReqId: string; rendered?: Record<string, number> },
  stampSeq?: number,
): { seq: number | null } {
  const prior = actor.findStopAll(i.clientReqId);
  if (prior) return { seq: prior.seq };
  const live = [...actor.generations.values()];
  const turn = actor.turnAbort;
  const turnActive = turn !== null && !turn.signal.aborted;
  const st = stops(actor);
  if (live.length === 0 && !turnActive && !undecidedBefore(actor, stampSeq ?? Infinity)) {
    // Nothing to end now, but a compliance check may be about to redo a finished answer.
    st.all = Math.max(st.all, stampSeq ?? actor.lastSeq);
    return { seq: null };
  }
  const bound = stampSeq ?? Infinity;
  const called = openAsks(actor, bound, stampSeq);
  const ev = actor.append({ type: 'stop_all', clientReqId: i.clientReqId });
  st.all = Math.max(st.all, stampSeq ?? ev.seq);
  // A stop decided late reaches only what existed when it was sent.
  if (stampSeq === undefined || actor.turnTriggerSeq <= stampSeq) turn?.abort();
  for (const g of live) if (g.triggerSeq === undefined || g.triggerSeq <= bound) stopAt(actor, g, i.rendered, stampSeq);
  markDropped(actor, called);
  return { seq: ev.seq };
}

/**
 * What a stop or a change of topic calls off: the messages being written, the
 * question they answer and any steers since. Later turns are told, so an agent
 * does not open with the answer the person just cut off.
 */
function openAsks(actor: ConversationActor, before: number, stampSeq?: number): string[] {
  const live = [...actor.generations.values()].filter((g) => g.triggerSeq === undefined || g.triggerSeq <= before);
  const seqs = live.flatMap((g) => (g.triggerSeq === undefined ? [] : [g.triggerSeq]));
  const turnOn = actor.turnAbort !== null && !actor.turnAbort.signal.aborted && actor.turnTriggerSeq <= before;
  if (turnOn) seqs.push(actor.turnTriggerSeq);
  for (const seq of unresolved(actor).values()) if (seq < before && seq !== stampSeq) seqs.push(seq);
  const from = seqs.length > 0 ? Math.min(...seqs) : Infinity;
  const asks = actor.view.messages.filter((m) => m.author.kind === 'user' && m.startSeq >= from && m.startSeq < before);
  return [...asks.map((m) => m.id), ...live.map((g) => g.messageId)];
}

function markDropped(actor: ConversationActor, messageIds: string[]): void {
  if (messageIds.length > 0) actor.append({ type: 'asks_dropped', messageIds });
}

// ---------------------------------------------------------------------------

/** `sentAt` is the user_message's own time: the rewrite window is measured from it, not from when classification ends. */
async function handle(
  actor: ConversationActor,
  userMessageId: string,
  userSeq: number,
  sentAt: number,
  i: SendInput,
): Promise<void> {
  const liveAtSend = [...actor.generations.values()];
  const regex = parseTargets(i.text);
  const targets: AgentId[] = [];
  const waits: Promise<unknown>[] = [];
  const earlier = [...decisions(actor).values()];
  let then = null as (() => Promise<void>) | null; // set inside decide()
  let prefetch: Prefetch | null = null;

  const decide = async (): Promise<void> => {
    // 1. Regex stop: immediate, no classifier. A bare stop also aborts a turn
    //    that is still gating and earlier messages still being decided. A stop
    //    with nothing to stop is an ordinary message.
    if (regex.stop) {
      const all = regex.broadcast || regex.targets.length === 0;
      const hit = all ? liveAtSend : liveAtSend.filter((g) => regex.targets.includes(g.agentId));
      const turn = actor.turnAbort;
      const busy = (turn !== null && !turn.signal.aborted) || undecidedBefore(actor, userSeq);
      if (all && hit.length === 0 && busy) {
        handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered }, userSeq);
        return;
      }
      if (hit.length > 0) {
        if (all) handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered }, userSeq);
        else for (const g of hit) stopAt(actor, g, i.rendered, userSeq);
        targets.push(...uniq(hit.map((g) => g.agentId)));
        return;
      }
    }

    // 2. "Carry on": pick a stopped answer back up instead of starting a new thread.
    const resume = parseResume(i.text);
    if (resume && resumeStopped(actor, resume.targets, i, userSeq, targets)) return;

    // 3. "Never mind X, ...": the earlier ask is off, whoever was answering it.
    //    What follows is a new message for everyone.
    const dropTopic = dropsTopic(i.text);
    if (dropTopic) supersede(actor, regex.targets, i, userSeq);

    // 4. An @named steer takes effect now; the classifier refines it afterwards.
    const fast = dropTopic ? new Map<AgentId, Generation>() : steerAtOnce(actor, regex.targets, i, userSeq);

    // 5. Nobody writing and nothing just finished: this cannot steer anything, so
    //    the gates can start beside the classifier rather than after it.
    const quiet =
      !dropTopic &&
      !regex.stop &&
      liveAtSend.length === 0 &&
      !AGENT_IDS.some((id) => justFinished(latestBy(actor, id), i.typingStartedAt, sentAt));
    if (quiet || dropTopic) prefetch = startPrefetch(actor, regex.broadcast ? [] : regex.targets, userSeq);

    // 6. Classify against what the person could see.
    let d = await classify(actor, i, liveAtSend, Date.now());
    // A correction can only revoke what is on file, so it waits for what it corrects.
    if (earlier.length > 0 && (d.kind !== 'new_message' || d.scope === 'standing' || d.revokes.length > 0 || !i.text.includes('?'))) {
      const known = actor.view.instructions;
      await Promise.allSettled(earlier);
      if (actor.view.instructions !== known) d = await classify(actor, i, liveAtSend, Date.now());
    }
    const named = d.targets.length > 0 ? d.targets : regex.targets;

    // 7. Standing instructions are recorded before any restart so its prompt sees them.
    applyInstructions(actor, d, named, i.text);
    if (stoppedAllSince(actor, userSeq)) return; // stopped while classifying: the stop wins

    if (d.kind === 'stop' && !dropTopic) {
      const live = [...actor.generations.values()].filter((g) => g.triggerSeq === undefined || g.triggerSeq <= userSeq);
      const hit = named.length > 0 ? live.filter((g) => named.includes(g.agentId)) : live;
      if (named.length === 0) handleStop(actor, { clientReqId: `msg:${i.clientMsgId}`, rendered: i.rendered }, userSeq);
      else for (const g of hit) stopAt(actor, g, i.rendered, userSeq);
      targets.push(...uniq(hit.map((g) => g.agentId)));
      return;
    }

    // An agent already steered keeps that segment, unless the classifier wants a full rewrite.
    for (const [id, g] of fast) {
      if (d.kind === 'steer' && d.apply === 'replace' && pending.get(g)?.mode === 'continue' && actor.generations.has(g.messageId)) {
        restartLive(actor, g, 'replace', i);
      }
      targets.push(id);
      waits.push(judgeWhenDone(actor, g));
    }

    if (d.kind === 'steer' && !dropTopic) {
      let want = named.length > 0 ? named : uniq(liveAtSend.map((g) => g.agentId));
      if (want.length === 0) {
        // Nobody named and nobody was writing: aim at whatever just finished.
        want = AGENT_IDS.filter((id) => justFinished(latestBy(actor, id), i.typingStartedAt, sentAt));
      }
      if (want.length > 0) {
        const forced: AgentId[] = [];
        // Steered messages move below the steer; keep the order they were shown in.
        for (const id of byPosition(actor, want.filter((x) => !fast.has(x)))) {
          if (stoppedSince(actor, id, userSeq)) continue; // stopped after this steer was sent
          const g = steerAgent(actor, id, d.apply, i, sentAt);
          if (g) {
            targets.push(id);
            waits.push(judgeWhenDone(actor, g));
          } else forced.push(id);
        }
        const fresh = forced.filter((id) => startable(actor, id, userSeq));
        if (fresh.length > 0) {
          const bids = takePrefetch();
          then = () => runTurn(actor, { triggerMessageId: userMessageId, forced: fresh, prefetched: bids });
        }
        return;
      }
    }

    // 8. New message. Never dropped: if the agents who would answer are all
    //    still writing, wait for them, then take a turn. A named agent that
    //    already started a message after this one (gated in while we
    //    classified) is answering it already and is not forced again.
    const named0 = regex.broadcast ? [] : regex.targets.filter((id) => !fast.has(id));
    if (regex.targets.length > 0 && !regex.broadcast && named0.length === 0) return; // all steered above
    const forced = named0.filter((id) => !startedAfter(actor, id, userSeq));
    if (named0.length > 0 && forced.length === 0) return;
    const live = [...actor.generations.values()];
    const busy = forced.length > 0 ? live.filter((g) => forced.includes(g.agentId)) : live;
    const mustWait =
      forced.length > 0 ? busy.length > 0 : AGENT_IDS.every((id) => live.some((g) => g.agentId === id));
    // Setting or lifting an instruction is not a question: one short nod, unless it asks something too.
    const ack =
      (d.scope === 'standing' || d.revokes.length > 0) && !regex.broadcast && !i.text.includes('?');
    const bids = takePrefetch();
    then = async () => {
      if (mustWait) await waitBehind(busy);
      if (stoppedAllSince(actor, userSeq)) return;
      if (forced.length === 0) return runTurn(actor, { triggerMessageId: userMessageId, forced, prefetched: bids, ack });
      const now = forced.filter((id) => startable(actor, id, userSeq));
      if (now.length > 0) await runTurn(actor, { triggerMessageId: userMessageId, forced: now, prefetched: bids, ack });
    };
  };

  /** Hands the running bids to the turn; anything not handed over is cancelled below. */
  let taken = false;
  const takePrefetch = (): PrefetchedBids | undefined => {
    taken = true;
    return (prefetch as Prefetch | null)?.bids();
  };

  const deciding = decide();
  decisions(actor).set(
    userMessageId,
    deciding.then(
      () => {},
      () => {},
    ),
  );
  try {
    await deciding;
  } finally {
    decisions(actor).delete(userMessageId);
    if (!taken) (prefetch as Prefetch | null)?.cancel();
    unresolved(actor).delete(userMessageId);
    actor.append({ type: 'steer_resolved', userMessageId, targets });
  }

  await Promise.all([...waits, (then as (() => Promise<void>) | null)?.()]);
  (prefetch as Prefetch | null)?.cancel();
}

// ---------------------------------------------------------------------------
// Gates that run beside the classifier

interface Prefetch {
  bids(): PrefetchedBids;
  cancel(): void;
}

/**
 * Starts this message's gates next to its classifier. Deferred one tick, so a
 * stop that lands in the same breath costs no model calls.
 */
function startPrefetch(actor: ConversationActor, named: AgentId[], userSeq: number): Prefetch {
  const ctrl = new AbortController();
  const ids = named.length > 0 ? named : AGENT_IDS;
  const running: PrefetchedBids = new Map();
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(GATE_TIMEOUT_MS)]);
  const go = () => {
    if (ctrl.signal.aborted || running.size > 0 || stoppedAllSince(actor, userSeq)) return;
    const cutoff = actor.lastSeq;
    for (const id of ids) {
      const bid = runGate(actor, id, cutoff, 0, signal);
      void bid.catch(() => {});
      running.set(id, bid);
    }
  };
  const tick = setImmediate(go);
  return {
    bids: () => {
      clearImmediate(tick);
      go();
      return running;
    },
    cancel: () => {
      clearImmediate(tick);
      ctrl.abort();
    },
  };
}

// ---------------------------------------------------------------------------

/** Waits for streams a new message queued behind, giving up on any that has hung or barely moves. */
async function waitBehind(busy: Generation[]): Promise<void> {
  const t0 = Date.now();
  const from = new Map(busy.map((g) => [g, g.textSoFar().length]));
  const watch = setInterval(() => {
    const now = Date.now();
    for (const g of busy) {
      if (!g.isLive()) continue;
      const moved = g.textSoFar().length - (from.get(g) ?? 0);
      const dripping = now - t0 >= QUEUE_DRIP_MS && moved < ((now - t0) / 1000) * QUEUE_DRIP_CHARS_PER_S;
      // A stream still reasoning towards its first word gets longer before it counts as hung.
      const patience = g.firstTokenSeen ? QUEUE_STALL_MS : QUEUE_STALL_MS * 3;
      if (now - g.lastActivityAt >= patience || dripping) g.abandon('stalled with a message waiting behind it');
    }
  }, 250);
  try {
    await Promise.allSettled(busy.map((g) => g.done));
  } finally {
    clearInterval(watch);
  }
}

/** "@Maya ..." at a streaming Maya: restart her now rather than after the classifier. */
function steerAtOnce(
  actor: ConversationActor,
  named: AgentId[],
  i: SendInput,
  userSeq: number,
): Map<AgentId, Generation> {
  const out = new Map<AgentId, Generation>();
  const text = i.text;
  // Questions and chatter may be aimed at her without being about this answer; standing rules must be on file first.
  if (text.includes('?') || smallTalkKind(text) !== null || PRAISE.test(text) || STANDING_WORDS.test(text)) return out;
  const atNamed = named.filter((id) => new RegExp(`@${id}(?![\\w'])`, 'i').test(text));
  for (const id of byPosition(actor, atNamed)) {
    const g = liveBy(actor, id);
    if (!g || stoppedSince(actor, id, userSeq)) continue;
    if (restartLive(actor, g, REWRITE_WORDS.test(text) ? 'replace' : 'continue', i)) out.set(id, g);
  }
  return out;
}
const PRAISE = /\b(?:good|great|nice|love|agree|thanks|thank you|lol|haha)\b/i;
const REWRITE_WORDS =
  /\b(?:french|spanish|german|english|italian|japanese|chinese|language|translate|bullets?|table|format|instead|actually|rather|wrong|start over|redo|rewrite)\b/i;

/** "@Theo carry on" or plain "carry on": the stopped answers continue where they were cut. Returns whether any did. */
function resumeStopped(
  actor: ConversationActor,
  named: AgentId[],
  i: SendInput,
  userSeq: number,
  targets: AgentId[],
): boolean {
  let any = false;
  for (const id of byPosition(actor, named.length > 0 ? named : AGENT_IDS)) {
    const m = latestBy(actor, id);
    if (!m || m.status !== 'stopped' || m.text === '' || liveBy(actor, id) || stoppedSince(actor, id, userSeq)) continue;
    // Unnamed, only what a stop for everyone cut; named, that agent's own stopped answer.
    if (named.length === 0 && !m.dropped) continue;
    reopenGeneration(actor, m.id, [i.text], { moved: true, resume: true });
    targets.push(id);
    any = true;
  }
  return any;
}

/** The person moved on: end what is being written for the old ask and everything queued behind it. */
function supersede(actor: ConversationActor, named: AgentId[], i: SendInput, userSeq: number): void {
  const live = [...actor.generations.values()];
  const hit = named.length > 0 ? live.filter((g) => named.includes(g.agentId)) : live;
  const called = openAsks(actor, userSeq, userSeq);
  const previous = [...actor.view.messages].reverse().find((m) => m.author.kind === 'user' && m.startSeq < userSeq);
  if (named.length === 0) {
    const st = stops(actor);
    st.all = Math.max(st.all, userSeq);
    actor.turnAbort?.abort();
  }
  for (const g of hit) stopAt(actor, g, i.rendered, userSeq);
  markDropped(actor, uniq([...called, ...(previous ? [previous.id] : [])]));
}

/**
 * Records a message's instruction effects. A message aimed at named agents never
 * lifts a rule meant for everyone: those agents get their own rule, and the rest
 * of the group keeps following the old one.
 */
function applyInstructions(actor: ConversationActor, d: SteerDecision, named: AgentId[], text: string): void {
  const scopeOf = new Map(actor.view.instructions.map((r) => [r.id, r.scope]));
  let overridden = false;
  for (const id of d.revokes) {
    if (named.length > 0 && named.length < AGENT_IDS.length && scopeOf.get(id) === 'all') overridden = true;
    else actor.append({ type: 'instruction_revoked', instructionId: id });
  }
  if (d.scope !== 'standing' && !overridden) return;
  const rule = d.standing_text ?? text;
  const scopes: (AgentId | 'all')[] = named.length > 0 && named.length < AGENT_IDS.length ? named : ['all'];
  for (const scope of scopes) actor.append({ type: 'instruction_set', instructionId: randomUUID(), scope, text: rule });
}

/** Wording that marks a standing instruction even when the classifier could not say so. */
const STANDING_WORDS = /\b(from now on|going forward|for the rest of|always|never again|from here on)\b/i;
/** Language and format asks hold for the conversation when the classifier cannot say otherwise. */
const STANDING_STYLE = /\b(?:answer|reply|respond|write|speak)\s+(?:only\s+)?in\s+(?:french|spanish|german|italian|japanese|chinese|english|bullets?|bullet points)\b/i;
/** Without a classifier, only a name or an imperative opener counts as a steer. */
const IMPERATIVE =
  /^(?:please\s+|just\s+|now\s+)?(?:make|keep|be|focus|shorten|expand|summari[sz]e|use|write|answer|reply|respond|switch|translate|add|include|mention|cover|drop|skip|remove|avoid|try|rewrite|redo|wrap|finish|talk|speak|give|explain|list|shorter|longer|briefly|simpler)\b/i;

/**
 * A failed or timed-out classifier falls back to one_off, which would drop a
 * standing instruction; explicit standing wording keeps it standing. Only
 * fallbacks are touched: a real one_off answer ("do we always…?") stands.
 */
export function keepStanding(d: ClassifiedSteer, text: string): ClassifiedSteer {
  if (!d.fallback || d.scope !== 'one_off' || !(STANDING_WORDS.test(text) || STANDING_STYLE.test(text))) return d;
  return { ...d, scope: 'standing', standing_text: text };
}

/** With no classifier answer, chatter sent mid-stream must not restart everyone. */
function fallbackKind(d: ClassifiedSteer, text: string): ClassifiedSteer {
  if (!d.fallback || d.kind !== 'steer') return d;
  if (parseTargets(text).targets.length > 0 || IMPERATIVE.test(text.trim())) return d;
  return { ...d, kind: 'new_message' };
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
  const input = { text: i.text, streaming, recentlyFinished, instructions: actor.view.instructions };
  const deadline = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS);
  try {
    let d = await classifySteer(input, deadline);
    if (d.fallback) {
      console.warn(`conversation ${actor.id}: classifier failed, retrying once`);
      d = await classifySteer(input, deadline);
    }
    return fallbackKind(keepStanding(d, i.text), i.text);
  } catch {
    console.warn(`conversation ${actor.id}: classifier timed out, using the fallback`);
    // Timed out: same fallback classifySteer uses on failure.
    return fallbackKind(
      keepStanding(
        {
          kind: streaming.length > 0 ? 'steer' : 'new_message',
          targets: parseTargets(i.text).targets,
          apply: 'continue',
          scope: 'one_off',
          standing_text: null,
          revokes: [],
          fallback: true,
        },
        i.text,
      ),
      i.text,
    );
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
  sentAt: number,
): Generation | null {
  const live = liveBy(actor, agentId);
  if (live && restartLive(actor, live, apply, i)) return live;

  const m = latestBy(actor, agentId);
  if (!m || !justFinished(m, i.typingStartedAt, sentAt) || actor.generations.has(m.id)) return null;
  const g = reopenGeneration(actor, m.id, [i.text], { moved: true });
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
  // The steer that got here first (the same message, refined by the classifier) is not a second steer.
  const steers = merge ? uniq([...p.steers, i.text]) : [i.text];
  const seam = merge ? { mode: apply, keep: p.keep } : seamFor(apply, g, i);
  const kept = g.textSoFar().slice(0, seam.keep);
  const tooLong = lastSentenceEnd(kept) > 0 && steers.some((x) => SIZE_LIMIT.test(x));
  const mode = tooLong || (merge && p.mode === 'replace') ? 'replace' : seam.mode;
  const keep = mode === 'replace' ? 0 : seam.keep;
  if (!g.restart(mode, keep, steers, { moved: true })) return false;
  pending.set(g, { segment: g.segment, mode, keep, steers, startSeq: actor.lastSeq });
  return true;
}

/**
 * Where a continuation picks up. It joins at the end of the last finished
 * sentence, so it never has to mend a half sentence; if the first sentence is
 * still unfinished well into the answer, a rewrite reads better than a seam.
 */
function seamFor(apply: 'continue' | 'replace', g: Generation, i: SendInput): { mode: 'continue' | 'replace'; keep: number } {
  if (apply === 'replace') return { mode: 'replace', keep: 0 };
  const seen = g.textSoFar().slice(0, shown(i.rendered, g.messageId, g.textSoFar().length));
  const end = lastSentenceEnd(seen);
  if (end > 0) return { mode: 'continue', keep: end };
  return seen.length >= MIN_CONTINUE_CHARS ? { mode: 'replace', keep: 0 } : { mode: 'continue', keep: seen.length };
}

// ---------------------------------------------------------------------------
// Compliance retry

const JudgeSchema = z.object({ complies: z.boolean() });
const JUDGE_SYSTEM = `You check whether a reply in a group chat follows what the person asked for.
Answer complies=false only for a hard miss: the wrong language, far too long after asking for brevity, or a requested format plainly not used. Declining to share confidential material complies. A style or emphasis judgment call complies. When unsure, answer complies=true.
Respond with the JSON object only.`;
/** Asked to be brief: a redo that comes back longer is worse than what it replaced. */
const BREVITY = /\b(?:shorter|brief(?:ly)?|one (?:short )?(?:sentence|line|word)|one-liner|tl;?dr|concise|quick(?:ly)?|few words|under \w+ words)\b/i;

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
  // Someone has already replied to this text; rewriting it now would pull the rug from under them.
  if (repliedTo(actor, g.messageId)) return;
  if (!now || now.status !== 'done' || now.segment !== p.segment || actor.generations.has(g.messageId)) return;
  // Not caused by a new user message: the answer stays where it is.
  const before = now.text;
  await reopenGeneration(actor, g.messageId, p.steers, { moved: false }).done; // final, not judged again
  const after = byId(actor, g.messageId);
  if (after?.status === 'done' && after.text.length > before.length && p.steers.some((x) => BREVITY.test(x))) {
    putBack(actor, after, before);
  }
}

/** Lays earlier text back over a finished message, in a segment of its own. */
function putBack(actor: ConversationActor, m: MessageView, text: string): void {
  const segment = m.segment + 1;
  actor.append({
    type: 'message_segment_started',
    messageId: m.id,
    segment,
    contextCutoffSeq: actor.lastSeq,
    truncateTo: 0,
    mode: 'replace',
  });
  actor.append({ type: 'token_delta', messageId: m.id, segment, offset: 0, text });
  actor.append({ type: 'message_completed', messageId: m.id });
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

/** `stampSeq` as in handleStop; defaults to the log head after the stop. */
function stopAt(
  actor: ConversationActor,
  g: Generation,
  rendered: Record<string, number> | undefined,
  stampSeq?: number,
): void {
  try {
    g.stop(shown(rendered, g.messageId, g.textSoFar().length));
  } catch (err) {
    console.warn(`generation ${g.messageId}: stop failed`, err); // stop() still ends it
  } finally {
    const agent = stops(actor).agent;
    agent.set(g.agentId, Math.max(agent.get(g.agentId) ?? 0, stampSeq ?? actor.lastSeq));
  }
}

/** Has this agent started a message after `seq`? */
const startedAfter = (a: ConversationActor, id: AgentId, seq: number) =>
  a.view.messages.some((m) => m.author.kind === 'agent' && m.author.agentId === id && m.startSeq > seq);
/** May queued work for the message at `seq` still start this agent? */
const startable = (a: ConversationActor, id: AgentId, seq: number) =>
  !stoppedSince(a, id, seq) && !startedAfter(a, id, seq);

/**
 * Chars the client displayed, at most `fallback` (the committed length). A
 * client that sent a `rendered` map without this message had not shown any of
 * it (e.g. it had not received message_started yet): 0. Only a request with no
 * map at all falls back to the committed text.
 */
export function shown(rendered: Record<string, number> | undefined, messageId: string, fallback: number): number {
  if (rendered === undefined || rendered === null || typeof rendered !== 'object') return fallback;
  const n = rendered[messageId];
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(Math.max(0, Math.floor(n)), fallback) : 0;
}

function justFinished(m: MessageView | undefined, typingStartedAt: number | null, now: number): boolean {
  if (!m || m.status !== 'done' || m.completedAt === null) return false;
  return now - m.completedAt <= REWRITE_WINDOW_MS || (typingStartedAt !== null && typingStartedAt < m.completedAt);
}

/** Did a message start in reply to this one? */
function repliedTo(a: ConversationActor, messageId: string): boolean {
  const m = byId(a, messageId);
  if (!m) return false;
  return a.eventsAfter(m.anchorSeq).some((e) => e.type === 'message_started' && e.replyTo === messageId);
}

const byId = (a: ConversationActor, id: string) => a.view.messages.find((m) => m.id === id);
/** The agent's most recently started message (display order can differ once steers move messages). */
function latestBy(a: ConversationActor, id: AgentId): MessageView | undefined {
  let found: MessageView | undefined;
  for (const m of a.view.messages) {
    if (m.author.kind === 'agent' && m.author.agentId === id && (!found || m.startSeq > found.startSeq)) found = m;
  }
  return found;
}
/** Agents sorted by where their live (or latest) message is shown. */
function byPosition(a: ConversationActor, ids: AgentId[]): AgentId[] {
  const pos = (id: AgentId) => {
    const mid = liveBy(a, id)?.messageId ?? latestBy(a, id)?.id;
    const i = mid === undefined ? -1 : a.view.messages.findIndex((m) => m.id === mid);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  return [...ids].sort((x, y) => pos(x) - pos(y));
}
function liveBy(a: ConversationActor, id: AgentId): Generation | undefined {
  let found: Generation | undefined;
  for (const g of a.generations.values()) if (g.agentId === id) found = g;
  return found;
}
const uniq = <T>(xs: T[]) => [...new Set(xs)];
