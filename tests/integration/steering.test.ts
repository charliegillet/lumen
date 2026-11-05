import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor, getActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript, type FakeReply } from '../../src/server/llm/fake.js';
import { buildPrompt } from '../../src/server/agents/prompt.js';
import { startGeneration, type Generation } from '../../src/server/orchestrator/generation.js';
import {
  QUEUE_DRIP_MS,
  QUEUE_STALL_MS,
  RECOVER_REPLY_MS,
  handleStop,
  handleUserMessage,
  keepStanding,
  shown,
  type SendInput,
} from '../../src/server/steering/handle.js';
import type { SteerDecision } from '../../src/server/steering/classify.js';
import type { AgentId, ConvEvent } from '../../src/shared/events.js';

// Lets a test hold chosen structured calls (gate, classify, judge): `before`
// may return a promise the call waits on first (a delay, or a hang until abort).
type Meta = { kind: string; agentId?: string };
const hooks = vi.hoisted(() => ({
  before: null as null | ((meta: Meta, signal?: AbortSignal) => Promise<void> | undefined),
}));
vi.mock('../../src/server/llm/stream.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/server/llm/stream.js')>();
  return {
    ...m,
    generateStructured: (async (a: Parameters<typeof m.generateStructured>[0]) => {
      const wait = hooks.before?.(a.meta, a.signal);
      if (wait) await wait;
      return m.generateStructured(a);
    }) as typeof m.generateStructured,
  };
});
const hangUntilAbort = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    if (signal?.aborted) fail();
    else signal?.addEventListener('abort', fail, { once: true });
  });

const UNSTEERED = (id: string) => Array.from({ length: 10 }, (_, i) => `${id}${i} `);
const STEERED = ['STEERED: ', 'short', ' answer.'];
const unsteeredText = (id: string) => UNSTEERED(id).join('');

const NEW_MESSAGE: SteerDecision = {
  kind: 'new_message',
  targets: [],
  apply: 'continue',
  scope: 'one_off',
  standing_text: null,
  revokes: [],
};
const steer = (targets: AgentId[], apply: 'continue' | 'replace' = 'continue'): SteerDecision => ({
  ...NEW_MESSAGE,
  kind: 'steer',
  targets,
  apply,
});

interface Script {
  classify: (text: string) => SteerDecision;
  judge: (n: number) => FakeReply;
  gate: (agentId: AgentId, prompt: string) => boolean;
}
let s: Script;
let judgeCalls = 0;

function install(): void {
  setFakeScript((r): FakeReply => {
    const id = r.agentId ?? 'agent';
    switch (r.kind) {
      case 'reply':
        return { chunks: UNSTEERED(id), delayMs: 30 };
      case 'continue':
      case 'replace':
        return { chunks: STEERED, delayMs: 30 };
      case 'classify': {
        const text = /The human's new message:\n([\s\S]*)$/.exec(r.prompt ?? '')?.[1] ?? '';
        return { object: s.classify(text) };
      }
      case 'judge':
        return s.judge(judgeCalls++);
      case 'gate': {
        const prompt = JSON.stringify(r.messages);
        const yes = s.gate(id as AgentId, prompt);
        return {
          object: { should_respond: yes, novelty: yes ? 2 : 0, gist: yes ? `${id} point` : '', addresses: [], effort: 'low' },
        };
      }
      case 'dedup': {
        const ids = [...(r.prompt ?? '').matchAll(/^(maya|theo|priya): /gm)].map((m) => [m[1]!]);
        return { object: { clusters: ids } };
      }
    }
  });
}

