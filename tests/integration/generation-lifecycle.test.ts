import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';
import { reopenGeneration, startGeneration, type Generation } from '../../src/server/orchestrator/generation.js';
import type { Effort } from '../../src/shared/events.js';

// Lets a test replace the agent stream so it can see the AbortSignal the
// provider call was given.
const hooks = vi.hoisted(() => ({
  override: null as null | ((a: { signal: AbortSignal }) => AsyncIterable<string>),
}));
vi.mock('../../src/server/llm/stream.js', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/server/llm/stream.js')>();
  return {
    ...m,
    streamChat: (a: Parameters<typeof m.streamChat>[0]) => (hooks.override ? hooks.override(a) : m.streamChat(a)),
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
  vi.useRealTimers();
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
const start = (effort: Effort = 'low'): Generation =>
  startGeneration(actor, { agentId: 'maya', turnId: 't1', hop: 0, replyTo: 'u1', effort, gist: 'the plan', othersReplying: [] });
const msg = (g: Generation) => actor.view.messages.find((m) => m.id === g.messageId);

/** A stream that sends `first`, then stays silent. Records each call's signal. */
function silentAfter(first: string, signals: AbortSignal[]): void {
  hooks.override = ({ signal }) => {
    signals.push(signal);
    return (async function* () {
      yield first;
      await new Promise<void>(() => {}); // never resolves
    })();
  };
}

describe('a retired segment really stops its provider call', () => {
  it('stop aborts the provider signal', async () => {
    const signals: AbortSignal[] = [];
    silentAfter('abc', signals);
    const g = start();
    await waitFor(() => signals.length === 1);
    g.stop(0);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('a restart aborts the superseded segment but not the new one', async () => {
    const signals: AbortSignal[] = [];
    silentAfter('abc', signals);
    const g = start();
    await waitFor(() => signals.length === 1);
    g.restart('replace', 0, ['again']);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    g.stop(0);
  });

  it('a stream error aborts the provider signal', async () => {
    const signals: AbortSignal[] = [];
    hooks.override = ({ signal }) => {
      signals.push(signal);
      return (async function* () {
        yield 'abc';
        throw new Error('boom');
      })();
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = start();
    expect(await g.done).toBe('error');
    expect(signals[0]?.aborted).toBe(true);
  });

  it('stop leaves no flush timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    silentAfter('abc', []);
    const g = start();
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1)); // the 75 ms flush is pending
    g.stop(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('continuation seam across chunk boundaries', () => {
  it('holds back a head that may still turn out to repeat the tail', async () => {
    setFakeScript((r) =>
      r.kind === 'continue'
        ? { chunks: ['plan', ' is ', 'ship Friday.'], delayMs: 5 }
        : { chunks: ['The plan is to ', 'launch ', 'on ', 'Monday ', 'and ', 'more.'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().startsWith('The plan is to '));
    g.restart('continue', 12, ['be brief']);
    expect(await g.done).toBe('completed');
    expect(msg(g)?.text).toBe('The plan is ship Friday.');
  });
});

describe('what a rewrite is told and how hard it thinks', () => {
  it('a replace restart puts the steer in the prompt', async () => {
    setFakeScript((r) =>
      r.kind === 'replace' ? { chunks: ['New.'], delayMs: 5 } : { chunks: ['Old ', 'text ', 'here.'], delayMs: 40 },
    );
    const g = start();
    await waitFor(() => g.textSoFar().length > 0);
    g.restart('replace', 0, ['SECRET-STEER-TEXT']);
    await g.done;
    const req = fakeRequests.filter((r) => r.kind === 'replace').at(-1);
    expect(JSON.stringify(req?.messages)).toContain('SECRET-STEER-TEXT');
  });

  it('the stream gets the generation effort', async () => {
    setFakeScript(() => ({ chunks: ['ok'], delayMs: 1 }));
    await start('low').done;
    await start('high').done;
    expect(fakeRequests.filter((r) => r.kind === 'reply').map((r) => r.reasoning)).toEqual(['none', 'medium']);
  });

  it('a reopened message keeps the effort it was started with', async () => {
    setFakeScript(() => ({ chunks: ['ok'], delayMs: 1 }));
    const g = start('high');
    await g.done;
    await reopenGeneration(actor, g.messageId, ['again']).done;
    const last = fakeRequests.filter((r) => r.kind === 'replace').at(-1);
    expect(last?.reasoning).toBe('medium');
  });
});
