import { randomUUID } from 'node:crypto';
import type { AgentId, Effort } from '../../shared/events.js';
import { parseAddressing, parseMentions } from '../../shared/targets.js';
import type { ConversationActor } from '../actor.js';
import { AGENT_IDS } from '../agents/personas.js';
import { clusterGists, findRepeats, hasNewFigures, noveltyThreshold, selectSpeakers } from './dedup.js';
import { isFailedBid, markFailedBid, runGate, type Bid } from './gate.js';
import { asksForDepth, smallTalkKind } from './smalltalk.js';
import { startGeneration, type Generation } from './generation.js';

export const BUDGET = { maxAgentMessages: 7, maxHops: 3, turnTimeoutMs: 90_000 };
/** Per-call cap on one gate request, so one hung call cannot stall a wave. */
export const GATE_TIMEOUT_MS = Number(process.env.GATE_TIMEOUT_MS) || 8000;
/** Once one gate has answered, how long the wave waits for the others. */
export const GATE_GRACE_MS = 3000;
/** A named agent answers either way; its gate only tunes how, so it gets little time. */
export const NAMED_GATE_MS = 2000;
/** Cap on dedup: past this, agents simply count as saying different things. */
export const DEDUP_TIMEOUT_MS = 2000;
/** Most agents that answer a phatic user message; the turn ends after wave 0. */
export const SMALL_TALK_CAPS = { greeting: 2, thanks: 1, ack: 1 } as const;

const FEW_WORDS = 'Answer in a few words. No work update, no new facts, no question back, no @mention.';
const ACK = 'Acknowledge what the person asked for in a few words, already doing it. No work update, no question back, no @mention.';
const REACT =
  'React directly to what your teammates just said: say where you disagree and why, with a fact only you hold. No recap.';
const REACT_JOINT =
  'Read what your teammates just said and say what it changes in your answer, using their facts by name and adding what only you hold. No recap.';
const CLOSE_DEBATE = 'Close this out: say where you landed or what still splits you, in a sentence or two. No @mentions, no questions.';
const CLOSE_JOINT =
  'Give the person the one joint recommendation the group lands on, putting the specific facts each of you gave together into an answer none of you could give alone. One clear call. No @mentions, no questions.';

/** Who to ask when no gate could be reached at all: whoever the words point at. */
const DOMAIN: Record<AgentId, RegExp> = {
  maya: /\b(?:build|ship|sso|engineer\w*|scope|timeline|deliver\w*|technical|code|bug|feature)\b/i,
  theo: /\b(?:customer\w*|deal\w*|renew\w*|sales?|northwind|prospect\w*|churn|contract\w*|arr)\b/i,
  priya: /\b(?:runway|cash|budget\w*|burn|spend\w*|financ\w*|money|cost\w*|hiring|freeze)\b/i,
};

const isAbort = (e: unknown) => e instanceof Error && e.name === 'AbortError';

/** Bids already in flight for this message, one per agent; running them beside the classifier saves its wait. */
export type PrefetchedBids = Map<AgentId, Promise<Bid>>;

export interface TurnArgs {
  triggerMessageId: string;
  forced: AgentId[];
  /** Wave 0 reads these instead of asking again. */
  prefetched?: PrefetchedBids;
  /** The message only set or lifted an instruction: one short acknowledgement. */
  ack?: boolean;
}

interface Spoken {
  agentId: AgentId;
  messageId: string;
  /** Final persisted text, or null when the message did not complete. */
  text: string | null;
  addresses: Bid['addresses'];
}

interface Speaker {
  agentId: AgentId;
  effort: Effort;
  gist: string;
}

interface WaveEntry {
  gen: Generation;
  addresses: Bid['addresses'];
}

/** Coming back after already answering takes the top novelty score. */
const REENTRY_NOVELTY = 3;