let db: Db;
let actor: ConversationActor;
beforeEach(() => {
  process.env.MODEL_AGENT = 'fake:x';
  process.env.MODEL_GATE = 'fake:x';
  process.env.MODEL_CLASSIFIER = 'fake:x';
  resetFake();
  hooks.before = null;
  judgeCalls = 0;
  s = {
    classify: () => NEW_MESSAGE,
    judge: () => ({ object: { complies: true } }),
    gate: () => false,
  };
  install();
  db = openDb(':memory:');
  actor = new ConversationActor(db, 'c1');
  actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'cm1', text: 'What should we build?' });
});
afterEach(async () => {
  await waitFor(() => actor.generations.size === 0 && actor.turnAbort === null, 5000).catch(() => {});
  delete process.env.MODEL_AGENT;
  delete process.env.MODEL_GATE;
  delete process.env.MODEL_CLASSIFIER;
  resetFake();
  hooks.before = null;
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

function start(agentId: AgentId): Generation {
  return startGeneration(actor, {
    agentId,
    turnId: 't1',
    hop: 0,
    replyTo: 'u1',
    effort: 'low',
    gist: `${agentId} point`,
    othersReplying: [],
  });
}
function startAll(): Record<AgentId, Generation> {
  return { maya: start('maya'), theo: start('theo'), priya: start('priya') };
}

let n = 0;
function send(text: string, o: Partial<SendInput> = {}) {
  return handleUserMessage(actor, {
    clientMsgId: o.clientMsgId ?? `c-${++n}`,
    text,
    typingStartedAt: o.typingStartedAt ?? null,
    rendered: o.rendered ?? renderedNow(),
  });
}
/** What a client would report: everything committed so far. */
function renderedNow(): Record<string, number> {
  const r: Record<string, number> = {};
  for (const g of actor.generations.values()) r[g.messageId] = g.textSoFar().length;
  return r;
}

const events = () => actor.eventsAfter(0);
const eventsFor = (id: string): ConvEvent[] => events().filter((e) => 'messageId' in e && e.messageId === id);
const segmentsFor = (id: string) => eventsFor(id).filter((e) => e.type === 'message_segment_started');
const msg = (id: string) => actor.view.messages.find((m) => m.id === id);
const resolved = () =>
  events().filter((e): e is Extract<ConvEvent, { type: 'steer_resolved' }> => e.type === 'steer_resolved');
const startedBy = (id: AgentId) =>
  events().filter((e): e is Extract<ConvEvent, { type: 'message_started' }> => e.type === 'message_started' && e.agentId === id);
const steerRequests = (id: AgentId) =>
  fakeRequests.filter((r) => (r.kind === 'continue' || r.kind === 'replace') && r.agentId === id);
const idle = () => waitFor(() => actor.generations.size === 0, 5000);

describe('handleUserMessage: steering', () => {
  it('names win over "each of you": every named agent answers though no gate would', async () => {
    const { settled } = await send('@Maya @Theo @Priya quick gut check from each of you: do we take it on?');
    await settled;
    for (const id of ['maya', 'theo', 'priya'] as const) expect(startedBy(id)).toHaveLength(1);
  });

  it('steer one by name, others continue', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const r = await send('@Theo one sentence');
    await r.settled;
    await idle();

    expect(segmentsFor(g.theo.messageId)).toHaveLength(1);
    for (const id of ['maya', 'priya'] as const) {
      const evs = eventsFor(g[id].messageId);
      expect(evs.some((e) => e.type === 'message_segment_started')).toBe(false);
      expect(evs.every((e) => e.type !== 'token_delta' || e.segment === 0)).toBe(true);
      expect(msg(g[id].messageId)?.text).toBe(unsteeredText(id));
      expect(msg(g[id].messageId)?.status).toBe('done');
    }
    const req = steerRequests('theo');
    expect(req).toHaveLength(1);
    expect(req[0]?.prompt).toContain('one sentence');
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
  });

  it('steer takes effect in same answer', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    const before = g.theo.textSoFar();
    s.classify = () => steer(['theo']);
    await (await send('@Theo one sentence')).settled;
    await idle();

    expect(startedBy('theo')).toHaveLength(1);
    const m = msg(g.theo.messageId)!;
    expect(m.status).toBe('done');
    expect(m.text).toContain('STEERED:');
    expect(m.text.startsWith(before)).toBe(true); // continue keeps what was shown
    expect(steerRequests('theo')[0]?.kind).toBe('continue');
  });

  it('replace on contradicting steer', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo'], 'replace');
    await (await send('@Theo actually, answer in French')).settled;
    await idle();

    const m = msg(g.theo.messageId)!;
    expect(m.text).toBe(STEERED.join(''));
    expect(segmentsFor(g.theo.messageId)[0]).toMatchObject({ truncateTo: 0, mode: 'replace' });
  });

  it('continue truncates to what the client rendered', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length >= 6);
    s.classify = () => steer(['theo']);
    const shown = g.theo.textSoFar().slice(0, 3);
    await (await send('@Theo one sentence', { rendered: { [g.theo.messageId]: 3 } })).settled;
    expect(msg(g.theo.messageId)?.text).toBe(shown + STEERED.join(''));
  });

  it('broadcast steer with no named target steers everyone writing', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    s.classify = () => steer([]);
    await (await send('keep it short')).settled;
    await idle();
    for (const id of ['maya', 'theo', 'priya'] as const) {
      expect(segmentsFor(g[id].messageId)).toHaveLength(1);
      expect(msg(g[id].messageId)?.text).toContain('STEERED:');
    }
    expect([...(resolved().at(-1)?.targets ?? [])].sort()).toEqual(['maya', 'priya', 'theo']);
  });

  it('rapid double steer coalesces', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const a = await send('@Theo shorter');
    const b = await send('@Theo mention pricing');
    await Promise.all([a.settled, b.settled]);
    await idle();

    const last = steerRequests('theo').at(-1);
    // Both steers in one block (classifier replies may land in either order).
    expect(last?.prompt).toMatch(/«@Theo (shorter|mention pricing) \/ @Theo (shorter|mention pricing)»/);
    expect(last?.prompt).toContain('shorter');
    expect(last?.prompt).toContain('mention pricing');
    expect(startedBy('theo')).toHaveLength(1);
    expect(msg(g.theo.messageId)?.text).toContain('STEERED:');
    expect(resolved()).toHaveLength(2);
  });

  it('a steer after the first steered token starts a fresh list', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const a = await send('@Theo shorter');
    await waitFor(() => g.theo.segment === 1 && g.theo.firstTokenSeen);
    const b = await send('@Theo mention pricing');
    await Promise.all([a.settled, b.settled]);
    const last = steerRequests('theo').at(-1);
    // The steer block names only the new steer (history still shows both messages).
    expect(last?.prompt).toContain('just said: «@Theo mention pricing»');
    expect(segmentsFor(g.theo.messageId)).toHaveLength(2);
  });

  it('"Theo wait, focus on pricing" redirects Theo instead of stopping him', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('Theo wait, focus on pricing')).settled;
    await idle();

    expect(events().some((e) => e.type === 'stop_all' || e.type === 'message_aborted')).toBe(false);
    expect(segmentsFor(g.theo.messageId)).toHaveLength(1);
    expect(steerRequests('theo')[0]?.prompt).toContain('«Theo wait, focus on pricing»');
    expect(msg(g.theo.messageId)?.text).toContain('STEERED:');
    for (const id of ['maya', 'priya'] as const) {
      expect(segmentsFor(g[id].messageId)).toHaveLength(0);
      expect(msg(g[id].messageId)?.text).toBe(unsteeredText(id));
    }
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
  });

  it('"wait, what about pricing?" while streaming is classified, not a stop', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    s.classify = () => NEW_MESSAGE;
    await (await send('wait, what about pricing?')).settled;
    await idle();

    expect(fakeRequests.some((r) => r.kind === 'classify' && r.prompt?.includes('wait, what about pricing?'))).toBe(true);
    expect(events().some((e) => e.type === 'stop_all' || e.type === 'message_aborted')).toBe(false);
    for (const id of ['maya', 'theo', 'priya'] as const) {
      expect(msg(g[id].messageId)?.text).toBe(unsteeredText(id));
      expect(msg(g[id].messageId)?.status).toBe('done');
    }
    expect(resolved().at(-1)).toMatchObject({ targets: [] });
  });

  it('a merged steer keeps the first steer\'s truncate point', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length >= 6);
    const shownText = g.theo.textSoFar().slice(0, 4);
    s.classify = () => steer(['theo']);
    const a = await send('@Theo shorter', { rendered: { [g.theo.messageId]: 4 } });
    // A stale client count from before the first restart must not cut further.
    const b = await send('@Theo mention pricing', { rendered: { [g.theo.messageId]: 1 } });
    await Promise.all([a.settled, b.settled]);
    const segs = segmentsFor(g.theo.messageId);
    expect(segs).toHaveLength(2);
    expect(segs.map((e) => (e.type === 'message_segment_started' ? e.truncateTo : -1))).toEqual([4, 4]);
    expect(msg(g.theo.messageId)?.text).toBe(shownText + STEERED.join(''));
  });

  it('an agent that gated in during classification is not forced again', async () => {
    let releaseClassify!: () => void;
    hooks.before = (meta) =>
      meta.kind === 'classify' ? new Promise<void>((r) => (releaseClassify = r)) : undefined;
    const r = await send('Maya, thoughts?');
    await waitFor(() => releaseClassify !== undefined);
    // A running turn's gate let Maya in after the message was sent.
    const maya = start('maya');
    releaseClassify();
    await r.settled;
    await maya.done;
    await idle();
    expect(startedBy('maya')).toHaveLength(1);
    expect(resolved().at(-1)).toMatchObject({ targets: [] });
  });

  it('idempotent send', async () => {
    const a = await send('hello', { clientMsgId: 'dup' });
    const b = await send('hello', { clientMsgId: 'dup' });
    await Promise.all([a.settled, b.settled]);
    expect(b.seq).toBe(a.seq);
    expect(events().filter((e) => e.type === 'user_message' && e.clientMsgId === 'dup')).toHaveLength(1);
    expect(resolved()).toHaveLength(1);
  });

  it('returns the seq before the classifier answers', async () => {
    const r = await send('hello');
    expect(r.seq).toBe(actor.view.messages.at(-1)?.startSeq);
    expect(actor.view.messages.at(-1)?.text).toBe('hello');
    expect(resolved()).toHaveLength(0);
    await r.settled;
    expect(resolved()).toHaveLength(1);
  });

  it('Review Focus 1: steer just after finish rewrites in place', async () => {
    const theo = start('theo');
    await theo.done;
    await sleep(500);
    s.classify = () => steer(['theo']);
    await (await send('@Theo shorter')).settled;
    await idle();

    expect(startedBy('theo')).toHaveLength(1);
    expect(segmentsFor(theo.messageId)).toHaveLength(1);
    expect(segmentsFor(theo.messageId)[0]).toMatchObject({ mode: 'replace', truncateTo: 0 });
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
    expect(msg(theo.messageId)?.status).toBe('done');
    expect(steerRequests('theo')[0]?.kind).toBe('replace');
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
  });

  it('the rewrite window counts from when the steer was sent, not when it was classified', async () => {
    const theo = start('theo');
    await theo.done;
    await sleep(1000);
    hooks.before = (meta) => (meta.kind === 'classify' ? sleep(1500) : undefined);
    s.classify = () => steer(['theo']);
    await (await send('@Theo shorter')).settled;
    await idle();
    expect(startedBy('theo')).toHaveLength(1);
    expect(segmentsFor(theo.messageId)).toHaveLength(1);
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
  });

  /** A completed Theo message whose completion is 5 s in the past. */
  function oldTheoMessage(): number {
    const past = Date.now() - 5000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(past);
    actor.append({
      type: 'message_started',
      messageId: 'old',
      agentId: 'theo',
      turnId: 't0',
      hop: 0,
      replyTo: 'u1',
      contextCutoffSeq: actor.lastSeq,
      effort: 'low',
    });
    actor.append({ type: 'token_delta', messageId: 'old', segment: 0, offset: 0, text: 'A long old answer.' });
    actor.append({ type: 'message_completed', messageId: 'old' });
    spy.mockRestore();
    return past;
  }

  it('steer typed before an older message completed still rewrites it', async () => {
    const completedAt = oldTheoMessage();
    s.classify = () => steer(['theo']);
    await (await send('@Theo shorter', { typingStartedAt: completedAt - 100 })).settled;
    expect(segmentsFor('old')).toHaveLength(1);
    expect(msg('old')?.text).toBe(STEERED.join(''));
    expect(startedBy('theo')).toHaveLength(1);
  });

  it('steer at an agent that finished long ago gets a fresh reply', async () => {
    oldTheoMessage();
    s.classify = () => steer(['theo']);
    await (await send('@Theo shorter')).settled;
    expect(segmentsFor('old')).toHaveLength(0);
    expect(msg('old')?.text).toBe('A long old answer.');
    expect(startedBy('theo')).toHaveLength(2);
    expect(resolved().at(-1)).toMatchObject({ targets: [] });
  });

  it('Review Focus 2: mentioning a streaming agent without steering', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => NEW_MESSAGE;
    const r = await send('Theo, good point');
    await waitFor(() => resolved().length === 1);
    expect(resolved()[0]).toMatchObject({ targets: [] });
    await r.settled;

    expect(segmentsFor(theo.messageId)).toHaveLength(0);
    expect(msg(theo.messageId)?.text).toBe(unsteeredText('theo'));
    expect(msg(theo.messageId)?.status).toBe('done');
    // The human still gets an answer: Theo, once his first message is done.
    const theos = startedBy('theo');
    expect(theos).toHaveLength(2);
    const firstDone = eventsFor(theo.messageId).find((e) => e.type === 'message_completed')!;
    expect(theos[1]!.seq).toBeGreaterThan(firstDone.seq);
  });

  it('new message while nobody streams runs a turn and resolves with no targets', async () => {
    s.gate = (id, prompt) => id === 'maya' && prompt.includes('0 replies deep');
    await (await send('What about pricing?')).settled;
    expect(startedBy('maya')).toHaveLength(1);
    expect(resolved()).toHaveLength(1);
    expect(resolved()[0]).toMatchObject({ targets: [] });
  });
});

