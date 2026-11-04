import Database from 'better-sqlite3';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { resetFake, setFakeScript, setFakeSleep, type FakeReply } from '../../src/server/llm/fake.js';
import { FLUSH_MS } from '../../src/server/orchestrator/generation.js';
import { BUDGET } from '../../src/server/orchestrator/turn.js';
import { handleStop, handleUserMessage } from '../../src/server/steering/handle.js';
import type { SteerDecision } from '../../src/server/steering/classify.js';
import { applyEvent, fold } from '../../src/shared/reducer.js';
import type { AgentId, ConvEvent } from '../../src/shared/events.js';

/*
 * Ordering invariants under random interleavings of sends, steers, stops,
 * reloads, token arrival and flush timers.
 *
 * What the scheduler controls: every fake token delay (setFakeSleep) and the
 * latency of every structured call (gate, dedup, classify, judge). The 75 ms
 * flush timer and Date run on fake timers, advanced by Tick commands, so a
 * flush can land before or after any steer/stop.
 */

type Meta = { kind: string; agentId?: string };
const hooks = vi.hoisted(() => ({ before: null as null | ((meta: Meta) => Promise<void> | undefined) }));
vi.mock('../../src/server/llm/stream.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/server/llm/stream.js')>();
  return {
    ...m,
    generateStructured: (async (a: Parameters<typeof m.generateStructured>[0]) => {
      const wait = hooks.before?.(a.meta);
      if (wait) await wait;
      return m.generateStructured(a);
    }) as typeof m.generateStructured,
  };
});

const AGENTS: AgentId[] = ['maya', 'theo', 'priya'];
const NEXT: Record<AgentId, AgentId> = { maya: 'theo', theo: 'priya', priya: 'maya' };
const CONV = 'p1';
/** PROPERTY_RUNS=5000 npx vitest run tests/property for a longer hunt. */
const RUNS = Number(process.env.PROPERTY_RUNS ?? 100);

/** Coverage evidence, accumulated over every run from the event logs. */
const cover = { stopWhileOpen: 0, steerMidStream: 0, reopen: 0 };

interface Params {
  gate: Record<AgentId, boolean>;
  mentions: boolean;
  chunks: number;
  judgeComplies: boolean;
  failAgent: AgentId | null;
}

interface Real {
  db: Db;
  actor: ConversationActor;
  pushed: ConvEvent[];
  pending: number;
  sends: { clientMsgId: string; seq: number }[];
  n: number;
}
type Model = Record<string, never>;
type Cmd = fc.AsyncCommand<Model, Real>;

const NEW_MESSAGE: SteerDecision = {
  kind: 'new_message',
  targets: [],
  apply: 'continue',
  scope: 'one_off',
  standing_text: null,
  revokes: [],
};

/** Classifier fake: the decision is driven by a #tag in the command's text. */
function classifyText(text: string, prompt: string): SteerDecision {
  const named = [...text.matchAll(/@(maya|theo|priya)/g)].map((m) => m[1] as AgentId);
  if (text.includes('#continue')) return { ...NEW_MESSAGE, kind: 'steer', targets: named, apply: 'continue' };
  if (text.includes('#replace')) return { ...NEW_MESSAGE, kind: 'steer', targets: named, apply: 'replace' };
  if (text.includes('#stop')) return { ...NEW_MESSAGE, kind: 'stop', targets: named };
  if (text.includes('#standing')) {
    const revokes = text.includes('#revoke') ? [...prompt.matchAll(/^- \[([^\]]+)\] \(/gm)].map((m) => m[1]!) : [];
    return {
      ...NEW_MESSAGE,
      kind: 'steer',
      targets: named,
      apply: 'replace',
      scope: 'standing',
      standing_text: 'Be brief.',
      revokes,
    };
  }
  return { ...NEW_MESSAGE, targets: named };
}

function install(p: Params): void {
  setFakeScript((r): FakeReply => {
    const id = (r.agentId ?? 'maya') as AgentId;
    switch (r.kind) {
      case 'reply': {
        if (p.failAgent === id) return { error: 'boom', afterChunks: 1 };
        const chunks = Array.from({ length: p.chunks }, (_, i) => `${id}${i} `);
        if (p.mentions) chunks.push(`over to @${NEXT[id]} `);
        return { chunks, delayMs: 1 };
      }
      case 'continue':
      case 'replace':
        return { chunks: ['steered ', 'ok '], delayMs: 1 };
      case 'classify': {
        const prompt = r.prompt ?? '';
        const text = /The human's new message:\n([\s\S]*)$/.exec(prompt)?.[1] ?? '';
        return { object: classifyText(text, prompt) };
      }
      case 'judge':
        return { object: { complies: p.judgeComplies } };
      case 'gate': {
        const yes = p.gate[id];
        return {
          object: { should_respond: yes, novelty: yes ? 3 : 0, gist: yes ? `${id} point` : '', addresses: [], effort: 'low' },
        };
      }
      case 'dedup': {
        const ids = [...(r.prompt ?? '').matchAll(/^(maya|theo|priya): /gm)].map((m) => [m[1]!]);
        return { object: { clusters: ids } };
      }
    }
  });
}