/**
 * Runs one human-triggered turn as a series of waves. Each wave: gate the free
 * agents in parallel, dedup their gists, pick speakers, stream them concurrently
 * and wait for all to finish. Agents @mentioned by a wave are forced into the
 * next one. Hop, message and time budgets end agent-to-agent exchanges on their
 * own.
 *
 * Who may speak comes from the person first. Naming agents makes wave 0 exactly
 * those agents, and others join later only when a named agent @mentions them;
 * "only X" or "one of you" holds for the whole turn. A debate or a request for
 * one joint answer plans its later waves instead of gating them.
 *
 * Starting a new turn aborts the previous turn's signal: that stops its gating
 * and any further waves, but never in-flight generations. Never rejects.
 */
export async function runTurn(actor: ConversationActor, a: TurnArgs): Promise<void> {
  actor.turnAbort?.abort();
  const ctrl = new AbortController();
  actor.turnAbort = ctrl;
  actor.turnTriggerSeq = actor.view.messages.find((m) => m.id === a.triggerMessageId)?.startSeq ?? actor.lastSeq;
  try {
    await waves(actor, a, ctrl.signal);
  } catch (err) {
    if (!isAbort(err)) console.warn(`turn in ${actor.id}: unexpected error`, err);
  } finally {
    if (actor.turnAbort === ctrl) actor.turnAbort = null;
  }
}