describe('compliance retry', () => {
  it('a non-compliant steered answer is redone once, then accepted', async () => {
    s.judge = () => ({ object: { complies: false } });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('@Theo one sentence')).settled;
    await idle();

    const segs = segmentsFor(theo.messageId);
    expect(segs).toHaveLength(2);
    expect(segs[1]).toMatchObject({ mode: 'replace', truncateTo: 0 });
    expect(judgeCalls).toBe(1);
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
    expect(msg(theo.messageId)?.status).toBe('done');
    const judge = fakeRequests.find((r) => r.kind === 'judge');
    expect(judge?.prompt).toContain('one sentence');
  });

  it('no redo while a later human message is still undecided', async () => {
    s.judge = () => ({ object: { complies: false } });
    let judgeStarted = false;
    let releaseJudge!: () => void;
    let releaseClassify: (() => void) | null = null;
    let slowClassify = false;
    hooks.before = (meta) => {
      if (meta.kind === 'judge') {
        judgeStarted = true;
        return new Promise<void>((r) => (releaseJudge = r));
      }
      if (meta.kind === 'classify' && slowClassify) return new Promise<void>((r) => (releaseClassify = r));
      return undefined;
    };
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const a = await send('@Theo one sentence');
    await waitFor(() => judgeStarted);
    slowClassify = true;
    s.classify = () => NEW_MESSAGE;
    const b = await send('@Theo also add numbers');
    await waitFor(() => releaseClassify !== null);
    releaseJudge();
    await a.settled;
    expect(segmentsFor(theo.messageId)).toHaveLength(1); // no redo
    releaseClassify!();
    await b.settled;
  });

  it('a failing judge counts as compliant', async () => {
    s.judge = () => ({ error: 'judge down' });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('@Theo one sentence')).settled;
    expect(judgeCalls).toBe(1);
    expect(segmentsFor(theo.messageId)).toHaveLength(1);
  });

  it('unsteered messages are never judged', async () => {
    const g = startAll();
    await Promise.all(Object.values(g).map((x) => x.done));
    expect(fakeRequests.some((r) => r.kind === 'judge')).toBe(false);
  });
});

describe('display order', () => {
  const order = () => actor.view.messages.map((m) => m.id);
  const userId = (text: string) => actor.view.messages.find((m) => m.author.kind === 'user' && m.text === text)!.id;
  const anchorsSorted = () => {
    const a = actor.view.messages.map((m) => m.anchorSeq);
    return a.every((x, i) => i === 0 || a[i - 1]! < x);
  };

  it('a steered agent moves below the steer; the others keep their place', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    const before = g.theo.textSoFar();
    s.classify = () => steer(['theo']);
    await (await send('@Theo focus only on the risks')).settled;
    await idle();

    const steerMsg = userId('@Theo focus only on the risks');
    expect(order()).toEqual(['u1', g.maya.messageId, g.priya.messageId, steerMsg, g.theo.messageId]);
    const seg = segmentsFor(g.theo.messageId)[0]!;
    expect(seg).toMatchObject({ moved: true, mode: 'continue' });
    const theo = msg(g.theo.messageId)!;
    expect(theo.anchorSeq).toBe(seg.seq);
    expect(theo.startSeq).toBeLessThan(msg(steerMsg)!.startSeq);
    expect(theo.text.startsWith(before)).toBe(true); // same answer, prefix kept
    expect(startedBy('theo')).toHaveLength(1);
    expect(anchorsSorted()).toBe(true);
  });

  it('a merged second steer moves the message below both', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const a = await send('@Theo shorter');
    const b = await send('@Theo mention pricing');
    await Promise.all([a.settled, b.settled]);
    await idle();
    expect(segmentsFor(g.theo.messageId).every((e) => e.type === 'message_segment_started' && e.moved)).toBe(true);
    expect(order()).toEqual([
      'u1',
      g.maya.messageId,
      g.priya.messageId,
      userId('@Theo shorter'),
      userId('@Theo mention pricing'),
      g.theo.messageId,
    ]);
  });

  it('a broadcast steer moves everyone below it, in the order they were shown', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    s.classify = () => steer(['priya', 'theo', 'maya']);
    await (await send('everyone keep it short')).settled;
    await idle();
    expect(order()).toEqual(['u1', userId('everyone keep it short'), g.maya.messageId, g.theo.messageId, g.priya.messageId]);
    expect(anchorsSorted()).toBe(true);
  });

  it('a stop moves nothing', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    await (await send('@Theo stop')).settled;
    await idle();
    expect(order()).toEqual(['u1', g.maya.messageId, g.theo.messageId, g.priya.messageId, userId('@Theo stop')]);
  });

  it('the compliance redo does not move the answer', async () => {
    s.judge = () => ({ object: { complies: false } });
    let releaseJudge!: () => void;
    let judgeStarted = false;
    hooks.before = (meta) => {
      if (meta.kind !== 'judge') return undefined;
      judgeStarted = true;
      return new Promise<void>((r) => (releaseJudge = r));
    };
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const r = await send('@Theo one sentence');
    await waitFor(() => judgeStarted);
    // Someone else speaks after Theo's steered answer, before the redo.
    actor.append({
      type: 'message_started',
      messageId: 'later',
      agentId: 'priya',
      turnId: 't2',
      hop: 0,
      replyTo: null,
      contextCutoffSeq: actor.lastSeq,
      effort: 'low',
    });
    actor.append({ type: 'token_delta', messageId: 'later', segment: 0, offset: 0, text: 'Priya here.' });
    actor.append({ type: 'message_completed', messageId: 'later' });
    releaseJudge();
    await r.settled;
    await idle();

    const segs = segmentsFor(theo.messageId);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ moved: true });
    expect(segs[1]).not.toHaveProperty('moved');
    expect(msg(theo.messageId)?.anchorSeq).toBe(segs[0]!.seq);
    expect(order()).toEqual(['u1', userId('@Theo one sentence'), theo.messageId, 'later']);
  });

  it('a late steer that reopens a finished answer moves it below the steer', async () => {
    const theo = start('theo');
    await theo.done;
    const maya = start('maya');
    await maya.done;
    s.classify = () => steer(['theo']);
    await (await send('@Theo shorter')).settled;
    await idle();

    const segs = segmentsFor(theo.messageId);
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({ mode: 'replace', moved: true });
    expect(order()).toEqual(['u1', maya.messageId, userId('@Theo shorter'), theo.messageId]);
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
  });

  it('other agents see the moved answer after the steer; reload agrees', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('@Theo focus only on the risks')).settled;
    await idle();

    const cutoff = actor.lastSeq;
    const p = buildPrompt('maya', actor.eventsUpTo(cutoff), cutoff, {
      kind: 'reply',
      gist: 'x',
      effort: 'low',
      hop: 1,
      othersReplying: [],
    });
    const history = JSON.stringify(p.messages);
    const steerAt = history.indexOf('@Theo focus only on the risks');
    const theoAt = history.indexOf('STEERED:');
    expect(steerAt).toBeGreaterThan(-1);
    expect(theoAt).toBeGreaterThan(steerAt);
    expect(history.indexOf(unsteeredText('priya'))).toBeLessThan(steerAt);
    // Theo's own steered prompt still carried the steer as the final ask.
    expect(steerRequests('theo')[0]?.prompt).toContain('focus only on the risks');

    const fresh = new ConversationActor(db, 'c1');
    expect(fresh.view).toEqual(actor.view);
  });
});

