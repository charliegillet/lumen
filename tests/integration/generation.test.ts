import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';
import {
  mustHold,
  overlapLength,
  reopenGeneration,
  startGeneration,
  stripContinuation,
  type Generation,
} from '../../src/server/orchestrator/generation.js';
import { visibleMessages } from '../../src/shared/reducer.js';
import { setStreamTimeouts, STREAM_IDLE_MS, STREAM_TOTAL_MS } from '../../src/server/llm/stream.js';
import type { AgentId, ConvEvent, EventBody } from '../../src/shared/events.js';

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

describe('ttft log', () => {
  it('logs one line per visible segment outside tests, and stays quiet under vitest', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    setFakeScript(() => ({ chunks: ['Hel', 'lo'], delayMs: 2 }));
    expect(await start().done).toBe('completed');
    expect(info).not.toHaveBeenCalled();

    const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    try {
      expect(await start('theo').done).toBe('completed');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/^ttft agent=theo model=fake:x segment=0 kind=reply ms=\d+$/);
  });
});

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

  it('continue shows text after the first chunk (no full-window holdback)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    hooks.override = (a) =>
      (async function* () {
        if (a.meta.kind === 'reply') {
          yield 'The plan is to ';
          await new Promise<never>(() => {}); // until superseded
        } else {
          yield 'ship ';
          await gate;
          yield 'Friday.';
        }
      })();
    const g = start();
    await waitFor(() => g.textSoFar() === 'The plan is to ');
    g.restart('continue', 12, ['be brief']);
    await waitFor(() => g.textSoFar() === 'The plan is ship ');
    release();
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('The plan is ship Friday.');
  });

  it('restart twice before the first restart yields', async () => {
    let calls = 0;
    setFakeScript(() => {
      calls += 1;
      if (calls === 1) return { chunks: Array.from({ length: 20 }, () => 'a'), delayMs: 30 };
      if (calls === 2) return { chunks: ['SECOND'], delayMs: 50 };
      return { chunks: ['th', 'ird'], delayMs: 5 };
    });
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    expect(g.restart('replace', 0, ['one'])).toBe(true);
    expect(g.restart('replace', 0, ['two'])).toBe(true);
    expect(g.segment).toBe(2);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('third');
    const segs = eventsFor(g).filter((e) => e.type === 'message_segment_started');
    expect(segs.map((e) => ('segment' in e ? e.segment : -1))).toEqual([1, 2]);
    const lastSegSeq = segs.at(-1)?.seq ?? 0;
    expect(deltas(g).filter((d) => d.segment === 1)).toEqual([]);
    expect(deltas(g).filter((d) => d.seq > lastSegSeq).every((d) => d.segment === 2)).toBe(true);
    expect(JSON.stringify(fakeRequests.at(-1)?.messages)).toContain('two');
  });

  it('restart during the continue head holdback', async () => {
    setFakeScript((r) => {
      if (r.kind === 'continue') return { chunks: [' ', 'is', ' going'], delayMs: 60 };
      if (r.kind === 'replace') return { chunks: ['fresh'], delayMs: 5 };
      return { chunks: ['The plan is to ', 'go ', 'on ', 'and ', 'on.'], delayMs: 40 };
    });
    const g = start();
    await waitFor(() => g.textSoFar().startsWith('The plan is to '));
    g.restart('continue', 12, ['be brief']);
    await waitFor(() => g.firstTokenSeen); // ' ' is held: " is " may still overlap
    expect(g.textSoFar()).toBe('The plan is ');
    g.restart('replace', 0, ['start over']);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('fresh');
    expect(deltas(g).filter((d) => d.segment === 1)).toEqual([]);
  });

  it('clamps truncateTo to the committed length', async () => {
    setFakeScript((r) =>
      r.kind === 'continue'
        ? { chunks: ['!'], delayMs: 5 }
        : { chunks: ['abc', 'def', 'ghi', 'jkl'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    const committed = g.textSoFar().length;
    g.restart('continue', 999, ['x']);
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(seg).toMatchObject({ truncateTo: committed });
    await g.done;
    const g2 = start('theo');
    await waitFor(() => g2.textSoFar().length > 0);
    const c2 = g2.textSoFar().length;
    g2.stop(10_000);
    expect(eventsFor(g2).at(-1)).toMatchObject({ type: 'message_aborted', truncateTo: c2 });
  });

  describe('append failures', () => {
    const uncaught: unknown[] = [];
    const onErr = (e: unknown) => uncaught.push(e);
    beforeEach(() => {
      uncaught.length = 0;
      process.on('uncaughtException', onErr);
      process.on('unhandledRejection', onErr);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(() => {
      process.off('uncaughtException', onErr);
      process.off('unhandledRejection', onErr);
    });
    function failOn(types: EventBody['type'][], times = 1) {
      const orig = actor.append.bind(actor);
      const left = new Map(types.map((t) => [t, times]));
      vi.spyOn(actor, 'append').mockImplementation((b: EventBody) => {
        const n = left.get(b.type) ?? 0;
        if (n > 0) {
          left.set(b.type, n - 1);
          throw new Error(`disk full (${b.type})`);
        }
        return orig(b);
      });
    }

    it('message_completed append throws once: done resolves error', async () => {
      setFakeScript(() => ({ chunks: ['Hi'], delayMs: 5 }));
      failOn(['message_completed']);
      const g = start();
      expect(await g.done).toBe('error');
      expect(actor.generations.has(g.messageId)).toBe(false);
      await sleep(100);
      expect(uncaught).toEqual([]);
    });

    it('token_delta and message_aborted both throw: nothing escapes', async () => {
      setFakeScript(() => ({ chunks: ['a', 'b'], delayMs: 5 }));
      failOn(['token_delta', 'message_aborted'], 10);
      const g = start();
      expect(await g.done).toBe('error');
      expect(actor.generations.has(g.messageId)).toBe(false);
      await sleep(150);
      expect(uncaught).toEqual([]);
    });

    it('timer flush failure with failing abort append: nothing escapes', async () => {
      setFakeScript(() => ({ chunks: ['a', 'b', 'c', 'd', 'e'], delayMs: 40 }));
      failOn(['token_delta', 'message_aborted'], 10);
      const g = start();
      expect(await g.done).toBe('error');
      await sleep(150);
      expect(uncaught).toEqual([]);
    });

    it('message_segment_started append throws: restart rethrows, done resolves error', async () => {
      setFakeScript(() => ({ chunks: ['a', 'b', 'c', 'd'], delayMs: 40 }));
      const g = start();
      await waitFor(() => g.firstTokenSeen);
      failOn(['message_segment_started']);
      expect(() => g.restart('replace', 0, ['x'])).toThrow(/disk full/);
      expect(await g.done).toBe('error');
      expect(actor.generations.has(g.messageId)).toBe(false);
      expect(g.restart('replace', 0, ['y'])).toBe(false);
      await sleep(150);
      expect(uncaught).toEqual([]);
    });

    it('stop append throws: stop rethrows, done still resolves', async () => {
      setFakeScript(() => ({ chunks: ['a', 'b', 'c'], delayMs: 40 }));
      const g = start();
      failOn(['message_aborted']);
      expect(() => g.stop(0)).toThrow(/disk full/);
      expect(await g.done).toBe('stopped');
      expect(actor.generations.has(g.messageId)).toBe(false);
      await sleep(150);
      expect(uncaught).toEqual([]);
    });
  });
});

describe('hung streams', () => {
  afterEach(() => setStreamTimeouts());

  it('defaults to a 25 s idle and 120 s total cap', () => {
    expect(STREAM_IDLE_MS).toBe(25_000);
    expect(STREAM_TOTAL_MS).toBe(120_000);
  });

  it('a stream that goes silent fails the message, keeping its text, and frees the agent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStreamTimeouts({ idleMs: 150 });
    setFakeScript(() => ({ chunks: ['Hello ', 'there'], delayMs: 1, hangAfterChunks: 1 }));
    const g = start();
    expect(await g.done).toBe('error');
    expect(actor.generations.has(g.messageId)).toBe(false);
    expect(msg(g)).toMatchObject({ status: 'stopped', text: 'Hello ' });
    expect(eventsFor(g).at(-1)).toMatchObject({ type: 'message_aborted', reason: 'error', truncateTo: 6 });
    const warned = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat();
    expect(warned.some((x) => x instanceof Error && x.name === 'StreamTimeoutError')).toBe(true);

    setFakeScript(() => ({ chunks: ['Back.'], delayMs: 1 }));
    const next = start();
    expect(await next.done).toBe('completed');
    expect(msg(next)?.text).toBe('Back.');
  });

  it('a stream that keeps trickling past the total cap fails too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStreamTimeouts({ idleMs: 1000, totalMs: 200 });
    setFakeScript(() => ({ chunks: Array.from({ length: 100 }, (_, i) => `w${i} `), delayMs: 20 }));
    const g = start();
    expect(await g.done).toBe('error');
    expect(msg(g)?.status).toBe('stopped');
    expect(msg(g)?.text.length).toBeGreaterThan(0);
    expect(msg(g)?.text).not.toContain('w99');
  });

  it('a stream that never sends anything fails cleanly', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStreamTimeouts({ idleMs: 100 });
    setFakeScript(() => ({ chunks: [], delayMs: 0, hangAfterChunks: 0 }));
    const g = start();
    expect(await g.done).toBe('error');
    expect(actor.generations.size).toBe(0);
    expect(visibleMessages(actor.view).some((m) => m.id === g.messageId)).toBe(false);
  });
});

