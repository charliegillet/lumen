import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { resetFake, setFakeScript, type FakeReply } from '../../src/server/llm/fake.js';
import { startGeneration, type Generation } from '../../src/server/orchestrator/generation.js';
import { handleUserMessage } from '../../src/server/steering/handle.js';
import type { SteerDecision } from '../../src/server/steering/classify.js';
import type { ConvEvent } from '../../src/shared/events.js';

// Holds chosen structured calls (here: the classifier) until released.
const hooks = vi.hoisted(() => ({
  before: null as null | ((meta: { kind: string }) => Promise<void> | undefined),
}));
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

const NEW_MESSAGE: SteerDecision = {
  kind: 'new_message',
  targets: [],
  apply: 'continue',
  scope: 'one_off',
  standing_text: null,
  revokes: [],
};
const STEERED = ['STEERED: ', 'short', ' answer.'];
const PLAIN = Array.from({ length: 12 }, (_, i) => `w${i} `);

let db: Db;
let actor: ConversationActor;
let classify: (text: string) => SteerDecision;
beforeEach(() => {
  process.env.MODEL_AGENT = 'fake:x';
  process.env.MODEL_GATE = 'fake:x';
  process.env.MODEL_CLASSIFIER = 'fake:x';
  resetFake();
  hooks.before = null;
  classify = () => NEW_MESSAGE;
  setFakeScript((r): FakeReply => {
    if (r.kind === 'reply') return { chunks: PLAIN, delayMs: 30 };
    if (r.kind === 'continue' || r.kind === 'replace') return { chunks: STEERED, delayMs: 30 };
    if (r.kind === 'classify') {
      const text = /The human's new message:\n([\s\S]*)$/.exec(r.prompt ?? '')?.[1] ?? '';
      return { object: classify(text) };
    }
    if (r.kind === 'judge') return { object: { complies: true } };
    return { object: { should_respond: false, novelty: 0, gist: '', addresses: [], effort: 'low' } };
  });
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
const startTheo = (): Generation =>
  startGeneration(actor, { agentId: 'theo', turnId: 't1', hop: 0, replyTo: 'u1', effort: 'low', gist: 'g', othersReplying: [] });
let n = 0;
const send = (text: string) =>
  handleUserMessage(actor, {
    clientMsgId: `c-${++n}`,
    text,
    typingStartedAt: null,
    rendered: Object.fromEntries([...actor.generations.values()].map((g) => [g.messageId, g.textSoFar().length])),
  });
const events = () => actor.eventsAfter(0);
const theoMessages = () => actor.view.messages.filter((m) => m.author.kind === 'agent' && m.author.agentId === 'theo');
const segments = (id: string) =>
  events().filter((e): e is Extract<ConvEvent, { type: 'message_segment_started' }> => e.type === 'message_segment_started' && e.messageId === id);

/**
 * Message A is sent and held in the classifier. While it is held, Theo is
 * stopped (`stopText`) and then asked a fresh question, which starts a new
 * Theo message. Only then does A's classification come back.
 */
async function stopThenAskAgain(stopText: string, decideA: SteerDecision) {
  const old = startTheo();
  await waitFor(() => old.textSoFar().length > 0);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let classifies = 0;
  hooks.before = (meta) => (meta.kind === 'classify' && ++classifies === 1 ? held : undefined);
  classify = (text) => (text.includes('MSG-A') ? decideA : NEW_MESSAGE);

  const a = await send('MSG-A for theo');
  const stop = await send(stopText);
  await stop.settled;
  expect(theoMessages()[0]?.status).toBe('stopped');
  const b = await send('Theo, what about pricing?');
  await waitFor(() => theoMessages().length === 2 && theoMessages()[1]!.text.length > 0);
  release();
  await Promise.all([a.settled, b.settled]);
  await waitFor(() => actor.generations.size === 0, 5000);
  return theoMessages()[1]!;
}

describe('a decision that lands after a stop does not touch work started after that stop', () => {
  it('a steer sent before "@Theo stop" does not redirect the answer Theo gives afterwards', async () => {
    const second = await stopThenAskAgain('@Theo stop', { ...NEW_MESSAGE, kind: 'steer', targets: ['theo'] });
    expect(segments(second.id)).toHaveLength(0);
    expect(second.status).toBe('done');
    expect(second.text).toBe(PLAIN.join(''));
  });

  it('a stop decided by the classifier does not cut the answer Theo gives after a later stop-all', async () => {
    const second = await stopThenAskAgain('stop', { ...NEW_MESSAGE, kind: 'stop', targets: ['theo'] });
    expect(second.status).toBe('done');
    expect(second.text).toBe(PLAIN.join(''));
  });
});