describe('what the client saw', () => {
  it('a rendered map counts a missing live message as unseen; no map counts its committed text', () => {
    expect(shown(undefined, 'm', 12)).toBe(12);
    expect(shown({}, 'm', 12)).toBe(0);
    expect(shown({ other: 5 }, 'm', 12)).toBe(0);
    expect(shown({ m: 5 }, 'm', 12)).toBe(5);
    expect(shown({ m: 50 }, 'm', 12)).toBe(12);
    expect(shown({ m: -3 }, 'm', 12)).toBe(0);
  });

  it('a stop from a client that had not seen a message keeps none of its words', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    handleStop(actor, { clientReqId: 'early', rendered: {} });
    await idle();
    expect(eventsFor(theo.messageId).find((e) => e.type === 'message_aborted')).toMatchObject({ truncateTo: 0 });
    expect(msg(theo.messageId)?.text).toBe('');
  });

  it('a stop without any rendered map keeps the committed text', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    const committed = theo.textSoFar();
    handleStop(actor, { clientReqId: 'blind' });
    await idle();
    expect(msg(theo.messageId)?.text).toBe(committed);
  });

  it('a steer from a client that had not seen the message continues from nothing', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('@Theo one sentence', { rendered: {} })).settled;
    await idle();
    expect(segmentsFor(theo.messageId)[0]).toMatchObject({ truncateTo: 0, mode: 'continue' });
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
  });
});

describe('stop', () => {
  it('stop everything', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length >= 4));
    const rendered: Record<string, number> = {};
    for (const x of Object.values(g)) rendered[x.messageId] = x.textSoFar().length - 2;

    const r = handleStop(actor, { clientReqId: 'stop-1', rendered });
    expect(r.seq).not.toBeNull();
    expect(events().find((e) => e.seq === r.seq)?.type).toBe('stop_all');
    await sleep(200);

    expect(events().some((e) => e.seq > r.seq! && e.type === 'token_delta')).toBe(false);
    for (const x of Object.values(g)) {
      expect(msg(x.messageId)?.status).toBe('stopped');
      expect(msg(x.messageId)?.text.length).toBe(rendered[x.messageId]);
      expect(await x.done).toBe('stopped');
    }
    expect(handleStop(actor, { clientReqId: 'stop-1', rendered: {} })).toEqual({ seq: r.seq });
    expect(handleStop(actor, { clientReqId: 'stop-2', rendered: {} })).toEqual({ seq: null });
    expect(events().filter((e) => e.type === 'stop_all')).toHaveLength(1);
  });

  it('stop aborts the running turn', async () => {
    s.gate = (_id, prompt) => prompt.includes('0 replies deep');
    const r = await send('What should we do?');
    await waitFor(() => actor.generations.size === 3);
    const ctrl = actor.turnAbort;
    expect(ctrl).not.toBeNull();
    handleStop(actor, { clientReqId: 'stop-t', rendered: renderedNow() });
    expect(ctrl?.signal.aborted).toBe(true);
    await r.settled;
    expect(actor.view.messages.filter((m) => m.author.kind === 'agent').every((m) => m.status === 'stopped')).toBe(true);
  });

  it('stop during the gate phase: nobody starts', async () => {
    let gating = 0;
    hooks.before = (meta, signal) => {
      if (meta.kind !== 'gate') return undefined;
      gating++;
      return hangUntilAbort(signal);
    };
    const r = await send('What should we do?');
    await waitFor(() => gating === 3);
    expect(actor.generations.size).toBe(0);
    const ctrl = actor.turnAbort;
    const st = handleStop(actor, { clientReqId: 'stop-g', rendered: {} });
    expect(st.seq).not.toBeNull();
    expect(events().find((e) => e.seq === st.seq)?.type).toBe('stop_all');
    expect(ctrl?.signal.aborted).toBe(true);
    await r.settled;
    await sleep(100);
    expect(events().some((e) => e.type === 'message_started')).toBe(false);
    // Nothing live and no turn: nothing to stop.
    expect(handleStop(actor, { clientReqId: 'stop-g2', rendered: {} })).toEqual({ seq: null });
  });

  it('a targeted stop cancels a queued forced reply', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    const a = await send('Theo, good point'); // waits for Theo, then would force him
    await waitFor(() => resolved().length === 1);
    const b = await send('@Theo stop');
    await Promise.all([a.settled, b.settled]);
    await sleep(100);
    expect(msg(theo.messageId)?.status).toBe('stopped');
    expect(startedBy('theo')).toHaveLength(1);
  });

  it('a "stop" message stops everyone and resolves', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    await (await send('stop')).settled;
    expect(events().filter((e) => e.type === 'stop_all')).toHaveLength(1);
    for (const x of Object.values(g)) expect(msg(x.messageId)?.status).toBe('stopped');
    expect([...(resolved().at(-1)?.targets ?? [])].sort()).toEqual(['maya', 'priya', 'theo']);
    expect(fakeRequests.some((r) => r.kind === 'classify')).toBe(false);
  });

  it('"@Theo stop" stops only Theo', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    await (await send('@Theo stop')).settled;
    expect(msg(g.theo.messageId)?.status).toBe('stopped');
    await idle();
    expect(msg(g.maya.messageId)?.text).toBe(unsteeredText('maya'));
    expect(msg(g.priya.messageId)?.status).toBe('done');
    expect(events().some((e) => e.type === 'stop_all')).toBe(false);
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
  });

  it.each([
    ['a targeted stop', ['theo'] as AgentId[]],
    ['a stop for everyone', [] as AgentId[]],
  ])('%s decided by the classifier does not block a message sent while it classified', async (_name, targets) => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let classifies = 0;
    hooks.before = (meta) => (meta.kind === 'classify' && ++classifies === 1 ? held : undefined);
    s.classify = (text) => (text.includes('cut it') ? { ...NEW_MESSAGE, kind: 'stop', targets } : NEW_MESSAGE);

    const a = await send('ok that is plenty, cut it');
    const b = await send('Theo, what about pricing?'); // waits for Theo, then forces him
    await waitFor(() => resolved().length === 1); // b decided; a still classifying
    release();
    await Promise.all([a.settled, b.settled]);
    await idle();

    expect(msg(theo.messageId)?.status).toBe('stopped');
    const theos = startedBy('theo');
    expect(theos).toHaveLength(2);
    expect(theos[1]!.seq).toBeGreaterThan(b.seq);
  });

  it('a bare "stop" while the turn is still gating stops it without classifying', async () => {
    let gating = 0;
    hooks.before = (meta, signal) => {
      if (meta.kind !== 'gate') return undefined;
      gating++;
      return hangUntilAbort(signal);
    };
    const r = await send('What should we do?');
    await waitFor(() => gating === 3);
    const ctrl = actor.turnAbort;
    expect(ctrl).not.toBeNull();
    const st = await send('stop');
    await Promise.all([r.settled, st.settled]);
    await sleep(100);
    expect(ctrl?.signal.aborted).toBe(true);
    expect(events().filter((e) => e.type === 'stop_all')).toHaveLength(1);
    expect(fakeRequests.some((x) => x.kind === 'classify' && (x.prompt ?? '').endsWith('stop'))).toBe(false);
    expect(events().some((e) => e.type === 'message_started')).toBe(false);
    expect(gating).toBe(3); // no second turn
  });

  it('stop right after a send, while it is still classified: nobody ever starts', async () => {
    s.gate = () => true;
    hooks.before = (meta) => (meta.kind === 'classify' ? sleep(150) : undefined);
    const r = await send('Will we keep Northwind?');
    const st = handleStop(actor, { clientReqId: 'stop-early', rendered: {} });
    expect(st.seq).not.toBeNull();
    expect(events().find((e) => e.seq === st.seq)?.type).toBe('stop_all');
    expect(handleStop(actor, { clientReqId: 'stop-early', rendered: {} })).toEqual(st); // idempotent
    await r.settled;
    await sleep(100);
    expect(resolved()).toHaveLength(1);
    expect(events().some((e) => e.type === 'message_started')).toBe(false);
    expect(fakeRequests.some((x) => x.kind === 'gate')).toBe(false);
    // Decided and nothing running: nothing to stop.
    expect(handleStop(actor, { clientReqId: 'stop-late', rendered: {} })).toEqual({ seq: null });
  });

  it('a typed "stop" while an earlier message is classified stops it too', async () => {
    s.gate = () => true;
    let release!: () => void;
    hooks.before = (meta) => (meta.kind === 'classify' ? new Promise<void>((r) => (release = r)) : undefined);
    const a = await send('Will we keep Northwind?');
    const b = await send('stop');
    await b.settled;
    expect(events().filter((e) => e.type === 'stop_all')).toHaveLength(1);
    release();
    await a.settled;
    await sleep(100);
    expect(events().some((e) => e.type === 'message_started')).toBe(false);
  });

  it('stop between waves, while a hop-1 gate is in flight: no new message starts', async () => {
    let hop1Gates = 0;
    s.gate = (id, prompt) => id === 'maya' && prompt.includes('0 replies deep');
    hooks.before = (meta, signal) => {
      if (meta.kind !== 'gate' || fakeRequests.filter((x) => x.kind === 'reply').length === 0) return undefined;
      hop1Gates++;
      return hangUntilAbort(signal);
    };
    const r = await send('What should we do?');
    await waitFor(() => hop1Gates > 0);
    expect(actor.generations.size).toBe(0);
    const startedBefore = events().filter((e) => e.type === 'message_started').length;
    expect(startedBefore).toBe(1);
    const ctrl = actor.turnAbort;
    expect(ctrl).not.toBeNull();
    const st = handleStop(actor, { clientReqId: 'stop-h1', rendered: {} });
    expect(st.seq).not.toBeNull();
    expect(ctrl?.signal.aborted).toBe(true);
    await r.settled;
    await sleep(100);
    expect(events().filter((e) => e.type === 'message_started')).toHaveLength(startedBefore);
  });

  it('a pending reply does not start after a stop', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    const r = await send('Theo, good point'); // new_message: waits for Theo, then replies
    await waitFor(() => resolved().length === 1);
    handleStop(actor, { clientReqId: 'stop-p', rendered: renderedNow() });
    await r.settled;
    expect(startedBy('theo')).toHaveLength(1);
  });
});

