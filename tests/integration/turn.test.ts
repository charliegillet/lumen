import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript, type FakeReply } from '../../src/server/llm/fake.js';
import { setStreamTimeouts } from '../../src/server/llm/stream.js';
import { reopenGeneration } from '../../src/server/orchestrator/generation.js';
import { BUDGET, GATE_GRACE_MS, GATE_TIMEOUT_MS, NAMED_GATE_MS, SMALL_TALK_CAPS, runTurn } from '../../src/server/orchestrator/turn.js';
import type { AgentId, ConvEvent } from '../../src/shared/events.js';

// Lets a test make chosen structured calls (gate/dedup) hang until their
// signal aborts, like a provider that never answers.
const hooks = vi.hoisted(() => ({
  hang: null as null | ((meta: { kind: string; agentId?: string }) => boolean),
  delay: null as null | ((meta: { kind: string; agentId?: string }) => Promise<void> | undefined),
}));
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
    generateStructured: (async (a: Parameters<typeof m.generateStructured>[0]) => {
      const wait = hooks.delay?.(a.meta);
      if (wait) await wait;
      return hooks.hang?.(a.meta) ? hangUntilAbort(a.signal) : m.generateStructured(a);
    }) as typeof m.generateStructured,
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
  hooks.delay = null;
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
  hooks.delay = null;
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

  describe('who may answer', () => {
    const say = (text: string) => {
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text });
    };
    const eager = () => (_id: AgentId, _n: number): GateAns => ({ should_respond: true, novelty: 3, gist: 'keen' });
    const plain = () => ({ chunks: ['An answer.'], delayMs: 2 });
    const whoSpoke = () => started().map((e) => [e.agentId, e.hop]);

    it('one name: only that agent speaks and the others are not even asked', async () => {
      script({ gate: eager(), reply: plain });
      say('@Theo what is the status');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['theo'] });
      expect(whoSpoke()).toEqual([['theo', 0]]);
      expect(fakeRequests.filter((r) => r.kind === 'gate').map((r) => r.agentId)).toEqual(['theo']);
    });

    it('two names: only those two, in the order named', async () => {
      script({ gate: eager(), reply: plain });
      say('Priya and Maya, what is the status?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya', 'maya'] });
      expect(whoSpoke()).toEqual([
        ['priya', 0],
        ['maya', 0],
      ]);
    });

    it('a named agent that @mentions a third pulls it in, and nobody else', async () => {
      script({
        gate: eager(),
        reply: (id) => ({ chunks: [id === 'theo' ? '@Priya what is the cash position?' : 'Twelve months.'], delayMs: 2 }),
      });
      say('@Theo can we afford the discount?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['theo'] });
      expect(whoSpoke()).toEqual([
        ['theo', 0],
        ['priya', 1],
      ]);
    });

    it('a named agent bid that merely addresses someone pulls nobody in', async () => {
      script({ gate: () => ({ should_respond: true, novelty: 3, gist: 'g', addresses: ['maya'] }), reply: plain });
      say('@Theo status?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['theo'] });
      expect(whoSpoke()).toEqual([['theo', 0]]);
    });

    it('a named agent speaks even when every gate declines; the fallback does not add anyone', async () => {
      script({ gate: () => QUIET, reply: plain });
      say('@Priya what is the status');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(whoSpoke()).toEqual([['priya', 0]]);
    });

    it('"only Priya" holds for the whole turn, even if she @mentions someone', async () => {
      script({ gate: eager(), reply: () => ({ chunks: ['@Theo can you confirm?'], delayMs: 2 }) });
      say('Only Priya answer this: will we keep Northwind?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(whoSpoke()).toEqual([['priya', 0]]);
    });

    it('"just you" and "nobody else" hold too', async () => {
      script({ gate: eager(), reply: () => ({ chunks: ['@Maya thoughts?'], delayMs: 2 }) });
      say('Priya, just you please: are we okay on cash?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(whoSpoke()).toEqual([['priya', 0]]);
    });

    it('"one of you" gets one answer and no follow-up', async () => {
      script({ gate: eager(), reply: () => ({ chunks: ['@Maya thoughts?'], delayMs: 2 }) });
      say('Just one of you answer: is it Tuesday?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started()).toHaveLength(1);
    });

    it('"Everyone:" makes everyone answer even when every gate declines', async () => {
      script({ gate: () => QUIET, reply: plain });
      say("Everyone: what's your opinion on the office dog policy?");
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().map((e) => e.agentId).sort()).toEqual(['maya', 'priya', 'theo']);
    });

    it('a broadcast greeting stays capped', async () => {
      script({ gate: eager(), reply: plain });
      say('hey all of you');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().length).toBeLessThanOrEqual(SMALL_TALK_CAPS.greeting);
    });

    it('an unaddressed message still goes through the gates', async () => {
      script({ gate: (id, n) => (n === 0 && id === 'priya' ? eager()(id, n) : QUIET), reply: plain });
      say('What is our runway?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(whoSpoke()).toEqual([['priya', 0]]);
    });
  });

  describe('speaker order', () => {
    it('the most novel bid starts first, without waiting for dedup', async () => {
      let releaseDedup!: () => void;
      hooks.delay = (m) => (m.kind === 'dedup' ? new Promise<void>((r) => (releaseDedup = r)) : undefined);
      script({
        gate: (id, n) => (n === 0 ? { should_respond: true, novelty: id === 'priya' ? 3 : 1, gist: `${id} take` } : QUIET),
        reply: () => ({ chunks: ['Ok.'], delayMs: 2 }),
        clusters: [['maya'], ['theo'], ['priya']],
      });
      const turn = runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      await waitFor(() => started().length === 1);
      expect(started()[0]!.agentId).toBe('priya');
      releaseDedup();
      await turn;
      expect(started()[0]!.agentId).toBe('priya');
      expect(started().map((e) => e.agentId).slice(1)).toEqual(['maya', 'theo']);
    });

    it('a clustered bidder stays quiet when the first speaker holds its point', async () => {
      script({
        gate: (id, n) => (n === 0 && id !== 'priya' ? { should_respond: true, novelty: 2, gist: 'same' } : QUIET),
        reply: () => ({ chunks: ['Ok.'], delayMs: 2 }),
        clusters: [['maya', 'theo']],
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => e.agentId)).toEqual(['maya']);
    });
  });

  describe('fallback', () => {
    it('takes the agent who spoke least recently, briefly, with no follow-up', async () => {
      for (const [i, id] of (['maya', 'priya'] as AgentId[]).entries()) {
        actor.append({ type: 'message_started', messageId: `m${i}`, agentId: id, turnId: 'old', hop: 0, replyTo: 'u1', contextCutoffSeq: actor.lastSeq, effort: 'low' });
        actor.append({ type: 'message_completed', messageId: `m${i}` });
      }
      script({ gate: () => QUIET, reply: () => ({ chunks: ['@Maya nope'], delayMs: 2 }) });
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: 'anyone free for lunch?' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      const fresh = started().filter((e) => e.turnId !== 'old');
      expect(fresh.map((e) => [e.agentId, e.effort])).toEqual([['theo', 'low']]);
      expect(String(fakeRequests.findLast((r) => r.kind === 'reply')?.prompt)).toContain('few words');
    });

    it('spreads ties across agents instead of always picking the first', async () => {
      const picks = new Set<string>();
      for (const text of ['anyone free?', "what's 2+2?", 'lunch?', 'nice weather', 'any ideas?', 'who knows?']) {
        const d = openDb(':memory:');
        const a = new ConversationActor(d, 'tie');
        script({ gate: () => QUIET, reply: () => ({ chunks: ['Ok.'], delayMs: 1 }) });
        a.append({ type: 'user_message', messageId: 'u', clientMsgId: 'c', text });
        await runTurn(a, { triggerMessageId: 'u', forced: [] });
        for (const e of a.eventsAfter(0)) if (e.type === 'message_started') picks.add(e.agentId);
        d.close();
      }
      expect(picks.size).toBeGreaterThan(1);
    });
  });

  describe('gate failures', () => {
    it('every gate down: the agents the words point at answer at medium', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setFakeScript((r): FakeReply => (r.kind === 'gate' ? { error: 'down' } : { chunks: ['Ok.'], delayMs: 1 }));
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: 'how is the runway looking?' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().map((e) => [e.agentId, e.effort])).toEqual([['priya', 'medium']]);
    });

    it('every gate down and no hint in the words: everyone answers', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      setFakeScript((r): FakeReply => (r.kind === 'gate' ? { error: 'down' } : { chunks: ['Ok.'], delayMs: 1 }));
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: 'what do you think?' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      expect(started().map((e) => e.agentId).sort()).toEqual(['maya', 'priya', 'theo']);
    });

    it('a fenced or sloppy bid still counts', async () => {
      setFakeScript((r): FakeReply =>
        r.kind === 'gate'
          ? {
              chunks: [
                r.agentId === 'theo' && !fakeRequests.some((x) => x.kind === 'reply')
                  ? '<think>hm</think>```json\n{"should_respond": true, "novelty": 7, "gist": "renewal risk", "addresses": ["USER"], "effort": "HIGH"}\n```'
                  : '{"should_respond": false, "novelty": 0, "gist": "", "addresses": [], "effort": "low"}',
              ],
              delayMs: 0,
            }
          : { chunks: ['Ok.'], delayMs: 1 },
      );
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => [e.agentId, e.effort])).toEqual([['theo', 'high']]);
    });

    it('a hung gate only costs the others a short grace once someone answered', async () => {
      hooks.hang = (m) => m.kind === 'gate' && m.agentId === 'theo';
      const real = setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
        real(fn, ms === GATE_GRACE_MS ? 40 : ms)) as typeof setTimeout);
      script({
        gate: (id, n) => (id === 'maya' && n === 0 ? { should_respond: true, novelty: 2, gist: 'x' } : QUIET),
        reply: () => ({ chunks: ['Done.'], delayMs: 1 }),
      });
      const t0 = Date.now();
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => e.agentId)).toEqual(['maya']);
      expect(Date.now() - t0).toBeLessThan(GATE_TIMEOUT_MS / 2);
    });

    it('a named agent does not wait out a hung gate', async () => {
      hooks.hang = (m) => m.kind === 'gate';
      const real = setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) =>
        real(fn, ms === NAMED_GATE_MS ? 20 : ms)) as typeof setTimeout);
      script({ gate: () => QUIET, reply: () => ({ chunks: ['Hi.'], delayMs: 1 }) });
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: '@Theo status?' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['theo'] });
      expect(started().map((e) => [e.agentId, e.effort])).toEqual([['theo', 'medium']]);
    });
  });

  describe('effort', () => {
    it('a named agent gets the effort and gist of its own bid', async () => {
      script({
        gate: () => ({ should_respond: true, novelty: 2, gist: 'full model', effort: 'high' } as GateAns),
        reply: () => ({ chunks: ['Long.'], delayMs: 1 }),
      });
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: '@Priya be exhaustive' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(started()[0]).toMatchObject({ agentId: 'priya', effort: 'high' });
      expect(fakeRequests.find((r) => r.kind === 'reply')?.prompt).toContain('full model');
    });

    it('a named agent whose gate would decline answers at medium, with no gist', async () => {
      script({ gate: () => QUIET, reply: () => ({ chunks: ['Ok.'], delayMs: 1 }) });
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text: '@Priya hello there friend' });
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['priya'] });
      expect(started()[0]).toMatchObject({ agentId: 'priya', effort: 'medium' });
    });

    it('a teammate pulled in at a later hop answers at low', async () => {
      script({
        gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 2, gist: 'x', effort: 'high' } as GateAns : QUIET),
        reply: (id) => ({ chunks: [id === 'maya' ? '@Theo what is the renewal date?' : 'June.'], delayMs: 1 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => [e.agentId, e.effort])).toEqual([
        ['maya', 'high'],
        ['theo', 'low'],
      ]);
    });
  });

  describe('thinking together', () => {
    const say = (text: string) => {
      actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'cm2', text });
    };
    const hopsBy = () => started().map((e) => `${e.agentId}@${e.hop}`);
    const allKeen = (_id: AgentId, n: number): GateAns =>
      n === 0 ? { should_respond: true, novelty: 3, gist: 'view' } : QUIET;
    const said = () => ({ chunks: ['My view.'], delayMs: 1 });

    it('named debaters react to each other, then one closes', async () => {
      script({ gate: allKeen, reply: said });
      say('Maya and Theo, argue it out: ship SSO-lite or hold? I want you two to debate.');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['maya', 'theo'] });
      expect(hopsBy()).toEqual(['maya@0', 'theo@0', 'maya@1', 'theo@1', 'maya@2']);
    });

    it('a joint answer gets one reaction, then the agreed answer', async () => {
      script({ gate: allKeen, reply: said });
      say('Give me one single joint recommendation on SSO-lite.');
      await runTurn(actor, { triggerMessageId: 'u2', forced: [] });
      const replies = started();
      expect(replies.filter((e) => e.hop === 0)).toHaveLength(3);
      expect(replies.filter((e) => e.hop === 1)).toHaveLength(1);
      expect(replies.filter((e) => e.hop === 2)).toHaveLength(1);
      expect(fakeRequests.findLast((r) => r.kind === 'reply')?.prompt).toContain('joint recommendation');
    });

    it('a lone debater gets the partner the person named', async () => {
      script({ gate: allKeen, reply: said });
      say('Maya, debate this with Priya: hire now?');
      await runTurn(actor, { triggerMessageId: 'u2', forced: ['maya'] });
      expect(hopsBy()).toEqual(['maya@0', 'priya@1', 'maya@2']);
    });

    it('stop ends a debate between waves', async () => {
      script({ gate: allKeen, reply: said });
      say('Maya and Theo, debate it');
      const turn = runTurn(actor, { triggerMessageId: 'u2', forced: ['maya', 'theo'] });
      await waitFor(() => started().some((e) => e.hop === 1));
      actor.turnAbort?.abort();
      await turn;
      expect(started().every((e) => e.hop <= 1)).toBe(true);
    });

    it('a real question to a teammate who answered in the same first wave brings it back', async () => {
      script({
        gate: allKeen,
        reply: (id, n) => ({ chunks: [id === 'maya' && n === 0 ? '@Priya what does a slip cost us?' : 'Answer here.'], delayMs: 1 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(startedBy('priya').map((e) => e.hop)).toEqual([0, 1]);
      expect(startedBy('priya')[1]!.replyTo).toBe(startedBy('maya')[0]!.messageId);
    });

    it('at hop 1 one agent from the first wave may come back; the rest wait', async () => {
      script({
        gate: (id, n) =>
          n === 0
            ? { should_respond: true, novelty: 3, gist: `${id} take` }
            : n === 1 && id !== 'theo'
              ? { should_respond: true, novelty: id === 'priya' ? 3 : 2, gist: `${id} adds` }
              : QUIET,
        reply: () => ({ chunks: ['Noted.'], delayMs: 1 }),
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().filter((e) => e.hop === 1).map((e) => e.agentId)).toEqual(['priya']);
    });

    it('a later gist that repeats the chat stays quiet', async () => {
      setFakeScript((r): FakeReply => {
        if (r.kind === 'gate') {
          const first = !fakeRequests.some((x) => x.kind === 'reply');
          return {
            object: {
              should_respond: first ? r.agentId === 'priya' : r.agentId === 'theo',
              novelty: 3,
              gist: 'runway is 14 months',
              addresses: [],
              effort: 'low',
            },
          };
        }
        if (r.kind === 'dedup') return { object: { clusters: [['already_said', 'theo']] } };
        return { chunks: ['Runway is 14 months.'], delayMs: 1 };
      });
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      expect(started().map((e) => e.agentId)).toEqual(['priya']);
    });
  });

  describe('steers and later waves', () => {
    it('a forced wave skips an agent a steer just reopened', async () => {
      let gateN = 0;
      script({
        gate: (id, n) => (id === 'priya' && n === 0 ? { should_respond: true, novelty: 2, gist: 'x' } : QUIET),
        reply: (id) => ({ chunks: [id === 'priya' ? '@Maya when can it ship?' : 'Maya here.'], delayMs: 2 }),
      });
      actor.append({ type: 'message_started', messageId: 'old', agentId: 'maya', turnId: 'o', hop: 0, replyTo: 'u1', contextCutoffSeq: actor.lastSeq, effort: 'low' });
      actor.append({ type: 'token_delta', messageId: 'old', segment: 0, offset: 0, text: 'Earlier.' });
      actor.append({ type: 'message_completed', messageId: 'old' });
      hooks.delay = (m) => {
        // Hop 1's gate is the moment between waves; a steer reopens Maya there.
        if (m.kind === 'gate' && started().some((e) => e.agentId === 'priya') && gateN++ === 0) {
          reopenGeneration(actor, 'old', ['one line'], { moved: true });
        }
        return undefined;
      };
      await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      await waitFor(() => actor.generations.size === 0);
      expect(startedBy('maya').filter((e) => e.turnId !== 'o')).toEqual([]);
    });

    it('a mention that a steer rewrote away no longer pulls anyone in', async () => {
      let releaseReply!: () => void;
      const hold = new Promise<void>((r) => (releaseReply = r));
      void hold;
      setFakeScript((r): FakeReply => {
        if (r.kind === 'gate')
          return { object: { should_respond: r.agentId === 'maya' && !fakeRequests.some((x) => x.kind === 'reply'), novelty: 3, gist: 'g', addresses: [], effort: 'low' } };
        if (r.kind === 'replace') return { chunks: ['No question after all.'], delayMs: 1 };
        return { chunks: ['@Theo ', 'what ', 'do ', 'you ', 'think?'], delayMs: 8 };
      });
      releaseReply();
      const turn = runTurn(actor, { triggerMessageId: 'u1', forced: [] });
      await waitFor(() => actor.view.messages.some((m) => m.status === 'streaming'));
      const g = [...actor.generations.values()][0]!;
      await g.done;
      reopenGeneration(actor, g.messageId, ['no questions'], { moved: true });
      await turn;
      expect(started().map((e) => e.agentId)).toEqual(['maya']);
    });
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
      // The clock jumps past the budget once the first wave has started, so the
      // result does not depend on how fast the machine is.
      const saved = BUDGET.turnTimeoutMs;
      BUDGET.turnTimeoutMs = 1000;
      let skew = 0;
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
      const off = actor.subscribe((e) => {
        if (e.type === 'message_started') skew = 60_000;
      });
      try {
        script({
          gate: (id, n) => (n === 0 && id === 'maya' ? { should_respond: true, novelty: 3, gist: 'x' } : QUIET),
          reply: () => ({ chunks: ['@Theo ', 'slow ', 'reply'], delayMs: 50 }),
        });
        await runTurn(actor, { triggerMessageId: 'u1', forced: [] });
        expect(started().map((e) => e.agentId)).toEqual(['maya']);
      } finally {
        off();
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
