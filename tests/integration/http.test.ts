import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/server/db.js';
import { getActor } from '../../src/server/actor.js';
import { createApp } from '../../src/server/http.js';
import type { Hono } from 'hono';

// HTTP layer only: steering is stubbed (the real stack is covered in http-stack.test.ts).
const handle = vi.hoisted(() => ({ lastInput: undefined as unknown }));
vi.mock('../../src/server/steering/handle.js', () => ({
  handleUserMessage: async (
    actor: import('../../src/server/actor.js').ConversationActor,
    i: { clientMsgId: string; text: string },
  ) => {
    handle.lastInput = i;
    const existing = actor.findUserMessage(i.clientMsgId);
    const seq =
      existing?.seq ??
      actor.append({ type: 'user_message', messageId: `m-${i.clientMsgId}`, clientMsgId: i.clientMsgId, text: i.text }).seq;
    return { seq, settled: Promise.resolve() };
  },
  handleStop: (
    actor: import('../../src/server/actor.js').ConversationActor,
    i: { clientReqId: string },
  ) => {
    handle.lastInput = i;
    const existing = actor.findStopAll(i.clientReqId);
    return { seq: existing?.seq ?? actor.append({ type: 'stop_all', clientReqId: i.clientReqId }).seq };
  },
}));

let db: Db;
let app: Hono;
beforeEach(() => {
  db = openDb(':memory:');
  app = createApp(db);
});
afterEach(() => db.close());

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
const seqs = async (rd: ReturnType<typeof reader>, n: number) => {
  const out: number[] = [];
  while (out.length < n) out.push(Number((await rd.next()).id));
  return out;
};