describe('standing instructions', () => {
  it('standing instruction persists', async () => {
    s.classify = (text) =>
      text.includes('French')
        ? { ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in French.' }
        : NEW_MESSAGE;
    s.gate = (_id, prompt) => prompt.includes('0 replies deep');
    await (await send('from now on, everyone answer in French')).settled;

    const set = events().find((e) => e.type === 'instruction_set');
    expect(set).toMatchObject({ scope: 'all', text: 'Answer in French.' });
    const replies = () => fakeRequests.filter((r) => r.kind === 'reply');
    expect(new Set(replies().map((r) => r.agentId))).toEqual(new Set(['maya', 'theo', 'priya']));
    expect(replies().every((r) => r.system.includes('Answer in French.'))).toBe(true);

    const before = replies().length;
    await (await send('And what about hiring?')).settled;
    const later = replies().slice(before);
    expect(new Set(later.map((r) => r.agentId))).toEqual(new Set(['maya', 'theo', 'priya']));
    expect(later.every((r) => r.system.includes('Answer in French.'))).toBe(true);

    // Survives reload: a fresh actor over the same DB.
    const fresh = new ConversationActor(db, 'c1');
    expect(fresh.view.instructions).toEqual([expect.objectContaining({ scope: 'all', text: 'Answer in French.' })]);
    const g = startGeneration(fresh, {
      agentId: 'priya',
      turnId: 't9',
      hop: 0,
      replyTo: 'u1',
      effort: 'low',
      gist: 'x',
      othersReplying: [],
    });
    await g.done;
    expect(fakeRequests.at(-1)?.system).toContain('Answer in French.');
  });

  it('standing steer at one agent is scoped to that agent and applies now', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => ({ ...steer(['theo']), scope: 'standing', standing_text: 'Keep it to one sentence.' });
    await (await send('@Theo always keep it to one sentence')).settled;
    expect(events().find((e) => e.type === 'instruction_set')).toMatchObject({
      scope: 'theo',
      text: 'Keep it to one sentence.',
    });
    expect(steerRequests('theo')[0]?.system).toContain('Keep it to one sentence.');
    expect(msg(theo.messageId)?.text).toContain('STEERED:');
  });

  it('a failing classifier still records explicit standing wording', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r) => (r.kind === 'classify' ? { error: 'classifier down' } : { chunks: ['ok'], delayMs: 1 }));
    await (await send('from now on, everyone answer in French')).settled;
    expect(events().find((e) => e.type === 'instruction_set')).toMatchObject({
      scope: 'all',
      text: 'from now on, everyone answer in French',
    });
    await (await send('what about pricing?')).settled;
    expect(events().filter((e) => e.type === 'instruction_set')).toHaveLength(1);
  });

  it('a real one_off answer stays one-off even with "always" in it', async () => {
    s.classify = () => NEW_MESSAGE;
    await (await send('do we always ship on Fridays?')).settled;
    expect(events().some((e) => e.type === 'instruction_set')).toBe(false);
    expect(actor.view.instructions).toEqual([]);
    expect(keepStanding(NEW_MESSAGE, 'do we always ship on Fridays?')).toBe(NEW_MESSAGE);
  });

  it('a timed-out classifier keeps a named standing instruction scoped to that agent', () => {
    const fallback = { ...NEW_MESSAGE, targets: ['theo'] as AgentId[], fallback: true as const };
    expect(keepStanding(fallback, '@Theo always keep it to one sentence')).toMatchObject({
      scope: 'standing',
      standing_text: '@Theo always keep it to one sentence',
    });
    expect(keepStanding(fallback, '@Theo keep it short')).toBe(fallback);
    const standing = { ...NEW_MESSAGE, scope: 'standing' as const, standing_text: 'Be brief.', fallback: true as const };
    expect(keepStanding(standing, 'always be brief')).toBe(standing);
  });

  it('revokes remove an instruction', async () => {
    actor.append({ type: 'instruction_set', instructionId: 'i1', scope: 'all', text: 'Answer in French.' });
    s.classify = () => ({ ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in English.', revokes: ['i1'] });
    await (await send('from now on, English please')).settled;
    expect(actor.view.instructions.map((i) => i.text)).toEqual(['Answer in English.']);
  });
});

describe('typed stops', () => {
  it.each(['please stop', 'ok stop', 'stop it', 'never mind', 'cancel that', 'enough', "that's enough", 'ok that is enough'])(
    '"%s" stops everyone at once, with no classifier',
    async (text) => {
      const g = startAll();
      await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
      await (await send(text)).settled;
      for (const x of Object.values(g)) expect(msg(x.messageId)?.status).toBe('stopped');
      expect(fakeRequests.some((r) => r.kind === 'classify')).toBe(false);
    },
  );

  it('"tell priya to stop" stops only Priya', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    await (await send('tell priya to stop')).settled;
    expect(msg(g.priya.messageId)?.status).toBe('stopped');
    await idle();
    expect(msg(g.maya.messageId)?.status).toBe('done');
    expect(msg(g.theo.messageId)?.status).toBe('done');
  });

  it('"Maya and Theo stop, Priya keep going" leaves Priya alone', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    await (await send('Maya and Theo stop, Priya keep going')).settled;
    expect(msg(g.maya.messageId)?.status).toBe('stopped');
    expect(msg(g.theo.messageId)?.status).toBe('stopped');
    await idle();
    expect(msg(g.priya.messageId)?.status).toBe('done');
  });

  it('a question right after a typed stop still gets an answer', async () => {
    s.gate = (id, prompt) => id === 'priya' && prompt.includes('0 replies deep');
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    const a = await send('ok that is enough');
    const b = await send('What is our runway?');
    await Promise.all([a.settled, b.settled]);
    await idle();
    expect(startedBy('priya').length).toBe(2);
  });
});