describe('continuation seam helpers', () => {
  it('strips multi-word or long overlaps only', () => {
    expect(stripContinuation('The plan is ', 'plan is ship it')).toBe('ship it');
    expect(overlapLength('We use Kubernetes', 'Kubernetes now')).toBe(10); // ≥ 8 chars
    // A real doubled word survives.
    expect(stripContinuation('Maya said that ', 'that is fine.')).toBe('that is fine.');
    expect(overlapLength('foo bar', 'bar baz')).toBe(0);
  });
  it('collapses doubled whitespace at the seam', () => {
    expect(stripContinuation('The plan is ', ' ship it')).toBe('ship it');
    expect(stripContinuation('The plan is', ' ship it')).toBe(' ship it');
  });
  it('holds only while a longer overlap is possible', () => {
    expect(mustHold('The plan is ', 'ship')).toBe(false);
    expect(mustHold('The plan is ', 'pl')).toBe(true);
    expect(mustHold('The plan is ', ' ')).toBe(true);
    expect(mustHold('The plan is ', ' ship')).toBe(false);
    expect(mustHold('The plan is ', 'plan is ')).toBe(false); // already the longest
  });
});

describe('moved segments', () => {
  it('restart and reopen mark the segment moved only when asked', async () => {
    setFakeScript((r) =>
      r.kind === 'reply' ? { chunks: ['a ', 'b ', 'c ', 'd '], delayMs: 30 } : { chunks: ['x.'], delayMs: 5 },
    );
    const g = start('theo');
    await waitFor(() => g.textSoFar().length > 0);
    expect(g.restart('continue', 1, ['one'])).toBe(true);
    expect(g.restart('continue', 1, ['two'], { moved: true })).toBe(true);
    await g.done;
    const r1 = reopenGeneration(actor, g.messageId, ['three'], { moved: true });
    await r1.done;
    const r2 = reopenGeneration(actor, g.messageId, ['four']);
    await r2.done;
    const segs = eventsFor(g).filter((e) => e.type === 'message_segment_started');
    expect(segs.map((e) => ('moved' in e ? e.moved : undefined))).toEqual([undefined, true, true, undefined]);
    expect(msg(g)?.anchorSeq).toBe(segs[2]!.seq);
  });
});

