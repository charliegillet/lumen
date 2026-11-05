import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { applyEvent, fold } from '../../src/shared/reducer.js';
import type { ConvEvent, EventBody } from '../../src/shared/events.js';

const dirs: string[] = [];
const dbs: Db[] = [];
function fileDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'store-test-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'test.db'));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('conversations share a database but not their idempotency keys', () => {
  it('a clientMsgId is only found in its own conversation, and may be reused in another', () => {
    const db = fileDb();
    const a = new ConversationActor(db, 'a');
    const b = new ConversationActor(db, 'b');
    a.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'same', text: 'hi' });
    expect(a.findUserMessage('same')).toBeDefined();
    expect(b.findUserMessage('same')).toBeUndefined();
    expect(() => b.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'same', text: 'yo' })).not.toThrow();
    expect(b.findUserMessage('same')?.conversationId).toBe('b');
  });

  it('a clientReqId for stop is only found in its own conversation', () => {
    const db = fileDb();
    const a = new ConversationActor(db, 'a');
    const b = new ConversationActor(db, 'b');
    a.append({ type: 'stop_all', clientReqId: 'req' });
    expect(a.findStopAll('req')).toBeDefined();
    expect(b.findStopAll('req')).toBeUndefined();
  });
});

describe('storage guarantees', () => {
  it('a stale writer cannot reuse a seq, even later', async () => {
    const db = fileDb();
    const first = new ConversationActor(db, 'c');
    const stale = new ConversationActor(db, 'c');
    first.append({ type: 'stop_all', clientReqId: 'r1' });
    await sleep(3); // a different `at` must not make the duplicate (conversation, seq) legal
    expect(() => stale.append({ type: 'stop_all', clientReqId: 'r2' })).toThrow();
    expect(first.eventsAfter(0)).toHaveLength(1);
  });

  it('uses write-ahead logging', () => {
    expect(fileDb().pragma('journal_mode', { simple: true })).toBe('wal');
  });
});

describe('reducer: closed messages', () => {
  const at = (seq: number, body: EventBody): ConvEvent => ({ ...body, seq, conversationId: 'c', at: seq }) as ConvEvent;
  it.each(['message_completed', 'message_aborted'] as const)('ignores a delta that arrives after %s', (closer) => {
    const closeBody: EventBody =
      closer === 'message_completed'
        ? { type: 'message_completed', messageId: 'a1' }
        : { type: 'message_aborted', messageId: 'a1', reason: 'user_stop', truncateTo: 2 };
    const log = [
      at(1, { type: 'message_started', messageId: 'a1', agentId: 'maya', turnId: 't', hop: 0, replyTo: null, contextCutoffSeq: 0, effort: 'low' }),
      at(2, { type: 'token_delta', messageId: 'a1', segment: 0, offset: 0, text: 'ab' }),
      at(3, closeBody),
    ];
    const closed = fold(log);
    const after = applyEvent(closed, at(4, { type: 'token_delta', messageId: 'a1', segment: 0, offset: 2, text: 'LATE' }));
    expect(after.messages.find((m) => m.id === 'a1')?.text).toBe('ab');
  });
});