describe('dropping a topic', () => {
  const ask = (text: string) => actor.view.messages.find((m) => m.author.kind === 'user' && m.text === text);

  it('"never mind X, Y" ends the old answers and gates everyone on the new ask', async () => {
    s.gate = (id, prompt) => id === 'priya' && prompt.includes('runway');
    const first = await send('Will we keep Northwind?');
    s.gate = () => true;
    await waitFor(() => actor.generations.size === 3);
    const old = [...actor.generations.values()];
    await waitFor(() => old.every((g) => g.textSoFar().length > 0));
    s.gate = (id, prompt) => id === 'priya' && prompt.includes('runway') && prompt.includes('0 replies deep');
    const second = await send('actually never mind Northwind, what is our runway?');
    await Promise.all([first.settled, second.settled]);
    await idle();

    for (const g of old) expect(msg(g.messageId)?.status).toBe('stopped');
    // The old turn started nothing more; the new one answers the new ask.
    const after = events().filter((e) => e.seq > second.seq && e.type === 'message_started');
    expect(after.map((e) => (e.type === 'message_started' ? e.agentId : ''))).toEqual(['priya']);
    expect(ask('Will we keep Northwind?')?.dropped).toBe(true);
    expect(ask('actually never mind Northwind, what is our runway?')?.dropped).toBeUndefined();
  });

  it('marks the previous ask dropped even when nothing is running', async () => {
    await (await send('Will we keep Northwind?')).settled;
    await idle();
    await (await send('never mind that. Favourite colour?')).settled;
    await idle();
    expect(ask('Will we keep Northwind?')?.dropped).toBe(true);
    // The new ask gets an answer even if every gate declines.
    const last = actor.view.messages.at(-1);
    expect(last?.author.kind).toBe('agent');
  });

  it('a classifier saying stop does not swallow the new question', async () => {
    s.classify = () => ({ ...NEW_MESSAGE, kind: 'stop' });
    await (await send('Never mind all that. Favourite colour?')).settled;
    await idle();
    expect(actor.view.messages.at(-1)?.author.kind).toBe('agent');
  });

  it('a queued reply to the old ask does not start', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    const a = await send('Theo, what about the renewal?'); // waits for Theo
    await waitFor(() => resolved().length === 1);
    s.gate = () => false;
    const b = await send('forget that, what is our runway?');
    await Promise.all([a.settled, b.settled]);
    await idle();
    expect(events().filter((e) => e.type === 'message_started' && e.seq < b.seq)).toHaveLength(1);
    expect(msg(theo.messageId)?.status).toBe('stopped');
  });

  it('a stop marks what it called off, and agents are told in later prompts', async () => {
    s.gate = (_id, prompt) => prompt.includes('0 replies deep');
    const r = await send('Will we keep Northwind?');
    await waitFor(() => actor.generations.size === 3);
    const cut = [...actor.generations.values()];
    await waitFor(() => cut.every((g) => g.textSoFar().length > 0));
    handleStop(actor, { clientReqId: 'stop-d', rendered: renderedNow() });
    await r.settled;
    expect(ask('Will we keep Northwind?')?.dropped).toBe(true);
    for (const g of cut) expect(msg(g.messageId)?.dropped).toBe(true);

    await (await send('What is our runway?')).settled;
    await idle();
    const reply = fakeRequests.filter((x) => x.kind === 'reply').at(-1)!;
    const history = JSON.stringify(reply.messages);
    expect(history).toContain('dropped=\\"true\\">Will we keep Northwind?');
    expect(history).not.toContain('dropped=\\"true\\">What is our runway?');
    // An agent's own cut answer no longer reads as its last word.
    const own = reply.messages.filter((m) => m.role === 'assistant').map((m) => String(m.content));
    expect(own.join('')).not.toContain(unsteeredText(reply.agentId!).slice(0, 4));
  });

  it('a targeted stop calls nothing off', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    await (await send('@Theo stop')).settled;
    await idle();
    expect(events().some((e) => e.type === 'asks_dropped')).toBe(false);
  });
});

describe('carrying on after a stop', () => {
  it('"sorry, carry on Theo" picks Theo up where he was cut, in the same message', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    handleStop(actor, { clientReqId: 's', rendered: renderedNow() });
    const before = msg(g.theo.messageId)!.text;
    await (await send('sorry, carry on Theo')).settled;
    await idle();
    expect(startedBy('theo')).toHaveLength(1);
    expect(segmentsFor(g.theo.messageId)[0]).toMatchObject({ mode: 'continue', truncateTo: before.length, moved: true });
    expect(msg(g.theo.messageId)).toMatchObject({ status: 'done', text: `${before}${STEERED.join('')}` });
    expect(msg(g.maya.messageId)?.status).toBe('stopped');
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
    expect(fakeRequests.some((r) => r.kind === 'classify')).toBe(false);
  });

  it('a plain "finish your thought" resumes everyone a stop cut', async () => {
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    handleStop(actor, { clientReqId: 's', rendered: renderedNow() });
    await (await send('finish your thought')).settled;
    await idle();
    for (const x of Object.values(g)) expect(msg(x.messageId)?.status).toBe('done');
    expect(events().filter((e) => e.type === 'message_started')).toHaveLength(3);
  });

  it('picking an answer back up also puts its question back on the table', async () => {
    const answering = (agentId: AgentId) =>
      startGeneration(actor, { agentId, turnId: 't1', hop: 0, replyTo: 'u1', effort: 'low', gist: 'x', othersReplying: [], triggerSeq: 1 });
    const theo = answering('theo');
    const maya = answering('maya');
    await waitFor(() => theo.textSoFar().length > 0 && maya.textSoFar().length > 0);
    handleStop(actor, { clientReqId: 's', rendered: renderedNow() });
    expect(msg('u1')?.dropped).toBe(true);
    await (await send('@Theo carry on')).settled;
    await idle();
    expect(msg('u1')?.dropped).toBeUndefined();
    expect(msg(theo.messageId)?.dropped).toBeUndefined();
    expect(msg(maya.messageId)?.dropped).toBe(true); // only Theo was asked to carry on
    const prompt = JSON.stringify(steerRequests('theo')[0]?.messages);
    expect(prompt).toContain('<msg from=\\"You\\" kind=\\"human\\">What should we build?');
  });

  it('"continue" with nothing stopped is an ordinary message', async () => {
    await (await send('continue')).settled;
    await idle();
    expect(fakeRequests.some((r) => r.kind === 'classify')).toBe(true);
  });
});

describe('size limits', () => {
  /** Theo has finished a sentence on screen and is writing another. */
  function theoWithSentence(): Generation {
    setFakeScript((r): FakeReply => {
      if (r.kind === 'reply') return { chunks: ['First point is done. ', 'Then ', 'more ', 'and ', 'more ', 'words '], delayMs: 30 };
      if (r.kind === 'continue' || r.kind === 'replace') return { chunks: STEERED, delayMs: 5 };
      if (r.kind === 'classify') return { object: steer(['theo']) };
      return { object: { complies: true } };
    });
    return start('theo');
  }

  it('"one sentence" after a finished sentence rewrites: a continuation could not obey it', async () => {
    const theo = theoWithSentence();
    await waitFor(() => theo.textSoFar().includes('Then'));
    await (await send('@Theo one sentence')).settled;
    await idle();
    expect(segmentsFor(theo.messageId)[0]).toMatchObject({ mode: 'replace', truncateTo: 0 });
    expect(msg(theo.messageId)?.text).toBe(STEERED.join(''));
  });

  it('a steer with no size limit still joins at the finished sentence', async () => {
    const theo = theoWithSentence();
    await waitFor(() => theo.textSoFar().includes('Then'));
    await (await send('@Theo focus on the risks')).settled;
    await idle();
    expect(segmentsFor(theo.messageId)[0]).toMatchObject({ mode: 'continue', truncateTo: 'First point is done. '.length });
  });

  it('a size limit merged into a pending steer rewrites too', async () => {
    const theo = theoWithSentence();
    await waitFor(() => theo.textSoFar().includes('Then'));
    const a = await send('@Theo focus on the risks');
    const b = await send('@Theo in one line');
    await Promise.all([a.settled, b.settled]);
    await idle();
    expect(segmentsFor(theo.messageId).at(-1)).toMatchObject({ mode: 'replace', truncateTo: 0 });
  });
});

