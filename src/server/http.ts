import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Db } from './db.js';
import { getActor } from './actor.js';
import { handleStop, handleUserMessage } from './steering/handle.js';
import type { ConvEvent } from '../shared/events.js';

const CONV_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PING_MS = 20_000;

/** Built frontend lives in <project root>/dist/web, never next to the sources (src/web is Vite's source root). */
export function resolveWebRoot(cwd: string = process.cwd()): string {
  return resolve(cwd, 'dist/web');
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function clientId(v: unknown, name: string): Parsed<string> {
  if (typeof v !== 'string' || v.length === 0 || v.length > 100) {
    return { ok: false, error: `${name} must be a non-empty string of at most 100 chars` };
  }
  return { ok: true, value: v };
}

function rendered(v: unknown): Parsed<Record<string, number>> {
  if (v === undefined) return { ok: true, value: {} };
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { ok: false, error: 'rendered must be an object' };
  }
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: 'rendered values must be non-negative integers' };
    }
    out[k] = n;
  }
  return { ok: true, value: out };
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return typeof b === 'object' && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const bad = (c: Context, error: string) => c.json({ error }, 400);

export function createApp(db: Db): Hono {
  const app = new Hono();

  app.use('/api/conv/:id/*', async (c, next) => {
    if (!CONV_ID.test(c.req.param('id') ?? '')) return c.json({ error: 'not found' }, 404);
    await next();
  });

  app.get('/api/conv/:id/snapshot', (c) => {
    const actor = getActor(db, c.req.param('id'));
    return c.json({ view: actor.view });
  });

  app.get('/api/conv/:id/events', (c) => {
    const actor = getActor(db, c.req.param('id'));
    const raw = c.req.header('Last-Event-ID') || c.req.query('after') || '0';
    // A stale id beyond the log (e.g. after a DB reset) would dedupe every new event away.
    const after = Math.min(/^\d+$/.test(raw) ? Number(raw) : 0, actor.lastSeq);

    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache');
    return streamSSE(c, async (stream) => {
      let last = after;
      let closed = false;
      const queue: ConvEvent[] = [];
      let pumping = false;

      const pump = async (): Promise<void> => {
        if (pumping) return;
        pumping = true;
        try {
          while (!closed && queue.length > 0) {
            const e = queue.shift()!;
            if (e.seq <= last) continue; // dedupe replay vs live
            last = e.seq;
            await stream.writeSSE({ id: String(e.seq), data: JSON.stringify(e) });
          }
        } catch {
          cleanup();
        } finally {
          pumping = false;
        }
      };

      let unsubscribe: () => void = () => {};
      let ping: ReturnType<typeof setInterval> | undefined;
      let finish: () => void = () => {};
      const cleanup = (): void => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
        finish();
      };

      // Subscribe before replaying so nothing falls between the two.
      unsubscribe = actor.subscribe((e) => {
        queue.push(e);
        void pump();
      });
      ping = setInterval(() => {
        if (closed) return;
        void stream.write(': ping\n\n').catch(cleanup);
      }, PING_MS);

      const done = new Promise<void>((res) => {
        finish = res;
        stream.onAbort(cleanup);
      });

      // Replay is sorted ahead of any live events already buffered.
      queue.unshift(...actor.eventsAfter(after));
      queue.sort((a, b) => a.seq - b.seq);
      await pump();
      await done;
      cleanup();
    });
  });

  app.post('/api/conv/:id/messages', async (c) => {
    const body = await readBody(c);
    if (!body) return bad(c, 'invalid JSON body');
    if (typeof body.text !== 'string') return bad(c, 'text must be a string');
    const text = body.text.trim();
    if (text.length === 0) return bad(c, 'text must not be empty');
    if (text.length > 4000) return bad(c, 'text must be at most 4000 chars');
    const id = clientId(body.clientMsgId, 'clientMsgId');
    if (!id.ok) return bad(c, id.error);
    const r = rendered(body.rendered);
    if (!r.ok) return bad(c, r.error);
    const t = body.typingStartedAt ?? null;
    if (t !== null && (typeof t !== 'number' || !Number.isFinite(t))) {
      return bad(c, 'typingStartedAt must be a number or null');
    }
    const actor = getActor(db, c.req.param('id'));
    const { seq } = await handleUserMessage(actor, {
      clientMsgId: id.value,
      text,
      typingStartedAt: t,
      rendered: r.value,
    });
    return c.json({ seq });
  });

  app.post('/api/conv/:id/stop', async (c) => {
    const body = await readBody(c);
    if (!body) return bad(c, 'invalid JSON body');
    const id = clientId(body.clientReqId, 'clientReqId');
    if (!id.ok) return bad(c, id.error);
    const r = rendered(body.rendered);
    if (!r.ok) return bad(c, r.error);
    const actor = getActor(db, c.req.param('id'));
    const { seq } = handleStop(actor, { clientReqId: id.value, rendered: r.value });
    return c.json({ seq });
  });

  app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

  app.get('/', (c) => c.redirect(`/c/${randomUUID()}`, 302));

  const root = resolveWebRoot();
  app.get('/c/:id', (c) => {
    if (!CONV_ID.test(c.req.param('id'))) return c.text('not found', 404);
    const index = join(root, 'index.html');
    if (!existsSync(index)) return c.text('frontend not built — run npm run build', 503);
    c.header('Cache-Control', 'no-cache');
    return c.html(readFileSync(index, 'utf8'));
  });

  app.use('/*', serveStatic({ root: relative(process.cwd(), root) || '.' }));

  return app;
}