async function waves(actor: ConversationActor, a: TurnArgs, signal: AbortSignal): Promise<void> {
  const triggerMessageId = a.triggerMessageId;
  const turnId = randomUUID();
  const t0 = Date.now();
  const inTime = () => Date.now() - t0 < BUDGET.turnTimeoutMs;
  const trigger = actor.view.messages.find((m) => m.id === triggerMessageId);
  const text = trigger?.author.kind === 'user' ? trigger.text : '';
  const kind = smallTalkKind(text);
  const light = kind !== null || a.ack === true;
  const addr = parseAddressing(text);
  const smallCap = a.ack || addr.justOne ? 1 : kind ? SMALL_TALK_CAPS[kind] : Infinity;
  // Naming agents is a decision about who answers; asking everyone is the opposite one.
  const askEveryone = addr.everyone && !light && a.forced.length === 0;
  const addressed = a.forced.length > 0;
  const lastHop = addr.only || addr.justOne ? 0 : BUDGET.maxHops;
  const planned = !light && (addr.debate || addr.joint);
  const deep = !light && asksForDepth(text);

  let hop = 0;
  let forced: AgentId[] = askEveryone ? [...AGENT_IDS] : [...new Set(a.forced)];
  let lastWave: AgentId[] = [];
  let lastSpoken: Spoken[] = [];
  let firstWave: AgentId[] = [];
  let started = 0;
  let step: PlanStep | null = null;
  const said: string[] = [];
  const spokeThisTurn = new Set<AgentId>();
  /** Asked this question already and passed; only asked again if nobody else turns up. */
  const passed = new Set<AgentId>();

  while (hop <= lastHop && started < BUDGET.maxAgentMessages && inTime() && !signal.aborted) {
    const live = liveAgents(actor);
    // Forced agents already speaking are skipped for this wave, not queued.
    const forcedNow = forced.filter((id) => !live.has(id));
    // Past the one comeback at hop 1, nobody who has spoken this turn returns unless pulled in.
    const excluded = [...new Set([...excludedAt(hop, addressed, lastSpoken), ...(hop > 1 ? spokeThisTurn : [])])];
    const candidates =
      addressed || step !== null
        ? []
        : AGENT_IDS.filter((id) => !live.has(id) && !forced.includes(id) && !excluded.includes(id) && !passed.has(id));
    // In wave 0 a forced agent bids too: its bid says how much the question deserves.
    const asked = hop === 0 ? [...candidates, ...forcedNow] : candidates;

    const cutoff = actor.lastSeq;
    const raw = await gatherBids(actor, asked, forcedNow, cutoff, hop, signal, hop === 0 ? a.prefetched : undefined);
    if (signal.aborted) return;
    const repeats = hop > 0 ? await findRepeats(raw, said, text, cappedDedup(signal), spokeThisTurn) : new Set<AgentId>();
    if (signal.aborted) return;
    const bids = raw.map((b) => {
      // Someone yet to speak this turn, with figures nobody has given: that is a real fact, and one
      // message per agent cannot spiral. Whatever a repeat check or a shy novelty score makes of it.
      if (hop > 0 && b.should_respond && !spokeThisTurn.has(b.agentId) && hasNewFigures(b.gist, said)) {
        return { ...b, novelty: Math.max(b.novelty, noveltyThreshold(hop)) };
      }
      return repeats.has(b.agentId) ? { ...b, should_respond: false } : b;
    });

    // Everyone free passed, but the words point at someone still writing: they
    // get to answer before a teammate is pushed to say "I don't know".
    const someoneWilling = bids.some((b) => b.should_respond && b.novelty >= noveltyThreshold(hop));
    const owners = [...actor.generations.values()].filter((g) => DOMAIN[g.agentId].test(text));
    if (hop === 0 && forcedNow.length === 0 && !light && step === null && !someoneWilling && owners.length > 0) {
      asked.forEach((id) => passed.add(id));
      await untilDone(owners, signal);
      if (signal.aborted) return;
      continue;
    }

    const room = Math.min(BUDGET.maxAgentMessages, smallCap) - started;
    const open = bids.filter((b) => !forcedNow.includes(b.agentId));
    const recency = lastSpokenAt(actor);
    const wave: WaveEntry[] = [];
    const launch = (s: Speaker, others: AgentId[]) => {
      if (liveAgents(actor).has(s.agentId) || steeredSince(actor, s.agentId, cutoff)) return;
      // The person stopped this agent after asking: a teammate's @mention does not bring it back.
      if ((actor.agentStops.get(s.agentId) ?? 0) > (trigger?.startSeq ?? 0)) return;
      try {
        const gen = startGeneration(actor, {
          agentId: s.agentId,
          turnId,
          hop,
          replyTo: replyToFor(s.agentId, hop, lastSpoken, triggerMessageId),
          effort: s.effort,
          gist: s.gist,
          // A name here that dedup later cuts only asks the writer to keep to its own point.
          othersReplying: others,
          triggerSeq: trigger?.startSeq,
        });
        started++;
        wave.push({ gen, addresses: bids.find((b) => b.agentId === s.agentId)?.addresses ?? [] });
      } catch (err) {
        console.warn(`turn ${turnId}: could not start ${s.agentId}`, err);
      }
    };
    const shape = (s: Speaker, fallback: boolean): Speaker => {
      if (a.ack) return { ...s, effort: 'low', gist: ACK };
      if (light || (fallback && !deep)) return { ...s, effort: 'low', gist: FEW_WORDS };
      if (step !== null) return { ...s, effort: step.effort, gist: step.gist };
      const bid = bids.find((b) => b.agentId === s.agentId);
      // Depth was asked for in words: no bid, late gate or reluctant gate takes it away from a first answer.
      if (deep && !spokeThisTurn.has(s.agentId)) return { ...s, effort: 'high', gist: bid?.should_respond ? s.gist : '' };
      // Nothing to read at a later hop: a pulled-in teammate answers briefly.
      if (!bid) return { ...s, effort: 'low' };
      // A named agent speaks even if its gate would not have; it has no point of its own to cover.
      if (forcedNow.includes(s.agentId) && !bid.should_respond) return { ...s, effort: 'medium', gist: '' };
      return s;
    };

    let speakers: Speaker[];
    let fallback = false;
    let first: AgentId | undefined;
    if (hop === 0 && forcedNow.length === 0 && bids.length > 0 && bids.every(isFailedBid)) {
      // No gate could be reached: nobody declined, so this is not "nobody cares".
      const picked = AGENT_IDS.filter((id) => DOMAIN[id].test(text) && asked.includes(id));
      const pool = picked.length > 0 ? picked : asked;
      speakers = pool.map((agentId) => ({ agentId, effort: light ? 'low' : deep ? 'high' : 'medium', gist: '' }));
    } else {
      const threshold = noveltyThreshold(hop);
      const eligible = open.filter((b) => b.should_respond && b.novelty >= threshold && !excluded.includes(b.agentId));
      // The strongest bid is certain to speak, so its first words need not wait for dedup.
      if (hop === 0 && forcedNow.length === 0 && eligible.length > 1 && room > 0) {
        const top = rank(eligible, forcedNow, recency)[0]!;
        first = top.agentId;
        launch(
          shape(top, false),
          eligible.map((b) => b.agentId).filter((id) => id !== first),
        );
      }
      const clusters = await clusterGists(open, cappedDedup(signal));
      if (signal.aborted || !inTime()) return;
      const selected = selectSpeakers(bids, clusters, {
        forced: forcedNow,
        hop,
        excluded,
        first,
        recency,
        seed: text,
      });
      fallback =
        hop === 0 && forcedNow.length === 0 && !selected.some((s) => eligible.some((b) => b.agentId === s.agentId));
      speakers = oneReentrant(selected, lastWave, forcedNow, bids, hop);
    }

    const chosen = cutToBudget(rankSpeakers(speakers, forcedNow, bids, recency), forcedNow, room);
    for (const s of chosen) {
      if (s.agentId === first) continue;
      launch(
        shape(s, fallback),
        chosen.map((o) => o.agentId).filter((id) => id !== s.agentId),
      );
    }
    if (wave.length === 0) return;

    await settle(actor, wave);
    lastSpoken = wave.map((w) => {
      const m = actor.view.messages.find((x) => x.id === w.gen.messageId);
      return {
        agentId: w.gen.agentId,
        messageId: w.gen.messageId,
        text: m?.status === 'done' ? m.text : null,
        addresses: w.addresses,
      };
    });
    if (signal.aborted) return;
    if (light || fallback) return; // one light wave, no follow-ups

    for (const s of lastSpoken) if (s.text) said.push(s.text);
    lastWave = wave.map((w) => w.gen.agentId);
    lastWave.forEach((id) => spokeThisTurn.add(id));
    if (hop === 0) firstWave = lastWave;
    hop++;

    if (planned) {
      step = planStep(hop, firstWave, addr.joint, text, deep);
      if (!step) return;
      forced = step.forced;
    } else {
      forced = nextForced(lastSpoken, hop - 1, addressed, spokeThisTurn);
    }
  }
}