describe('a message for everyone', () => {
  it('waits for whoever is still writing, then all three answer it', async () => {
    const maya = start('maya');
    await waitFor(() => maya.textSoFar().length > 0);
    const r = await send('Everyone: what is your one-line take?');
    await r.settled;
    await idle();
    expect(startedBy('maya')).toHaveLength(2);
    expect(startedBy('theo')).toHaveLength(1);
    expect(startedBy('priya')).toHaveLength(1);
    expect(msg(maya.messageId)).toMatchObject({ status: 'done' });
  });
});

describe('steers show up fast', () => {
  it('an @named steer restarts the agent before the classifier answers', async () => {
    let release!: () => void;
    hooks.before = (meta) => (meta.kind === 'classify' ? new Promise<void>((r) => (release = r)) : undefined);
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const r = await send('@Theo one sentence');
    expect(segmentsFor(g.theo.messageId)).toHaveLength(1);
    await waitFor(() => msg(g.theo.messageId)!.text.includes('STEERED'));
    expect(resolved()).toHaveLength(0);
    release();
    await r.settled;
    await idle();
    expect(segmentsFor(g.theo.messageId)).toHaveLength(1);
    expect(steerRequests('theo')).toHaveLength(1);
    expect(resolved().at(-1)).toMatchObject({ targets: ['theo'] });
  });

  it('the classifier can still turn it into a full rewrite', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => steer(['theo'], 'replace');
    await (await send('@Theo cover pricing and drop the rest')).settled;
    await idle();
    expect(segmentsFor(g.theo.messageId).map((e) => (e.type === 'message_segment_started' ? e.mode : ''))).toEqual([
      'continue',
      'replace',
    ]);
    expect(msg(g.theo.messageId)?.text).toBe(STEERED.join(''));
    expect(steerRequests('theo').at(-1)?.prompt).toMatch(/«@Theo cover pricing and drop the rest»/);
  });

  it('the agent is not forced into another message when the classifier calls it a new message', async () => {
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    s.classify = () => NEW_MESSAGE;
    await (await send('@Theo one sentence')).settled;
    await idle();
    expect(startedBy('theo')).toHaveLength(1);
  });

  it.each(['@Theo good point', '@Theo what about pricing?', '@Theo thanks', '@Theo always be brief'])(
    '"%s" waits for the classifier',
    async (text) => {
      let release!: () => void;
      hooks.before = (meta) => (meta.kind === 'classify' ? new Promise<void>((r) => (release = r)) : undefined);
      const theo = start('theo');
      await waitFor(() => theo.textSoFar().length > 0);
      const r = await send(text);
      expect(segmentsFor(theo.messageId)).toHaveLength(0);
      await waitFor(() => release !== undefined);
      release();
      await r.settled;
      await idle();
    },
  );

  it('a steered segment skips reasoning, even on a high-effort answer', async () => {
    const theo = startGeneration(actor, {
      agentId: 'theo',
      turnId: 't',
      hop: 0,
      replyTo: 'u1',
      effort: 'high',
      gist: 'g',
      othersReplying: [],
    });
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    await (await send('@Theo one sentence')).settled;
    await idle();
    expect(steerRequests('theo')[0]?.reasoning).toBe('none');
  });
});

describe('a new message when nobody is writing', () => {
  it('gates run beside the classifier, not after it', async () => {
    let release!: () => void;
    hooks.before = (meta) => (meta.kind === 'classify' ? new Promise<void>((r) => (release = r)) : undefined);
    s.gate = (id) => id === 'priya';
    const r = await send('What is our runway?');
    await waitFor(() => fakeRequests.filter((x) => x.kind === 'gate').length === 3);
    expect(events().some((e) => e.type === 'message_started')).toBe(false); // nobody speaks before it is decided
    release();
    await r.settled;
    await idle();
    expect(startedBy('priya')).toHaveLength(1);
  });

  it('a named agent speaks with no gate for anyone else', async () => {
    await (await send('@Theo what is the status')).settled;
    await idle();
    expect(fakeRequests.filter((x) => x.kind === 'gate').map((x) => x.agentId)).toEqual(['theo']);
    expect(events().filter((e) => e.type === 'message_started')).toHaveLength(1);
    expect(startedBy('theo')).toHaveLength(1);
  });

  it('a discarded classification costs no reply', async () => {
    s.gate = () => true;
    s.classify = () => ({ ...NEW_MESSAGE, kind: 'stop' });
    await (await send('that will do for today')).settled;
    await sleep(30);
    expect(events().some((e) => e.type === 'message_started')).toBe(false);
  });
});