/** What a client would report: committed text of streaming messages, lagging by `lag` chars. */
function rendered(r: Real, lag: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of r.actor.view.messages) if (m.status === 'streaming') out[m.id] = Math.max(0, m.text.length - lag);
  return out;
}

async function send(r: Real, text: string, lag: number, typingEarly: boolean): Promise<void> {
  const clientMsgId = `cm-${++r.n}`;
  const res = await handleUserMessage(r.actor, {
    clientMsgId,
    text,
    typingStartedAt: typingEarly ? Date.now() - 60_000 : null,
    rendered: rendered(r, lag),
  });
  r.sends.push({ clientMsgId, seq: res.seq });
  r.pending++;
  void res.settled.finally(() => r.pending--);
}

const cmd = (name: string, run: (r: Real) => Promise<void> | void): Cmd => ({
  check: () => true,
  run: async (_m, r) => {
    await run(r);
  },
  toString: () => name,
});

const agentArb = fc.constantFrom(...AGENTS);
const applyArb = fc.constantFrom('continue', 'replace');
const lagArb = fc.nat({ max: 4 });

const commandArbs = [
  fc
    .record({ to: fc.option(agentArb, { nil: null }), lag: lagArb })
    .map(({ to, lag }) =>
      cmd(`Send(${to ?? '-'})`, (r) => send(r, `${to ? `@${to} ` : ''}what about pricing? #new`, lag, false)),
    ),
  fc
    .record({ to: agentArb, apply: applyArb, lag: lagArb, early: fc.boolean() })
    .map(({ to, apply, lag, early }) =>
      cmd(`SteerByName(${to},${apply},lag=${lag}${early ? ',early' : ''})`, (r) =>
        send(r, `@${to} make it shorter #${apply}`, lag, early),
      ),
    ),
  fc
    .record({ apply: applyArb, lag: lagArb, early: fc.boolean() })
    .map(({ apply, lag, early }) =>
      cmd(`SteerBroadcast(${apply},lag=${lag}${early ? ',early' : ''})`, (r) =>
        send(r, `everyone make it shorter #${apply}`, lag, early),
      ),
    ),
  fc
    .record({ to: fc.option(agentArb, { nil: null }), revoke: fc.boolean() })
    .map(({ to, revoke }) =>
      cmd(`Standing(${to ?? 'all'}${revoke ? ',revoke' : ''})`, (r) =>
        send(r, `${to ? `@${to} ` : ''}from now on be brief #standing${revoke ? ' #revoke' : ''}`, 0, false),
      ),
    ),
  fc
    .record({ lag: lagArb, button: fc.boolean() })
    .map(({ lag, button }) =>
      cmd(`Stop(${button ? 'button' : 'typed'},lag=${lag})`, (r) =>
        button
          ? void handleStop(r.actor, { clientReqId: `stop-${++r.n}`, rendered: rendered(r, lag) })
          : send(r, 'stop', lag, false),
      ),
    ),
  fc
    .record({ to: agentArb, lag: lagArb, classified: fc.boolean() })
    .map(({ to, lag, classified }) =>
      cmd(`StopOne(${to}${classified ? ',classified' : ''})`, (r) =>
        send(r, classified ? `@${to} please end it there #stop` : `${to}, stop`, lag, false),
      ),
    ),
  fc.constant(
    cmd('Resend', async (r) => {
      const last = r.sends.at(-1);
      if (!last) return;
      const res = await handleUserMessage(r.actor, {
        clientMsgId: last.clientMsgId,
        text: 'ignored',
        typingStartedAt: null,
        rendered: {},
      });
      expect(res.seq).toBe(last.seq);
      await res.settled;
    }),
  ),
  fc.constantFrom(FLUSH_MS, FLUSH_MS * 3, 2500).map((ms) => cmd(`Tick(${ms})`, () => void vi.advanceTimersByTime(ms))),
  fc.double({ min: 0, max: 1, noNaN: true }).map((frac) => cmd(`Reload(${frac.toFixed(2)})`, (r) => reload(r, frac))),
];

// ---------------------------------------------------------------------------
// Checks

/** Invariant 1: seqs gap-free and strictly increasing; live pushes equal the log. */
function checkSeqs(r: Real, evs: ConvEvent[]): void {
  evs.forEach((e, i) => expect(e.seq, 'seq gap').toBe(i + 1));
  expect(r.pushed, 'pushed events == log').toEqual(evs);
}