interface PlanStep {
  forced: AgentId[];
  gist: string;
  effort: Effort;
}

/** A debate reacts, then closes; a request for one answer gets one reaction, then the answer. */
function planStep(hop: number, first: AgentId[], joint: boolean, text: string, deep: boolean): PlanStep | null {
  const opener = first[0];
  if (opener === undefined) return null;
  if (hop === 1) {
    // Alone so far: bring in whoever the person named next, or the next agent.
    const others = AGENT_IDS.filter((id) => !first.includes(id));
    const partner = others.find((id) => new RegExp(`\\b${id}\\b`, 'i').test(text)) ?? others[0] ?? opener;
    const reactors = first.length < 2 ? [partner] : joint ? [first.at(-1)!] : first;
    return { forced: reactors, gist: joint ? REACT_JOINT : REACT, effort: 'low' };
  }
  if (hop === 2) return { forced: [opener], gist: joint ? CLOSE_JOINT : CLOSE_DEBATE, effort: joint ? (deep ? 'high' : 'medium') : 'low' };
  return null;
}

/** Everyone in a wave has written; a steer may have reopened one of them, so wait for what it says now. */
async function settle(actor: ConversationActor, wave: WaveEntry[]): Promise<void> {
  await Promise.allSettled(wave.map((w) => w.gen.done));
  const reopened = wave.flatMap((w) => {
    const g = actor.generations.get(w.gen.messageId);
    return g ? [g.done] : [];
  });
  if (reopened.length > 0) await Promise.allSettled(reopened);
}

