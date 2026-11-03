import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { getActor } from '../../src/server/actor.js';
import { createApp } from '../../src/server/http.js';
import { resetFake, setFakeScript, type FakeReply, type FakeRequest } from '../../src/server/llm/fake.js';
import { fakeScripts } from '../../src/server/llm/fake-scripts.js';
import type { ConvEvent } from '../../src/shared/events.js';
import type { Hono } from 'hono';

// Real stack (handle.ts, generation, fake LLM); no mocks. Skipped until steering/handle.ts exists.
const haveHandle = existsSync(new URL('../../src/server/steering/handle.ts', import.meta.url));

let db: Db;
let app: Hono;
beforeEach(() => {
  process.env.MODEL_AGENT = 'fake:x';
  process.env.MODEL_GATE = 'fake:x';
  process.env.MODEL_CLASSIFIER = 'fake:x';
  resetFake();
  db = openDb(':memory:');
  app = createApp(db);
});
afterEach(() => {
  delete process.env.MODEL_AGENT;
  delete process.env.MODEL_GATE;
  delete process.env.MODEL_CLASSIFIER;
  resetFake();
  db.close();
});

interface Frame {
  id?: string;
  data?: string;
  comment?: string;
}
/** Incremental SSE reader over a streaming Response. */
function reader(res: Response) {
  const r = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  async function next(timeoutMs = 2000): Promise<Frame> {
    for (;;) {
      const i = buf.indexOf('\n\n');
      if (i >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = {};
        for (const line of raw.split('\n')) {
          if (line.startsWith('id:')) f.id = line.slice(3).trim();
          else if (line.startsWith('data:')) f.data = line.slice(5).trim();
          else if (line.startsWith(':')) f.comment = line.slice(1).trim();
        }
        return f;
      }
      const chunk = await Promise.race([
        r.read(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sse read timeout')), timeoutMs)),
      ]);
      if (chunk.done) throw new Error('stream ended');
      buf += dec.decode(chunk.value, { stream: true });
    }
  }
  return { next, cancel: () => r.cancel() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function collectUntil(rd: ReturnType<typeof reader>, lastSeq: number): Promise<ConvEvent[]> {
  const out: ConvEvent[] = [];
  while ((out.at(-1)?.seq ?? 0) < lastSeq) out.push(JSON.parse((await rd.next(5000)).data!) as ConvEvent);
  return out;
}

describe('two tabs', () => {
  (haveHandle ? it : it.todo)('two subscribers identical', async () => {
    // Steer the second message toward maya; everything else is the stock fake script.
    setFakeScript((r: FakeRequest): FakeReply => {
      if (r.kind === 'classify' && /shorter/.test(r.prompt ?? '')) {
        return {
          object: { kind: 'steer', targets: ['maya'], apply: 'continue', scope: 'one_off', standing_text: null, revokes: [] },
        };
      }
      if (r.kind === 'reply') return { chunks: Array.from({ length: 12 }, (_, i) => `w${i} `), delayMs: 25 };
      return fakeScripts.default!(r);
    });
    const actor = getActor(db, 'c1');
    const a = reader(await app.request('/api/conv/c1/events'));
    await post('/api/conv/c1/messages', { clientMsgId: 'm1', text: 'what should we build?', typingStartedAt: null, rendered: {} });

    // Tab B opens mid-stream, from scratch.
    while (!actor.view.messages.some((m) => m.status === 'streaming')) await sleep(5);
    const b = reader(await app.request('/api/conv/c1/events'));
    await sleep(40);
    await post('/api/conv/c1/messages', { clientMsgId: 'm2', text: 'maya, shorter please', typingStartedAt: null, rendered: {} });

    // Wait for quiescence.
    for (let i = 0; i < 400 && (actor.generations.size > 0 || actor.turnAbort !== null || actor.view.messages.some((m) => m.status === 'streaming')); i++) await sleep(25);
    await sleep(50);
    const last = actor.lastSeq;
    const ea = await collectUntil(a, last);
    const eb = await collectUntil(b, last);
    expect(ea.map((e) => e.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
    expect(eb.map((e) => e.seq)).toEqual(ea.map((e) => e.seq));
    expect(eb).toEqual(ea);
    expect(ea).toEqual(actor.eventsAfter(0));
    expect(ea.some((e) => e.type === 'message_segment_started')).toBe(true);

    // A reload (snapshot) matches the live fold.
    const snap = (await (await app.request('/api/conv/c1/snapshot')).json()) as { view: unknown };
    expect(snap.view).toEqual(JSON.parse(JSON.stringify(actor.view)));
    await a.cancel();
    await b.cancel();
  }, 20_000);
});