/** Streaming messages in the view are exactly the live generations (no zombie streams). */
function checkLive(r: Real): void {
  const streaming = r.actor.view.messages.filter((m) => m.status === 'streaming').map((m) => m.id);
  expect(streaming.sort(), 'streaming == live generations').toEqual([...r.actor.generations.keys()].sort());
}

/** Mid-run reload: a client snapshot + catch-up equals the view; a crash-restart on a copy recovers cleanly. */
function reload(r: Real, frac: number): void {
  const evs = r.actor.eventsAfter(0);
  checkSeqs(r, evs);
  checkLive(r);
  expect(fold(evs), 'fold(log) == actor.view').toEqual(r.actor.view);

  const k = Math.floor(frac * r.actor.lastSeq);
  const caughtUp = r.actor.eventsAfter(k).reduce(applyEvent, fold(r.actor.eventsUpTo(k)));
  expect(caughtUp, 'snapshot + catch-up == view').toEqual(r.actor.view);

  const streaming = r.actor.view.messages.filter((m) => m.status === 'streaming');
  if (streaming.length === 0) {
    // Nothing is streaming: a fresh actor over the live DB must append nothing.
    const fresh = new ConversationActor(r.db, CONV);
    expect(fresh.lastSeq, 'fresh actor appended recovery events').toBe(r.actor.lastSeq);
    expect(fresh.view).toEqual(r.actor.view);
  } else {
    // Crash-restart on a copy: exactly one server_restart abort per streaming message.
    const copy = new Database(r.db.serialize());
    try {
      const fresh = new ConversationActor(copy, CONV);
      const added = fresh.eventsAfter(r.actor.lastSeq);
      expect(added.map((e) => (e.type === 'message_aborted' ? `${e.messageId}:${e.reason}` : e.type)).sort()).toEqual(
        streaming.map((m) => `${m.id}:server_restart`).sort(),
      );
      expect(fresh.view.messages.some((m) => m.status === 'streaming')).toBe(false);
      expect(fold(fresh.eventsAfter(0))).toEqual(fresh.view);
    } finally {
      copy.close();
    }
  }
}

function checkFinal(r: Real): void {
  const evs = r.actor.eventsAfter(0);
  // 1
  checkSeqs(r, evs);
  // 2
  const folded = fold(evs);
  expect(folded, 'fold(log) == actor.view').toEqual(r.actor.view);
  const fresh = new ConversationActor(r.db, CONV);
  expect(fresh.lastSeq, 'fresh actor appended recovery events while idle').toBe(r.actor.lastSeq);
  expect(fresh.view, 'fresh actor view').toEqual(r.actor.view);

  // 3, 4, 5 in one pass over the log.
  interface Life {
    segment: number;
    open: boolean;
    text: number;
  }
  const life = new Map<string, Life>();
  const stoppedAt = new Map<string, number>(); // messageId -> segment live at a stop_all
  const textLen = (id: string) => life.get(id)?.text ?? 0;
  for (const e of evs) {
    const at = `seq ${e.seq} (${e.type})`;
    switch (e.type) {
      case 'message_started':
        expect(life.has(e.messageId), `${at}: duplicate message_started`).toBe(false);
        life.set(e.messageId, { segment: 0, open: true, text: 0 });
        break;
      case 'message_segment_started': {
        const l = life.get(e.messageId);
        expect(l, `${at}: segment for unknown message`).toBeDefined();
        // Successor: the previous segment is either still open (closed by this
        // one) or already closed by a terminal (reopen); numbering is exact.
        expect(e.segment, `${at}: segment not previous+1`).toBe(l!.segment + 1);
        if (l!.open) cover.steerMidStream++;
        else cover.reopen++;
        l!.segment = e.segment;
        l!.open = true;
        l!.text = Math.min(l!.text, e.truncateTo);
        stoppedAt.delete(e.messageId);
        break;
      }
      case 'token_delta': {
        const l = life.get(e.messageId);
        // 3: a delta belongs to the message's current, still-open segment.
        expect(l?.open, `${at}: token_delta after terminal`).toBe(true);
        expect(e.segment, `${at}: token_delta for superseded segment`).toBe(l!.segment);
        // 4: nothing streams after a stop_all into a message that was live at it.
        expect(stoppedAt.has(e.messageId), `${at}: token_delta after stop_all`).toBe(false);
        expect(e.offset, `${at}: offset`).toBe(textLen(e.messageId));
        l!.text += e.text.length;
        break;
      }
      case 'message_completed':
      case 'message_aborted': {
        const l = life.get(e.messageId);
        expect(l, `${at}: terminal for unknown message`).toBeDefined();
        // 5: exactly one terminal per segment.
        expect(l!.open, `${at}: second terminal for segment ${l!.segment}`).toBe(true);
        l!.open = false;
        if (e.type === 'message_aborted') l!.text = Math.min(l!.text, e.truncateTo);
        break;
      }
      case 'stop_all':
        if ([...life.values()].some((l) => l.open)) cover.stopWhileOpen++;
        for (const [id, l] of life) if (l.open) stoppedAt.set(id, l.segment);
        break;
      default:
        break;
    }
  }
  for (const [id, l] of life) expect(l.open, `message ${id} segment ${l.segment} never closed`).toBe(false);
  expect(r.actor.view.messages.filter((m) => m.status === 'streaming'), 'streaming once idle').toEqual([]);
  expect(r.actor.generations.size).toBe(0);

  // 6: per-turn budgets.
  const perTurn = new Map<string, number>();
  for (const e of evs) {
    if (e.type !== 'message_started') continue;
    perTurn.set(e.turnId, (perTurn.get(e.turnId) ?? 0) + 1);
    expect(e.hop, 'hop budget').toBeLessThanOrEqual(BUDGET.maxHops);
  }
  for (const [turn, count] of perTurn) expect(count, `turn ${turn} messages`).toBeLessThanOrEqual(BUDGET.maxAgentMessages);

  // Every user message is resolved exactly once, after it.
  const users = evs.filter((e) => e.type === 'user_message');
  for (const u of users) {
    const res = evs.filter((e) => e.type === 'steer_resolved' && e.userMessageId === u.messageId);
    expect(res, `steer_resolved for ${u.messageId}`).toHaveLength(1);
    expect(res[0]!.seq).toBeGreaterThan(u.seq);
  }
}