const post = (path: string, body: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const msgBody = (o: object = {}) => ({ clientMsgId: 'c1', text: 'hello', typingStartedAt: null, rendered: {}, ...o });

describe('snapshot + events', () => {
  it('snapshot then events after has no gap or dup', async () => {
    const actor = getActor(db, 'c1');
    for (let i = 0; i < 3; i++) actor.append({ type: 'user_message', messageId: `m${i}`, clientMsgId: `x${i}`, text: 't' });
    const snap = (await (await app.request('/api/conv/c1/snapshot')).json()) as { view: { lastSeq: number } };
    expect(snap.view.lastSeq).toBe(3);

    // Connect, then append while the replay is being delivered.
    const res = await app.request(`/api/conv/c1/events?after=${snap.view.lastSeq}`);
    expect(res.headers.get('X-Accel-Buffering')).toBe('no');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const rd = reader(res);
    for (let i = 3; i < 10; i++) actor.append({ type: 'user_message', messageId: `m${i}`, clientMsgId: `x${i}`, text: 't' });

    const got = await seqs(rd, 7); // seqs 4..10
    expect(got).toEqual([4, 5, 6, 7, 8, 9, 10]);
    const union = [1, 2, 3, ...got];
    expect(union).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    await rd.cancel();
  });

  it('frames carry the full event as data', async () => {
    const actor = getActor(db, 'c1');
    actor.append({ type: 'user_message', messageId: 'm', clientMsgId: 'x', text: 'hi' });
    const rd = reader(await app.request('/api/conv/c1/events'));
    const f = await rd.next();
    expect(f.id).toBe('1');
    expect(JSON.parse(f.data!)).toMatchObject({ seq: 1, type: 'user_message', text: 'hi', conversationId: 'c1' });
    await rd.cancel();
  });

  it('Last-Event-ID resume overrides ?after', async () => {
    const actor = getActor(db, 'c1');
    for (let i = 0; i < 5; i++) actor.append({ type: 'user_message', messageId: `m${i}`, clientMsgId: `x${i}`, text: 't' });
    const rd = reader(await app.request('/api/conv/c1/events?after=0', { headers: { 'Last-Event-ID': '3' } }));
    expect(await seqs(rd, 2)).toEqual([4, 5]);
    actor.append({ type: 'user_message', messageId: 'm9', clientMsgId: 'x9', text: 't' });
    expect(await seqs(rd, 1)).toEqual([6]);
    await rd.cancel();
  });

  it('unsubscribes when the client goes away', async () => {
    const actor = getActor(db, 'c1');
    const unsubs: ReturnType<typeof vi.fn>[] = [];
    const orig = actor.subscribe.bind(actor);
    vi.spyOn(actor, 'subscribe').mockImplementation((fn) => {
      const u = orig(fn);
      const spy = vi.fn(u);
      unsubs.push(spy);
      return spy;
    });
    const res = await app.request('/api/conv/c1/events');
    const rd = reader(res);
    actor.append({ type: 'user_message', messageId: 'm', clientMsgId: 'x', text: 't' });
    await rd.next();
    await rd.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(unsubs).toHaveLength(1);
    expect(unsubs[0]).toHaveBeenCalled();
  });

  it('sends a ping comment every 20s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const rd = reader(await app.request('/api/conv/c1/events'));
      await vi.advanceTimersByTimeAsync(20_000);
      expect((await rd.next()).comment).toBe('ping');
      await rd.cancel();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('commands', () => {
  it('POST messages idempotent', async () => {
    const a = (await (await post('/api/conv/c1/messages', msgBody())).json()) as { seq: number };
    const b = (await (await post('/api/conv/c1/messages', msgBody())).json()) as { seq: number };
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(a.seq);
    expect(getActor(db, 'c1').lastSeq).toBe(1);
  });

  it('rejects empty text', async () => {
    for (const text of ['', '   \n', 5, undefined]) {
      const res = await post('/api/conv/c1/messages', msgBody({ text }));
      expect(res.status).toBe(400);
      expect(await res.json()).toHaveProperty('error');
    }
    expect(getActor(db, 'c1').lastSeq).toBe(0);
  });

  it('text limit is 4000 after trim, and text is trimmed', async () => {
    expect((await post('/api/conv/c1/messages', msgBody({ text: 'a'.repeat(4001) }))).status).toBe(400);
    expect((await post('/api/conv/c1/messages', msgBody({ text: 'a'.repeat(4000) }))).status).toBe(200);
    await post('/api/conv/c1/messages', msgBody({ clientMsgId: 'c2', text: '  padded  ' }));
    expect((handle.lastInput as { text: string }).text).toBe('padded');
  });

  it('validates ids, rendered and typingStartedAt', async () => {
    const bads = [
      { clientMsgId: '' },
      { clientMsgId: 'x'.repeat(101) },
      { clientMsgId: 7 },
      { rendered: { a: -1 } },
      { rendered: { a: 1.5 } },
      { rendered: 'x' },
      { typingStartedAt: 'now' },
    ];
    for (const o of bads) expect((await post('/api/conv/c1/messages', msgBody(o))).status).toBe(400);
    const res = await app.request('/api/conv/c1/messages', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(400);
    // rendered optional, defaults to {}
    const ok = await post('/api/conv/c1/messages', { clientMsgId: 'ok', text: 'hi', typingStartedAt: 123 });
    expect(ok.status).toBe(200);
    expect(handle.lastInput).toMatchObject({ rendered: {}, typingStartedAt: 123 });
  });

  it('stop validates and is idempotent', async () => {
    expect((await post('/api/conv/c1/stop', { rendered: {} })).status).toBe(400);
    const a = (await (await post('/api/conv/c1/stop', { clientReqId: 's1' })).json()) as { seq: number };
    const b = (await (await post('/api/conv/c1/stop', { clientReqId: 's1', rendered: { m: 3 } })).json()) as { seq: number };
    expect(b.seq).toBe(a.seq);
  });
});

describe('routing', () => {
  it('rejects bad conversation ids', async () => {
    expect((await app.request('/api/conv/bad.id/snapshot')).status).toBe(404);
    expect((await app.request(`/api/conv/${'a'.repeat(65)}/snapshot`)).status).toBe(404);
    expect((await post('/api/conv/bad%20id/messages', msgBody())).status).toBe(404);
  });

  it('/api/* 404s as JSON', async () => {
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error');
  });

  it('GET / redirects to /c/<uuid>', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/c\/[0-9a-f-]{36}$/);
  });

  it('GET /c/:id serves the SPA shell or 503 when unbuilt', async () => {
    const res = await app.request('/c/abc');
    expect([200, 503]).toContain(res.status);
    if (res.status === 503) expect(await res.text()).toContain('frontend not built');
    else expect(res.headers.get('content-type')).toContain('text/html');
  });
});
