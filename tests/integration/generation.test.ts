import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';
import { startGeneration, type Generation } from '../../src/server/orchestrator/generation.js';
import { visibleMessages } from '../../src/shared/reducer.js';
import type { AgentId, ConvEvent } from '../../src/shared/events.js';

// Lets one test replace streamChat with a stream that ignores abort and keeps
// delivering chunks late, like a misbehaving SDK buffer.
const hooks = vi.hoisted(() => ({
  override: null as null | ((a: { signal: AbortSignal; meta: { kind: string } }) => AsyncIterable<string>),
}));
vi.mock('../../src/server/llm/stream.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/server/llm/stream.js')>();
  return {
    ...m,
    streamChat: (a: Parameters<typeof m.streamChat>[0]) =>
      hooks.override ? hooks.override(a) : m.streamChat(a),
  };
});

let db: Db;
let actor: ConversationActor;
beforeEach(() => {
  process.env.MODEL_AGENT = 'fake:x';
  resetFake();
  hooks.override = null;
  db = openDb(':memory:');
  actor = new ConversationActor(db, 'c1');
  actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'cm1', text: 'What is the plan?' });
});
afterEach(() => {
  delete process.env.MODEL_AGENT;
  resetFake();
  hooks.override = null;
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

function start(agentId: AgentId = 'maya'): Generation {
  return startGeneration(actor, {
    agentId,
    turnId: 't1',
    hop: 0,
    replyTo: 'u1',
    effort: 'low',
    gist: 'the plan',
    othersReplying: [],
  });
}
const msg = (g: Generation) => actor.view.messages.find((m) => m.id === g.messageId);
const eventsFor = (g: Generation): ConvEvent[] =>
  actor.eventsAfter(0).filter((e) => 'messageId' in e && e.messageId === g.messageId);
const deltas = (g: Generation) =>
  eventsFor(g).filter((e): e is Extract<ConvEvent, { type: 'token_delta' }> => e.type === 'token_delta');

describe('Generation', () => {
  it('streams and completes', async () => {
    setFakeScript(() => ({ chunks: ['Hel', 'lo'], delayMs: 5 }));
    const g = start();
    expect(actor.generations.get(g.messageId)).toBe(g);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('Hello');
    expect(msg(g)?.status).toBe('done');
    expect(deltas(g).length).toBeGreaterThanOrEqual(1);
    expect(actor.generations.has(g.messageId)).toBe(false);
    expect(eventsFor(g).at(-1)?.type).toBe('message_completed');
  });

  it('message_started cutoff excludes its own event and offsets are contiguous', async () => {
    setFakeScript(() => ({ chunks: ['a', 'b', 'c'], delayMs: 40 }));
    const before = actor.lastSeq;
    const g = start();
    await g.done;
    const ms = eventsFor(g)[0];
    expect(ms?.type).toBe('message_started');
    if (ms?.type === 'message_started') {
      expect(ms.contextCutoffSeq).toBe(before);
      expect(ms.seq).toBe(before + 1);
    }
    let len = 0;
    for (const d of deltas(g)) {
      expect(d.offset).toBe(len);
      len += d.text.length;
    }
    expect(fakeRequests[0]?.kind).toBe('reply');
    expect(fakeRequests[0]?.agentId).toBe('maya');
  });

  it('coalesces', async () => {
    setFakeScript(() => ({ chunks: Array.from({ length: 50 }, () => 'x'), delayMs: 1 }));
    const g = start();
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('x'.repeat(50));
    expect(deltas(g).length).toBeLessThan(15);
  });

  it('restart continue keeps prefix and same message id', async () => {
    setFakeScript((r) =>
      r.kind === 'continue'
        ? { chunks: ['ship ', 'Friday.'], delayMs: 5 }
        : { chunks: ['The plan ', 'is to ', 'launch ', 'on ', 'Monday ', 'and ', 'then ', 'more.'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().startsWith('The plan is to '));
    expect(g.restart('continue', 12, ['be brief'])).toBe(true);
    expect(g.segment).toBe(1);
    expect(g.firstTokenSeen).toBe(false);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('The plan is ' + 'ship Friday.');
    expect(actor.view.messages.filter((m) => m.author.kind === 'agent')).toHaveLength(1);
    const last = fakeRequests.at(-1);
    expect(last?.kind).toBe('continue');
    expect(JSON.stringify(last?.messages)).toContain('be brief');
    expect(JSON.stringify(last?.messages)).toContain('The plan is ');
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(seg).toMatchObject({ segment: 1, truncateTo: 12, mode: 'continue' });
  });

  it('continue strips an overlapping head', async () => {
    setFakeScript((r) =>
      r.kind === 'continue'
        ? { chunks: ['plan is ', 'ship Friday.'], delayMs: 5 }
        : { chunks: ['The plan is to ', 'launch ', 'on ', 'Monday ', 'and ', 'more.'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().startsWith('The plan is to '));
    g.restart('continue', 12, ['be brief']);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('The plan is ship Friday.');
  });

  it('restart replace', async () => {
    setFakeScript((r) =>
      r.kind === 'replace'
        ? { chunks: ['Totally ', 'new.'], delayMs: 5 }
        : { chunks: ['Old ', 'answer ', 'goes ', 'on ', 'and ', 'on.'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    expect(g.restart('replace', 3, ['start over'])).toBe(true);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('Totally new.');
    expect(fakeRequests.at(-1)?.kind).toBe('replace');
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(seg).toMatchObject({ truncateTo: 0, mode: 'replace' });
  });

  it('no deltas from aborted segment', async () => {
    setFakeScript((r) =>
      r.kind === 'replace'
        ? { chunks: ['B', 'B', 'B'], delayMs: 30 }
        : { chunks: Array.from({ length: 30 }, () => 'a'), delayMs: 30 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    await sleep(40); // some segment-0 chunks are now buffered but unflushed
    g.restart('replace', 0, ['other']);
    expect(await g.done).toBe('completed');
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(seg).toBeDefined();
    const late = deltas(g).filter((d) => d.segment === 0 && d.seq > (seg?.seq ?? 0));
    expect(late).toEqual([]);
    expect(msg(g)?.text).toBe('BBB');
  });

  it('drops chunks an SDK delivers late after the segment was superseded', async () => {
    let resolveOld!: () => void;
    const oldGate = new Promise<void>((r) => (resolveOld = r));
    hooks.override = (a) =>
      (async function* () {
        if (a.meta.kind === 'reply') {
          yield 'old ';
          await oldGate; // restart happens here; abort is ignored
          for (let i = 0; i < 10; i++) {
            yield 'LATE ';
            await sleep(10);
          }
        } else {
          await sleep(20);
          yield 'new';
          await sleep(120); // let any stale timer fire before completing
          yield ' text';
        }
      })();
    const g = start();
    await waitFor(() => g.firstTokenSeen);
    g.restart('replace', 0, ['x']);
    resolveOld();
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('new text');
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(deltas(g).filter((d) => d.segment === 0 && d.seq > (seg?.seq ?? 0))).toEqual([]);
    expect(deltas(g).every((d) => !d.text.includes('LATE'))).toBe(true);
  });

  it('stop truncates to rendered', async () => {
    setFakeScript(() => ({ chunks: ['Hello ', 'world ', 'and ', 'more ', 'and ', 'more.'], delayMs: 40 }));
    const g = start();
    await waitFor(() => g.textSoFar().length >= 5);
    g.stop(5);
    expect(await g.done).toBe('stopped');
    expect(msg(g)?.text).toHaveLength(5);
    expect(msg(g)?.status).toBe('stopped');
    const stopSeq = actor.lastSeq;
    expect(eventsFor(g).at(-1)).toMatchObject({ type: 'message_aborted', reason: 'user_stop', truncateTo: 5 });
    await sleep(200);
    expect(eventsFor(g).filter((e) => e.seq > stopSeq)).toEqual([]);
    expect(actor.generations.has(g.messageId)).toBe(false);
    // Terminal: further control calls are no-ops.
    g.stop(0);
    expect(g.restart('continue', 2, ['x'])).toBe(false);
    expect(eventsFor(g).filter((e) => e.seq > stopSeq)).toEqual([]);
  });

  it('error mid-stream keeps text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript(() => ({ error: 'boom', afterChunks: 2 }));
    const g = start();
    expect(await g.done).toBe('error');
    expect(msg(g)?.status).toBe('stopped');
    expect(msg(g)?.text).toBe('c0c1');
    expect(eventsFor(g).at(-1)).toMatchObject({ type: 'message_aborted', reason: 'error', truncateTo: 4 });
    expect(visibleMessages(actor.view).some((m) => m.id === g.messageId)).toBe(true);
    expect(actor.generations.has(g.messageId)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('error with no chunks is invisible', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript(() => ({ error: 'boom', afterChunks: 0 }));
    const g = start();
    expect(await g.done).toBe('error');
    expect(msg(g)?.status).toBe('stopped');
    expect(visibleMessages(actor.view).some((m) => m.id === g.messageId)).toBe(false);
  });
});