// ---------------------------------------------------------------------------

const macrotask = () => new Promise<void>((res) => setImmediate(res));

/** Release every scheduled task and fake timer until nothing is in flight. */
async function drain(r: Real, s: fc.Scheduler): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < 20_000; i++) {
    await s.waitIdle();
    await macrotask();
    if (s.count() > 0) continue;
    if (vi.getTimerCount() > 0) {
      vi.advanceTimersByTime(FLUSH_MS);
      continue;
    }
    if (r.pending === 0 && r.actor.generations.size === 0 && r.actor.turnAbort === null) return;
    if (++quiet > 200) throw new Error(`stuck: pending=${r.pending} live=${r.actor.generations.size}`);
  }
  throw new Error('drain did not converge');
}

const paramsArb: fc.Arbitrary<Params> = fc.record({
  gate: fc.record({ maya: fc.boolean(), theo: fc.boolean(), priya: fc.boolean() }),
  mentions: fc.boolean(),
  chunks: fc.integer({ min: 1, max: 4 }),
  judgeComplies: fc.boolean(),
  failAgent: fc.oneof({ arbitrary: fc.constant(null), weight: 4 }, { arbitrary: agentArb, weight: 1 }),
});

describe('ordering invariants (property)', () => {
  const ENV_KEYS = ['MODEL_AGENT', 'MODEL_GATE', 'MODEL_CLASSIFIER'] as const;
  const savedEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    process.env.MODEL_AGENT = 'fake:x';
    process.env.MODEL_GATE = 'fake:x';
    process.env.MODEL_CLASSIFIER = 'fake:x';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    hooks.before = null;
    resetFake();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('hold under random interleavings of sends, steers, stops, reloads and tokens', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        paramsArb,
        fc.commands(commandArbs, { maxCommands: 30, size: 'medium' }),
        async (s, p, cmds) => {
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000_000 });
          resetFake();
          install(p);
          setFakeSleep(() => s.schedule(Promise.resolve(), 'token'));
          hooks.before = (meta) => s.schedule(Promise.resolve(), meta.kind);
          const db = openDb(':memory:');
          const actor = new ConversationActor(db, CONV);
          const r: Real = { db, actor, pushed: [], pending: 0, sends: [], n: 0 };
          actor.subscribe((e) => r.pushed.push(e));
          try {
            await send(r, 'What should we build? #new', 0, false);
            await fc.scheduledModelRun(s, () => ({ model: {}, real: r }), cmds);
            await drain(r, s);
            checkFinal(r);
          } finally {
            hooks.before = null;
            vi.useRealTimers();
            db.close();
          }
        },
      ),
      { numRuns: RUNS },
    );
    if (process.env.PROPERTY_VERBOSE) {
      console.info(
        `coverage: stop_all-while-open=${cover.stopWhileOpen} steer-mid-stream=${cover.steerMidStream} reopen=${cover.reopen}`,
      );
    }
    expect(cover.stopWhileOpen, 'stop_all landed while a message was open').toBeGreaterThan(0);
    expect(cover.steerMidStream, 'segment restarted while open').toBeGreaterThan(0);
  }, Math.max(30_000, RUNS * 200));
});
