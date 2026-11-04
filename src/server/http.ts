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

/** Absent stays undefined (the server then counts committed text as seen); a map, even {}, is what the client showed. */
function rendered(v: unknown): Parsed<Record<string, number> | undefined> {
  if (v === undefined) return { ok: true, value: undefined };
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

const RATE_WINDOW_MS = 60_000;
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return process.env[name] && Number.isInteger(n) && n > 0 ? n : fallback;
}
/** New messages one client IP may post per minute (env RATE_LIMIT_PER_MIN). */
export const rateLimitPerMin = () => envInt('RATE_LIMIT_PER_MIN', 20);
/** User messages one conversation may hold in total (env MAX_MESSAGES_PER_CONV). */
export const maxMessagesPerConv = () => envInt('MAX_MESSAGES_PER_CONV', 300);

/**
 * Fly-Client-IP is set by Fly's proxy and cannot be forged; the first
 * X-Forwarded-For hop is next best; else the socket peer.
 */
function clientIp(c: Context): string {
  const fly = c.req.header('fly-client-ip')?.trim();
  if (fly) return fly;
  const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (xff) return xff;
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Sliding one-minute window of accepted message times per key. */
function rateLimiter() {
  const hits = new Map<string, number[]>();
  return (key: string, limit: number, now = Date.now()): boolean => {
    if (hits.size > 10_000) {
      for (const [k, ts] of hits) if ((ts.at(-1) ?? 0) <= now - RATE_WINDOW_MS) hits.delete(k);
    }
    const recent = (hits.get(key) ?? []).filter((t) => t > now - RATE_WINDOW_MS);
    if (recent.length >= limit) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export function createApp(db: Db): Hono {
  const app = new Hono();
  const allowIp = rateLimiter();

  app.get('/api/health', (c) => c.json({ ok: true }));

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
    const sentAt = body.sentAt ?? null;
    if (sentAt !== null && (typeof sentAt !== 'number' || !Number.isFinite(sentAt))) {
      return bad(c, 'sentAt must be a finite number');
    }
    // typingStartedAt is a client timestamp: move it onto the server clock.
    const typingStartedAt = t !== null && sentAt !== null ? t + (Date.now() - sentAt) : t;
    const actor = getActor(db, c.req.param('id'));
    // Coarse spend guard for a public deploy. A retry of a delivered message is never limited.
    if (!actor.findUserMessage(id.value)) {
      const users = actor.view.messages.filter((m) => m.author.kind === 'user').length;
      if (users >= maxMessagesPerConv()) {
        return c.json({ error: 'this conversation has reached its message limit' }, 429);
      }
      if (!allowIp(clientIp(c), rateLimitPerMin())) {
        return c.json({ error: 'too many messages, try again in a minute' }, 429);
      }
    }
    const { seq } = await handleUserMessage(actor, {
      clientMsgId: id.value,
      text,
      typingStartedAt,
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
