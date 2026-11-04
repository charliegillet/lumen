import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript, type FakeReply } from '../../src/server/llm/fake.js';
import { startGeneration, type Generation } from '../../src/server/orchestrator/generation.js';
import { handleStop, handleUserMessage, type SendInput } from '../../src/server/steering/handle.js';
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

  it('revokes remove an instruction', async () => {
    actor.append({ type: 'instruction_set', instructionId: 'i1', scope: 'all', text: 'Answer in French.' });
    s.classify = () => ({ ...NEW_MESSAGE, scope: 'standing', standing_text: 'Answer in English.', revokes: ['i1'] });
    await (await send('from now on, English please')).settled;
    expect(actor.view.instructions.map((i) => i.text)).toEqual(['Answer in English.']);
  });
});