describe('instruction-only messages', () => {
  it('get one short acknowledgement, not a thread', async () => {
    s.gate = () => true;
    s.classify = () => ({ ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in English.' });
    await (await send('back to English')).settled;
    await idle();
    const replies = events().filter((e) => e.type === 'message_started');
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ effort: 'low' });
    expect(fakeRequests.find((r) => r.kind === 'reply')?.prompt).toContain('Acknowledge');
  });

  it('a question alongside the instruction still gets a real turn', async () => {
    s.gate = (_id, prompt) => prompt.includes('0 replies deep');
    s.classify = () => ({ ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in English.' });
    await (await send('from now on English. What is our runway?')).settled;
    await idle();
    expect(events().filter((e) => e.type === 'message_started')).toHaveLength(3);
  });
});

describe('instructions in order', () => {
  it('a quick correction sees the instruction it corrects', async () => {
    let releaseFirst!: () => void;
    let n = 0;
    hooks.before = (meta) => {
      if (meta.kind !== 'classify') return undefined;
      n += 1;
      return n === 1 ? new Promise<void>((r) => (releaseFirst = r)) : undefined;
    };
    s.classify = (text) =>
      text.includes('French')
        ? { ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in French.' }
        : { ...NEW_MESSAGE, revokes: actor.view.instructions.map((i) => i.id) };
    const a = await send('switch to French');
    const b = await send('no, stay in English');
    await waitFor(() => n === 2);
    await sleep(10);
    expect(resolved()).toHaveLength(0); // the correction waits for what it corrects
    releaseFirst();
    await Promise.all([a.settled, b.settled]);
    await idle();
    expect(actor.view.instructions).toEqual([]);
    expect(resolved().map((e) => e.userMessageId)).toEqual(
      actor.view.messages.filter((m) => m.author.kind === 'user' && m.text !== 'What should we build?').map((m) => m.id),
    );
  });

  it('a revoke aimed at one agent leaves the rule for everyone else', async () => {
    actor.append({ type: 'instruction_set', instructionId: 'fr', scope: 'all', text: 'Answer in French.' });
    s.classify = () => ({ ...NEW_MESSAGE, targets: ['maya'], scope: 'standing', standing_text: 'Answer in English.', revokes: ['fr'] });
    await (await send('@Maya switch back to English from now on')).settled;
    await idle();
    expect(actor.view.instructions).toEqual([
      expect.objectContaining({ id: 'fr', scope: 'all' }),
      expect.objectContaining({ scope: 'maya', text: 'Answer in English.' }),
    ]);
  });

  it('a one-off revoke aimed at one agent becomes that agent\'s own rule', async () => {
    actor.append({ type: 'instruction_set', instructionId: 'fr', scope: 'all', text: 'Answer in French.' });
    s.classify = () => ({ ...NEW_MESSAGE, targets: ['maya'], revokes: ['fr'] });
    await (await send('@Maya no, stay in English')).settled;
    await idle();
    expect(actor.view.instructions).toEqual([
      expect.objectContaining({ id: 'fr' }),
      expect.objectContaining({ scope: 'maya', text: '@Maya no, stay in English' }),
    ]);
  });

  it('a rule for two named agents is theirs alone', async () => {
    s.classify = () => ({ ...NEW_MESSAGE, targets: ['maya', 'theo'], scope: 'standing', standing_text: 'Be brief.' });
    await (await send('Maya and Theo, from now on be brief')).settled;
    await idle();
    expect(actor.view.instructions.map((i) => i.scope)).toEqual(['maya', 'theo']);
  });
});

describe('compliance redo limits', () => {
  it('a stop that lands while the judge runs prevents the redo, even with nothing live', async () => {
    s.judge = () => ({ object: { complies: false } });
    let started = false;
    let release!: () => void;
    hooks.before = (meta) => {
      if (meta.kind !== 'judge') return undefined;
      started = true;
      return new Promise<void>((r) => (release = r));
    };
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const r = await send('@Theo in French');
    await waitFor(() => started);
    const text = msg(theo.messageId)!.text;
    expect(handleStop(actor, { clientReqId: 'late', rendered: {} })).toEqual({ seq: null });
    release();
    await r.settled;
    await idle();
    expect(msg(theo.messageId)?.text).toBe(text);
    expect(segmentsFor(theo.messageId)).toHaveLength(1);
  });

  it('no redo once someone has replied to the answer', async () => {
    s.judge = () => ({ object: { complies: false } });
    let release!: () => void;
    let started = false;
    hooks.before = (meta) => {
      if (meta.kind !== 'judge') return undefined;
      started = true;
      return new Promise<void>((r) => (release = r));
    };
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    s.classify = () => steer(['theo']);
    const r = await send('@Theo in French');
    await waitFor(() => started);
    actor.append({ type: 'message_started', messageId: 'reply', agentId: 'priya', turnId: 't', hop: 1, replyTo: theo.messageId, contextCutoffSeq: actor.lastSeq, effort: 'low' });
    actor.append({ type: 'message_completed', messageId: 'reply' });
    release();
    await r.settled;
    await idle();
    expect(segmentsFor(theo.messageId)).toHaveLength(1);
  });

  it('a redo never leaves a brevity answer longer than it was', async () => {
    s.judge = () => ({ object: { complies: false } });
    let segs = 0;
    setFakeScript((r): FakeReply => {
      if (r.kind === 'reply') return { chunks: UNSTEERED('theo'), delayMs: 30 };
      if (r.kind === 'classify') return { object: steer(['theo']) };
      if (r.kind === 'judge') return { object: { complies: false } };
      segs += 1;
      return { chunks: [segs === 1 ? 'Short.' : 'Much, much longer than it was.'], delayMs: 2 };
    });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    await (await send('@Theo one sentence', { rendered: {} })).settled;
    await idle();
    expect(msg(theo.messageId)).toMatchObject({ text: 'Short.', status: 'done' });
  });

  it('a redo that fails puts the steered answer back', async () => {
    let segs = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r): FakeReply => {
      if (r.kind === 'reply') return { chunks: UNSTEERED('theo'), delayMs: 30 };
      if (r.kind === 'classify') return { object: steer(['theo'], 'replace') };
      if (r.kind === 'judge') return { object: { complies: false } };
      segs += 1;
      return segs === 1 ? { chunks: ['The steered answer.'], delayMs: 2 } : { chunks: [], delayMs: 0 };
    });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    await (await send('@Theo in French')).settled;
    await idle();
    expect(msg(theo.messageId)?.text).toBe('The steered answer.');
  });
});

describe('a message queued behind a stream', () => {
  const quick = () => {
    const real = setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => real(fn, 5)) as typeof setInterval);
  };

  it('gives up on a hung stream', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r): FakeReply => {
      if (r.kind === 'classify') return { object: NEW_MESSAGE };
      if (r.kind === 'reply' && !fakeRequests.some((x) => x.kind === 'reply' && x !== r)) {
        return { chunks: ['Half', ' an answer'], delayMs: 1, hangAfterChunks: 1 };
      }
      return { chunks: ['Answer.'], delayMs: 1 };
    });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar() === 'Half');
    theo.lastActivityAt -= QUEUE_STALL_MS;
    quick();
    const t0 = Date.now();
    await (await send('Theo, a new topic')).settled;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(msg(theo.messageId)).toMatchObject({ status: 'stopped', text: 'Half' });
    expect(startedBy('theo')).toHaveLength(2);
  });

  it('a steer cutting the text is not mistaken for a stream that has stopped moving', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r): FakeReply => {
      if (r.kind === 'classify') return { object: NEW_MESSAGE };
      if (r.kind === 'replace') return { chunks: STEERED, delayMs: 40 };
      if (r.kind === 'reply' && !fakeRequests.some((x) => x.kind === 'replace')) {
        return { chunks: Array.from({ length: 60 }, (_, i) => `word${i} `), delayMs: 10 };
      }
      return { chunks: ['Answer.'], delayMs: 1 };
    });
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 30);
    quick();
    const queued = await send('Theo, a new topic');
    await waitFor(() => resolved().length === 1);
    // Long after the wait began, a steer rewrites Theo.
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + QUEUE_DRIP_MS + 1000);
    theo.lastActivityAt = Date.now();
    theo.restart('replace', 0, ['in French'], { moved: true });
    await queued.settled;
    expect(warn.mock.calls.flat().join(' ')).not.toContain('stalled');
    expect(msg(theo.messageId)).toMatchObject({ status: 'done', text: STEERED.join('') });
  });

  it('leaves a healthy stream to finish', async () => {
    const theo = start('theo');
    await waitFor(() => theo.textSoFar().length > 0);
    quick();
    await (await send('Theo, good point')).settled;
    await idle();
    expect(msg(theo.messageId)?.status).toBe('done');
  });
});

describe('classifier failure', () => {
  const failing = () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r): FakeReply => {
      if (r.kind === 'classify') return { error: 'classifier down' };
      if (r.kind === 'gate') return { object: { should_respond: false, novelty: 0, gist: '', addresses: [], effort: 'low' } };
      if (r.kind === 'dedup') return { object: { clusters: [] } };
      return { chunks: UNSTEERED(r.agentId ?? 'a'), delayMs: 20 };
    });
  };

  it('retries once', async () => {
    failing();
    await (await send('hello there')).settled;
    await idle();
    expect(fakeRequests.filter((r) => r.kind === 'classify')).toHaveLength(2);
  });

  it('chatter sent mid-stream does not restart anyone', async () => {
    failing();
    const g = startAll();
    await waitFor(() => g.theo.textSoFar().length > 0);
    await (await send('thanks, unrelated: who is on call?')).settled;
    await idle();
    for (const x of Object.values(g)) expect(segmentsFor(x.messageId)).toHaveLength(0);
  });

  it('an imperative mid-stream still steers', async () => {
    failing();
    const g = startAll();
    await waitFor(() => Object.values(g).every((x) => x.textSoFar().length > 0));
    await (await send('keep it short')).settled;
    await idle();
    for (const x of Object.values(g)) expect(segmentsFor(x.messageId)).toHaveLength(1);
  });

  it('a language rule is kept without a classifier', async () => {
    failing();
    await (await send('answer in French please')).settled;
    await idle();
    expect(actor.view.instructions.map((i) => i.text)).toEqual(['answer in French please']);
  });
});

describe('crash while deciding', () => {
  it('finishes the undecided message when the conversation is next loaded', async () => {
    s.classify = () => ({ ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in French.' });
    const d = openDb(':memory:');
    const before = new ConversationActor(d, 'crashed');
    before.append({ type: 'user_message', messageId: 'lost', clientMsgId: 'c', text: 'from now on, answer in French' });

    const after = getActor(d, 'crashed');
    await waitFor(() => after.eventsAfter(0).some((e) => e.type === 'steer_resolved'));
    expect(after.view.instructions.map((i) => i.text)).toEqual(['Answer in French.']);
    await waitFor(() => after.generations.size === 0 && after.turnAbort === null);
    d.close();
  });

  it('an old undecided message is closed without a reply', () => {
    const d = openDb(':memory:');
    const before = new ConversationActor(d, 'old');
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - RECOVER_REPLY_MS - 1000);
    before.append({ type: 'user_message', messageId: 'lost', clientMsgId: 'c', text: 'hello?' });
    spy.mockRestore();
    const after = getActor(d, 'old');
    expect(after.eventsAfter(0).map((e) => e.type)).toEqual(['user_message', 'steer_resolved']);
    d.close();
  });
});