/** Waits for these streams to end, or for the turn to be called off. */
async function untilDone(gens: Generation[], signal: AbortSignal): Promise<void> {
  let wake!: () => void;
  const aborted = new Promise<void>((r) => (wake = r));
  signal.addEventListener('abort', wake, { once: true });
  try {
    await Promise.race([Promise.allSettled(gens.map((g) => g.done)), aborted]);
  } finally {
    signal.removeEventListener('abort', wake);
  }
}

const liveAgents = (actor: ConversationActor) => new Set([...actor.generations.values()].map((g) => g.agentId));

/** A steer moved this agent's answer after the wave began: what forced it is stale. */
function steeredSince(actor: ConversationActor, id: AgentId, cutoff: number): boolean {
  return actor.view.messages.some(
    (m) => m.author.kind === 'agent' && m.author.agentId === id && m.anchorSeq > cutoff && m.startSeq <= cutoff,
  );
}

/** At hop 1 whoever finished the last wave may come back (it has now read the others); later nobody from it may. */
function excludedAt(hop: number, addressed: boolean, last: Spoken[]): AgentId[] {
  if (hop === 0) return [];
  const barred = hop === 1 && !addressed ? last.filter((s) => s.text === null) : last;
  return barred.map((s) => s.agentId);
}

/** Of those who spoke in the last wave, at most one comes back on its own, and only with something truly new. */
function oneReentrant(selected: Speaker[], lastWave: AgentId[], forced: AgentId[], bids: Bid[], hop: number): Speaker[] {
  if (hop !== 1) return selected;
  const back = selected.filter((s) => lastWave.includes(s.agentId) && !forced.includes(s.agentId));
  const novelty = (s: Speaker) => bids.find((b) => b.agentId === s.agentId)?.novelty ?? 0;
  const keep = [...back].sort((x, y) => novelty(y) - novelty(x)).find((s) => novelty(s) >= REENTRY_NOVELTY);
  return selected.filter((s) => !back.includes(s) || s === keep);
}

/** Each agent's most recent message start, for least-recently-spoken ordering. */
function lastSpokenAt(actor: ConversationActor): Map<AgentId, number> {
  const out = new Map<AgentId, number>();
  for (const m of actor.view.messages) {
    if (m.author.kind === 'agent') out.set(m.author.agentId, Math.max(out.get(m.author.agentId) ?? 0, m.startSeq));
  }
  return out;
}

/** Forced first, in the order the person named them; then most to add; then whoever has spoken least recently. */
function rank<T extends { agentId: AgentId; novelty?: number }>(
  xs: T[],
  forced: AgentId[],
  recency: Map<AgentId, number>,
): T[] {
  const at = (id: AgentId) => {
    const i = forced.indexOf(id);
    return i < 0 ? Infinity : i;
  };
  return [...xs].sort((a, b) => {
    const fa = at(a.agentId);
    const fb = at(b.agentId);
    if (fa !== fb) return fa < fb ? -1 : 1;
    return (
      (b.novelty ?? 0) - (a.novelty ?? 0) ||
      (recency.get(a.agentId) ?? 0) - (recency.get(b.agentId) ?? 0) ||
      AGENT_IDS.indexOf(a.agentId) - AGENT_IDS.indexOf(b.agentId)
    );
  });
}

function rankSpeakers(speakers: Speaker[], forced: AgentId[], bids: Bid[], recency: Map<AgentId, number>): Speaker[] {
  const withNovelty = speakers.map((s) => ({ ...s, novelty: bids.find((b) => b.agentId === s.agentId)?.novelty ?? 0 }));
  return rank(withNovelty, forced, recency).map(({ novelty: _n, ...s }) => s);
}

/**
 * Bids for one wave. A hung gate costs the others at most GATE_GRACE_MS once any
 * gate has answered. A wave of only forced agents (who speak regardless) waits
 * NAMED_GATE_MS at most.
 */