describe('reopenGeneration', () => {
  it('rewrites a completed message in place with a replace segment', async () => {
    setFakeScript((r) =>
      r.kind === 'replace' ? { chunks: ['Short.'], delayMs: 5 } : { chunks: ['A long ', 'answer.'], delayMs: 5 },
    );
    const g = start('theo');
    await g.done;
    const before = actor.lastSeq;
    const r = reopenGeneration(actor, g.messageId, ['shorter']);
    expect(r.messageId).toBe(g.messageId);
    expect(r.segment).toBe(1);
    expect(actor.generations.get(g.messageId)).toBe(r);
    expect(msg(g)?.status).toBe('streaming');
    expect(msg(g)?.text).toBe('');
    expect(await r.done).toBe('completed');
    expect(msg(g)?.text).toBe('Short.');
    expect(msg(g)?.status).toBe('done');
    expect(actor.view.messages.filter((m) => m.author.kind === 'agent')).toHaveLength(1);
    const seg = eventsFor(g).find((e) => e.type === 'message_segment_started');
    expect(seg).toMatchObject({ segment: 1, truncateTo: 0, mode: 'replace', contextCutoffSeq: before });
    const last = fakeRequests.at(-1);
    expect(last?.kind).toBe('replace');
    expect(last?.agentId).toBe('theo');
    expect(JSON.stringify(last?.messages)).toContain('shorter');
    // Deltas of the new segment carry its number.
    expect(deltas(g).filter((d) => d.segment === 1).map((d) => d.text).join('')).toBe('Short.');
  });

  it('reopens a stopped message and can be restarted again', async () => {
    setFakeScript((r) =>
      r.kind === 'reply'
        ? { chunks: ['a ', 'b ', 'c ', 'd '], delayMs: 30 }
        : { chunks: ['x ', 'y ', 'z.'], delayMs: 30 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    g.stop(g.textSoFar().length);
    const r = reopenGeneration(actor, g.messageId, ['one']);
    expect(r.restart('replace', 0, ['one', 'two'])).toBe(true);
    expect(r.segment).toBe(2);
    expect(await r.done).toBe('completed');
    expect(msg(g)?.text).toBe('x y z.');
  });

  it('a rewrite that fails before its first token puts the answer back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r) =>
      r.kind === 'replace' ? { error: 'provider down' } : { chunks: ['A long ', 'answer.'], delayMs: 5 },
    );
    const g = start('theo');
    await g.done;
    const r = reopenGeneration(actor, g.messageId, ['shorter']);
    expect(await r.done).toBe('error');
    expect(msg(g)).toMatchObject({ text: 'A long answer.', status: 'stopped', segment: 1 });
    const tail = eventsFor(g).slice(-2);
    expect(tail[0]).toMatchObject({ type: 'token_delta', segment: 1, offset: 0, text: 'A long answer.' });
    expect(tail[1]).toMatchObject({ type: 'message_aborted', reason: 'error', truncateTo: 'A long answer.'.length });
    expect(visibleMessages(actor.view).some((m) => m.id === g.messageId)).toBe(true);
  });

  it('a live replace that fails before its first token keeps the earlier text, even after a second replace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    setFakeScript(() => {
      calls += 1;
      if (calls === 1) return { chunks: Array.from({ length: 20 }, (_, i) => `w${i} `), delayMs: 20 };
      if (calls === 2) return { chunks: ['never'], delayMs: 200 };
      return { error: 'provider down' };
    });
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    const before = g.textSoFar();
    expect(g.restart('replace', 0, ['one'])).toBe(true);
    expect(g.restart('replace', 0, ['two'])).toBe(true);
    expect(await g.done).toBe('error');
    expect(msg(g)?.text).toBe(before);
  });

  it('a rewrite that wrote something before failing keeps only the new text', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    setFakeScript((r) =>
      r.kind === 'replace' ? { error: 'cut off', afterChunks: 1 } : { chunks: ['Old text.'], delayMs: 5 },
    );
    const g = start();
    await g.done;
    const r = reopenGeneration(actor, g.messageId, ['x']);
    expect(await r.done).toBe('error');
    expect(msg(g)?.text).toBe('c0');
  });

  it('refuses a live or unknown message', async () => {
    setFakeScript(() => ({ chunks: ['a', 'b'], delayMs: 20 }));
    const g = start();
    expect(() => reopenGeneration(actor, g.messageId, ['x'])).toThrow(/live/);
    expect(() => reopenGeneration(actor, 'nope', ['x'])).toThrow();
    expect(() => reopenGeneration(actor, 'u1', ['x'])).toThrow();
    await g.done;
  });
});
