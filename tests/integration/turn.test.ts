import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { resetFake, setFakeScript, type FakeReply } from '../../src/server/llm/fake.js';
import { setStreamTimeouts } from '../../src/server/llm/stream.js';
import { BUDGET, GATE_TIMEOUT_MS, SMALL_TALK_CAPS, runTurn } from '../../src/server/orchestrator/turn.js';
import type { AgentId, ConvEvent } from '../../src/shared/events.js';

// Lets a test make chosen structured calls (gate/dedup) hang until their
// signal aborts, like a provider that never answers.
const hooks = vi.hoisted(() => ({ hang: null as null | ((meta: { kind: string; agentId?: string }) => boolean) }));
vi.mock('../../src/server/llm/stream.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/server/llm/stream.js')>();
  const hangUntilAbort = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail, { once: true });
    });
  return {
    ...m,
    generateStructured: ((a: Parameters<typeof m.generateStructured>[0]) =>
      hooks.hang?.(a.meta) ? hangUntilAbort(a.signal) : m.generateStructured(a)) as typeof m.generateStructured,
  };
});

type Started = Extract<ConvEvent, { type: 'message_started' }>;
interface GateAns {
  should_respond: boolean;
  novelty: number;
  gist: string;
  addresses?: ('maya' | 'theo' | 'priya' | 'user')[];
}

const QUIET: GateAns = { should_respond: false, novelty: 0, gist: '' };

/**
 * Deterministic fake keyed by request kind and agent. `n` is how many earlier
 * requests of that kind this agent has made (0 for its first gate, etc.).
 */
function script(o: {
  gate: (agentId: AgentId, n: number) => GateAns;
  reply: (agentId: AgentId, n: number) => { chunks: string[]; delayMs: number; hangAfterChunks?: number };
  clusters?: AgentId[][];
}): void {
  const counts = new Map<string, number>();
  const bump = (k: string) => {
    const n = counts.get(k) ?? 0;
    counts.set(k, n + 1);
    return n;
  };
  setFakeScript((r): FakeReply => {
    const agentId = r.agentId as AgentId;
    if (r.kind === 'gate') {
      const a = o.gate(agentId, bump(`gate:${agentId}`));
      return { object: { addresses: [], effort: 'low', ...a } };
    }
    if (r.kind === 'dedup') {
      if (o.clusters) return { object: { clusters: o.clusters } };
      return { error: 'no dedup' }; // degrades to singletons
    }
    return o.reply(agentId, bump(`reply:${agentId}`));
  });
}

let db: Db;
let actor: ConversationActor;
beforeEach(() => {
  process.env.MODEL_AGENT = 'fake:x';
  process.env.MODEL_GATE = 'fake:x';
  process.env.MODEL_CLASSIFIER = 'fake:x';
  resetFake();
  hooks.hang = null;
  db = openDb(':memory:');
  actor = new ConversationActor(db, 'c1');
  actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'cm1', text: 'What should we build?' });
});
afterEach(() => {
  delete process.env.MODEL_AGENT;
  delete process.env.MODEL_GATE;
  delete process.env.MODEL_CLASSIFIER;
  resetFake();
  hooks.hang = null;
  db.close();
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timed out');
    await sleep(2);
  }
}
const events = () => actor.eventsAfter(0);
const started = (): Started[] => events().filter((e): e is Started => e.type === 'message_started');
const startedBy = (id: AgentId) => started().filter((e) => e.agentId === id);