async function gatherBids(
  actor: ConversationActor,
  ids: AgentId[],
  forced: AgentId[],
  cutoff: number,
  hop: number,
  signal: AbortSignal,
  prefetched: PrefetchedBids | undefined,
): Promise<Bid[]> {
  if (ids.length === 0) return [];
  const each = capped(signal);
  const onlyForced = ids.every((id) => forced.includes(id));
  let cutOff!: () => void;
  const deadline = new Promise<'late'>((r) => (cutOff = () => r('late')));
  let timer: ReturnType<typeof setTimeout> | null = onlyForced ? setTimeout(cutOff, NAMED_GATE_MS) : null;
  const answered = () => {
    timer ??= setTimeout(cutOff, GATE_GRACE_MS);
  };
  signal.addEventListener('abort', cutOff, { once: true });
  try {
    return await Promise.all(
      ids.map(async (id) => {
        const ask = prefetched?.get(id) ?? runGate(actor, id, cutoff, hop, each);
        void ask.catch(() => {}); // a late rejection after the deadline is nobody's business
        try {
          const bid = await Promise.race([ask.then((b) => (answered(), b)), deadline]);
          return bid === 'late' ? failedBid(id, forced.includes(id)) : bid;
        } catch (err) {
          if (signal.aborted) throw err; // the turn itself was aborted
          return failedBid(id, forced.includes(id));
        }
      }),
    );
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal.removeEventListener('abort', cutOff);
  }
}

const capped = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(GATE_TIMEOUT_MS)]);
const cappedDedup = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(DEDUP_TIMEOUT_MS)]);

/** A gate that did not answer says nothing about what the agent would do. */
const failedBid = (agentId: AgentId, forced: boolean): Bid =>
  markFailedBid({ agentId, should_respond: false, novelty: 0, gist: '', addresses: [], effort: forced ? 'medium' : 'low' });

/** Keep at most `room` speakers, forced ones first. */
function cutToBudget<T extends { agentId: AgentId }>(speakers: T[], forced: AgentId[], room: number): T[] {
  if (speakers.length <= room) return speakers;
  const isForced = (s: T) => forced.includes(s.agentId);
  const kept = new Set([...speakers.filter(isForced), ...speakers.filter((s) => !isForced(s))].slice(0, room));
  return speakers.filter((s) => kept.has(s));
}

/** Does the sentence naming this agent ask them something? */
function asks(text: string, id: AgentId): boolean {
  const name = new RegExp(`(?<![\\w'])@?${id}(?![\\w'])`, 'i');
  return text.split(/(?<=[.!?\n])\s+/).some((sentence) => name.test(sentence) && sentence.trim().endsWith('?'));
}

/**
 * Agents a wave's completed messages pull in. An agent who spoke in the same
 * wave wrote without seeing the mention, and its answer usually covers it, so
 * it comes back only when the first wave put a real question to it. Bids that
 * merely address someone count only when the person named nobody.
 */
function nextForced(spoken: Spoken[], hop: number, addressed: boolean, answered: ReadonlySet<AgentId>): AgentId[] {
  const out = new Set<AgentId>();
  const inWave = new Set(spoken.map((s) => s.agentId));
  for (const s of spoken) {
    if (s.text === null) continue; // stopped or failed messages force no one
    for (const id of parseMentions(s.text)) {
      if (id === s.agentId) continue;
      if (!inWave.has(id) || (hop === 0 && asks(s.text, id))) out.add(id);
    }
    if (addressed) continue;
    // A bid aimed at someone who has already answered is no reason to bring them back: only an @mention is.
    for (const id of s.addresses) if (id !== 'user' && id !== s.agentId && !inWave.has(id) && !answered.has(id)) out.add(id);
  }
  return AGENT_IDS.filter((id) => out.has(id));
}

/** Wave 0 replies to the trigger; later waves to the message that @mentioned the agent. */
function replyToFor(agentId: AgentId, hop: number, prev: Spoken[], trigger: string): string {
  if (hop === 0) return trigger;
  const by = prev.find((s) => s.text !== null && s.agentId !== agentId && parseMentions(s.text).includes(agentId));
  return by?.messageId ?? trigger;
}