describe('runTurn', () => {
  it('a hung stream ends its turn and the agent speaks in the next one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStreamTimeouts({ idleMs: 150 });
    try {
      script({
        gate: (id, n) => (id === 'maya' && n <= 1 ? { should_respond: true, novelty: 2, gist: 'a point' } : QUIET),
        reply: (_id, n) =>
          n === 0 ? { chunks: ['Half an ', 'answer'], delayMs: 1, hangAfterChunks: 1 } : { chunks: ['Fine.'], delayMs: 1 },
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(actor.generations.size).toBe(0);
      expect(actor.view.messages.at(-1)).toMatchObject({ status: 'stopped', text: 'Half an ' });

      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: 'And then?' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(startedBy('maya')).toHaveLength(2);
      expect(actor.view.messages.at(-1)).toMatchObject({ status: 'done', text: 'Fine.' });
    } finally {
      setStreamTimeouts();
    }
  });

  it('concurrent wave: both start before either completes and deltas interleave', async () => {
    script({
      gate: (id, n) =>
        n === 0 && id !== 'maya'
          ? { should_respond: true, novelty: 2, gist: id === 'theo' ? 'ship the API first' : 'talk to users first' }
          : QUIET,
      reply: () => ({ chunks: Array.from({ length: 8 }, (_, i) => `w${i} `), delayMs: 30 }),
      clusters: [['theo'], ['priya']],
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: [] });

    const evs = events();
    const s = started();
    expect(s.map((e) => e.agentId).sort()).toEqual(['priya', 'theo']);
    expect(s.every((e) => e.hop === 0 && e.replyTo === 'u1')).toBe(true);
    expect(new Set(s.map((e) => e.turnId)).size).toBe(1);

    const firstCompleted = evs.find((e) => e.type === 'message_completed')!.seq;
    expect(s.every((e) => e.seq < firstCompleted)).toBe(true);

    const ids = s.map((e) => e.messageId);
    const deltaOwners = evs
      .filter((e): e is Extract<ConvEvent, { type: 'token_delta' }> => e.type === 'token_delta')
      .map((d) => d.messageId);
    const [a, b] = ids as [string, string];
    // Interleaved: each message has a delta before the other's last delta.
    expect(deltaOwners.indexOf(a)).toBeLessThan(deltaOwners.lastIndexOf(b));
    expect(deltaOwners.indexOf(b)).toBeLessThan(deltaOwners.lastIndexOf(a));
    expect(actor.view.messages.filter((m) => m.author.kind === 'agent').every((m) => m.status === 'done')).toBe(true);
  });

  it('redundant agent silent: one speaker per cluster', async () => {
    script({
      gate: (id, n) =>
        n === 0 && id === 'maya'
          ? { should_respond: true, novelty: 2, gist: 'use Postgres' }
          : n === 0 && id === 'theo'
            ? { should_respond: true, novelty: 3, gist: 'Postgres is the right call' }
            : QUIET,
      reply: () => ({ chunks: ['Postgres.'], delayMs: 5 }),
      clusters: [['maya', 'theo']],
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: [] });

    expect(startedBy('theo')).toHaveLength(1);
    expect(startedBy('maya')).toHaveLength(0);
    expect(startedBy('priya')).toHaveLength(0);
    // Silent agents emit nothing at all.
    expect(events().filter((e) => e.type === 'message_started')).toHaveLength(1);
  });

  it('mention forces reply even when the bid says no', async () => {
    script({
      gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 2, gist: 'ask Priya' } : QUIET),
      reply: (id) =>
        id === 'maya'
          ? { chunks: ['@Priya ', 'what do ', 'users say?'], delayMs: 5 }
          : { chunks: ['They want ', 'speed.'], delayMs: 5 },
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: [] });

    const maya = startedBy('maya');
    const priya = startedBy('priya');
    expect(maya).toHaveLength(1);
    expect(priya).toHaveLength(1);
    expect(priya[0]!.hop).toBe(1);
    expect(priya[0]!.replyTo).toBe(maya[0]!.messageId);
    expect(priya[0]!.turnId).toBe(maya[0]!.turnId);
    expect(startedBy('theo')).toHaveLength(0);
  });

  it('a mention of an agent who answered in the same wave does not force a repeat', async () => {
    script({
      gate: (id, n) => (n === 0 ? { should_respond: true, novelty: 3, gist: `${id} take` } : QUIET),
      reply: (id) => ({
        chunks: id === 'maya' ? ['@Priya can confirm ', 'the policy and timing.'] : ['Answer ', 'here.'],
        delayMs: 5,
      }),
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
    expect(startedBy('priya')).toHaveLength(1);
    expect(started().every((e) => e.hop === 0)).toBe(true);
  });

  it('bid addresses force the addressed agent next wave', async () => {
    script({
      gate: (id, n) =>
        n === 0 && id === 'theo'
          ? { should_respond: true, novelty: 2, gist: 'question for Maya', addresses: ['maya', 'user'] }
          : QUIET,
      reply: () => ({ chunks: ['Sure.'], delayMs: 5 }),
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
    expect(startedBy('theo').map((e) => e.hop)).toEqual([0]);
    expect(startedBy('maya').map((e) => e.hop)).toEqual([1]);
    expect(startedBy('maya')[0]!.replyTo).toBe('u1'); // addressed, not @mentioned
  });

  it('forced agents from the user speak in wave 0 without gating', async () => {
    script({
      gate: () => QUIET,
      reply: () => ({ chunks: ['Hi.'], delayMs: 5 }),
    });
    await runTurn(actor, { triggerMessageId: 'u1', forced: ['priya'] });
    expect(started().map((e) => [e.agentId, e.hop])).toEqual([['priya', 0]]);
  });

  describe('small talk', () => {
    const say = (text: string) => {
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text });
    };
    const eager = () =>
      script({
        gate: (id, n) => (n === 0 ? { should_respond: true, novelty: 3, gist: `${id} take` } : QUIET),
        reply: (id) => ({ chunks: [id === 'maya' ? '@Theo ' : '', 'hello!'], delayMs: 5 }),
      });

    it('greeting with three eager bidders: at most 2 speakers, no further hops, low effort', async () => {
      eager();
      say('Hi all!');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().length).toBeLessThanOrEqual(SMALL_TALK_CAPS.greeting);
      expect(started().length).toBeGreaterThanOrEqual(1);
      expect(started().every((e) => e.hop === 0)).toBe(true);
    });

    it('thanks gets exactly one reply', async () => {
      eager();
      say('thanks!');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started()).toHaveLength(1);
    });

    it('thanks with every agent quiet still gets one reply', async () => {
      script({ gate: () => QUIET, reply: () => ({ chunks: ['Anytime.'], delayMs: 5 }) });
      say('Thanks!');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started()).toHaveLength(1);
    });

    it('an @mentioned agent takes the only slot', async () => {
      eager();
      say('thanks @Priya');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(started().map((e) => e.agentId)).toEqual(['priya']);
    });

    it('a greeting with a real question is unaffected', async () => {
      eager();
      say('hi all, will we keep Northwind?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().length).toBeGreaterThan(SMALL_TALK_CAPS.greeting);
    });
  });

  describe('exchange terminates', () => {
    it('message budget caps a mention storm', async () => {
      const others: Record<AgentId, string> = { maya: '@Theo @Priya', theo: '@Maya @Priya', priya: '@Maya @Theo' };
      script({
        gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 3, gist: 'start' } : QUIET),
        reply: (id) => ({ chunks: [others[id], ' thoughts?'], delayMs: 5 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });

      const s = started();
      expect(s.length).toBeLessThanOrEqual(BUDGET.maxAgentMessages);
      expect(s.length).toBeGreaterThan(3);
      expect(s.every((e) => e.hop <= BUDGET.maxHops)).toBe(true);
      expect(s.map((e) => e.hop)).toEqual([0, 1, 1, 2, 3, 3].slice(0, s.length));
      expect(actor.generations.size).toBe(0);
    });

    it('hop limit ends a mention chain', async () => {
      const next: Record<AgentId, string> = { maya: '@Theo', theo: '@Priya', priya: '@Maya' };
      script({
        gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 3, gist: 'start' } : QUIET),
        reply: (id) => ({ chunks: [next[id], ' over to you'], delayMs: 5 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });

      const s = started();
      expect(s.map((e) => [e.agentId, e.hop])).toEqual([
        ['maya', 0],
        ['theo', 1],
        ['priya', 2],
        ['maya', 3],
      ]);
      expect(Math.max(...s.map((e) => e.hop))).toBe(BUDGET.maxHops);
      // Each later wave replies to the message that mentioned it.
      for (let i = 1; i < s.length; i++) expect(s[i]!.replyTo).toBe(s[i - 1]!.messageId);
    });

    it('budget cut keeps forced agents before unforced ones', async () => {
      const saved = BUDGET.maxAgentMessages;
      BUDGET.maxAgentMessages = 2; // one slot left after wave 0
      try {
        script({
          gate: (id, n) =>
            id === 'theo' && n === 0
              ? { should_respond: true, novelty: 3, gist: 'ask Priya' }
              : id === 'maya' && n === 1
                ? { should_respond: true, novelty: 3, gist: 'big new point' }
                : QUIET,
          reply: (id) => ({ chunks: [id === 'theo' ? '@Priya your view?' : 'Noted.'], delayMs: 5 }),
        });
        await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
        expect(started().map((e) => [e.agentId, e.hop])).toEqual([
          ['theo', 0],
          ['priya', 1],
        ]);
      } finally {
        BUDGET.maxAgentMessages = saved;
      }
    });

    it('timeout launches no new wave', async () => {
      const saved = BUDGET.turnTimeoutMs;
      BUDGET.turnTimeoutMs = 60;
      try {
        script({
          gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 3, gist: 'x' } : QUIET),
          reply: () => ({ chunks: ['@Theo ', 'slow ', 'reply'], delayMs: 50 }),
        });
        await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
        expect(started().map((e) => e.agentId)).toEqual(['maya']);
      } finally {
        BUDGET.turnTimeoutMs = saved;
      }
    });
  });

  it('new turn stops old waves without aborting in-flight generations', async () => {
    script({
      gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 3, gist: 'ask Theo' } : QUIET),
      reply: (id) =>
        id === 'maya'
          ? { chunks: ['@Theo ', 'what ', 'do ', 'you ', 'think ', 'here?'], delayMs: 40 }
          : { chunks: ['Quick.'], delayMs: 5 },
    });
    const turnA = runTurn(actor, { triggerMessageId: 'u1', forced: [] });
    await waitFor(() => startedBy('maya').length === 1 && actor.view.messages.some((m) => m.text.length > 0));
    const turnIdA = startedBy('maya')[0]!.turnId;
    const ctrlA = actor.turnAbort;

    actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: 'Also, pricing?' });
    const turnB = runTurn(actor, { triggerMessageId: 'u2', forced: [] });
    expect(ctrlA?.signal.aborted).toBe(true);
    await Promise.all([turnA, turnB]);

    const a = started().filter((e) => e.turnId === turnIdA);
    expect(a.map((e) => [e.agentId, e.hop])).toEqual([['maya', 0]]);
    // Turn A's in-flight message was not aborted.
    const mayaMsg = actor.view.messages.find((m) => m.id === a[0]!.messageId);
    expect(mayaMsg?.status).toBe('done');
    expect(mayaMsg?.text).toBe('@Theo what do you think here?');
    // Turn B ran while Maya was live: she was not gated or selected.
    const b = started().filter((e) => e.turnId !== turnIdA);
    expect(b.length).toBeGreaterThanOrEqual(1);
    expect(b.every((e) => e.agentId !== 'maya' && e.replyTo === 'u2')).toBe(true);
    expect(actor.turnAbort).toBeNull();
  });

  describe('hung gates', () => {
    const SHORT_MS = 50;
    beforeEach(() => {
      const real = AbortSignal.timeout.bind(AbortSignal);
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => real(ms === GATE_TIMEOUT_MS ? SHORT_MS : ms));
    });

    it('a hanging gate counts as a declined bid', async () => {
      hooks.hang = (m) => m.kind === 'gate' && m.agentId === 'theo';
      script({
        gate: (id, n) => (id === 'maya' && n === 0 ? { should_respond: true, novelty: 2, gist: 'x' } : QUIET),
        reply: () => ({ chunks: ['Done.'], delayMs: 5 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => [e.agentId, e.hop])).toEqual([['maya', 0]]);
      expect(AbortSignal.timeout).toHaveBeenCalledWith(GATE_TIMEOUT_MS);
    });

    it('hop 0 still has a speaker when every gate hangs', async () => {
      hooks.hang = (m) => m.kind === 'gate';
      script({ gate: () => QUIET, reply: () => ({ chunks: ['Hi.'], delayMs: 5 }) });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => [e.agentId, e.hop])).toEqual([['maya', 0]]);
    });

    it('a hanging dedup degrades to singletons', async () => {
      hooks.hang = (m) => m.kind === 'dedup';
      script({
        gate: (id, n) => (n === 0 && id !== 'priya' ? { should_respond: true, novelty: 2, gist: `${id} point` } : QUIET),
        reply: () => ({ chunks: ['Ok.'], delayMs: 5 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => e.agentId)).toEqual(['maya', 'theo']);
    });

    it('a real turn abort during gating still ends the turn', async () => {
      hooks.hang = (m) => m.kind === 'gate';
      script({ gate: () => QUIET, reply: () => ({ chunks: ['Hi.'], delayMs: 5 }) });
      const turn = runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      await sleep(5);
      actor.turnAbort?.abort();
      await turn;
      await sleep(SHORT_MS * 2);
      expect(started()).toEqual([]);
    });
  });
});
