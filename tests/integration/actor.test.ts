import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/server/db.js';
import { ConversationActor, getActor } from '../../src/server/actor.js';
import { applyEvent, fold } from '../../src/shared/reducer.js';
import type { ConvEvent, EventBody } from '../../src/shared/events.js';

const dirs: string[] = [];
const dbs: Db[] = [];
function tempDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'actor-test-'));
  dirs.push(dir);
  const db = openDb(join(dir, 'sub', 'test.db'));
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const started = (messageId: string): EventBody => ({
  type: 'message_started',
  messageId,
  agentId: 'maya',
  turnId: 't1',
  hop: 0,
  replyTo: null,
  contextCutoffSeq: 0,
  effort: 'low',
});

function mixed(actor: ConversationActor) {
  actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'c1', text: 'hi' });
  actor.append(started('a1'));
  actor.append({ type: 'token_delta', messageId: 'a1', segment: 0, offset: 0, text: 'hel' });
  actor.append({ type: 'token_delta', messageId: 'a1', segment: 0, offset: 3, text: 'lo' });
  actor.append({ type: 'instruction_set', instructionId: 'i1', scope: 'all', text: 'be brief' });
  actor.append({ type: 'message_completed', messageId: 'a1' });
  actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'c2', text: 'again' });
  actor.append(started('a2'));
  actor.append({ type: 'token_delta', messageId: 'a2', segment: 0, offset: 0, text: 'xyz' });
  actor.append({ type: 'message_aborted', messageId: 'a2', reason: 'user_stop', truncateTo: 1 });
  actor.append({ type: 'instruction_revoked', instructionId: 'i1' });
}

describe('ConversationActor', () => {
  it('assigns gap-free seq', async () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      ps.push(
        Promise.resolve().then(() => {
          actor.append({ type: 'stop_all', clientReqId: `r${i}` });
        }),
      );
    }
    await Promise.all(ps);
    const rows = db.prepare('SELECT seq, body FROM events WHERE conversation_id = ? ORDER BY rowid').all('c') as { seq: number; body: string }[];
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(rows.map((r) => JSON.parse(r.body).clientReqId)).toEqual(Array.from({ length: 100 }, (_, i) => `r${i}`));
  });

  it('reload equals live', () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    mixed(actor);
    const reloaded = new ConversationActor(db, 'c');
    expect(reloaded.view).toEqual(actor.view);
    expect(reloaded.lastSeq).toBe(actor.lastSeq);
  });

  it('snapshot + eventsAfter(S) == live', () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    mixed(actor);
    for (let s = 0; s <= actor.lastSeq; s++) {
      const snap = fold(actor.eventsUpTo(s));
      expect(actor.eventsAfter(s).reduce(applyEvent, snap)).toEqual(actor.view);
    }
  });

  it('subscribers get events in seq order and a throwing subscriber is isolated', () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    const seen: number[] = [];
    const seen2: number[] = [];
    const unsub = actor.subscribe((e) => seen.push(e.seq));
    actor.subscribe(() => {
      throw new Error('boom');
    });
    actor.subscribe((e) => seen2.push(e.seq));
    mixed(actor);
    expect(seen).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    expect(seen2).toEqual(seen);
    unsub();
    actor.append({ type: 'stop_all', clientReqId: 'x' });
    expect(seen).toHaveLength(11);
  });

  it('duplicate clientMsgId rejected', () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    const first = actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'dup', text: 'a' });
    const before = actor.view;
    expect(() => actor.append({ type: 'user_message', messageId: 'u2', clientMsgId: 'dup', text: 'b' })).toThrow();
    expect(actor.lastSeq).toBe(1);
    expect(actor.view).toBe(before);
    expect(actor.findUserMessage('dup')).toEqual(first);
    expect(actor.findUserMessage('nope')).toBeUndefined();
    const next = actor.append({ type: 'stop_all', clientReqId: 'r' });
    expect(next.seq).toBe(2);
  });

  it('recovery closes dangling streams', () => {
    const db = tempDb();
    const actor = new ConversationActor(db, 'c');
    actor.append(started('a1'));
    actor.append({ type: 'token_delta', messageId: 'a1', segment: 0, offset: 0, text: 'partial' });
    const fresh = new ConversationActor(db, 'c');
    const last = fresh.eventsAfter(2);
    expect(last).toHaveLength(1);
    expect(last[0]).toMatchObject({ type: 'message_aborted', messageId: 'a1', reason: 'server_restart', truncateTo: 7 });
    const m = fresh.view.messages[0]!;
    expect(m.status).toBe('stopped');
    expect(m.text).toBe('partial');
    // idempotent
    expect(new ConversationActor(db, 'c').lastSeq).toBe(fresh.lastSeq);
  });

  it('getActor memoizes per db and id', () => {
    const db = tempDb();
    expect(getActor(db, 'a')).toBe(getActor(db, 'a'));
    expect(getActor(db, 'a')).not.toBe(getActor(db, 'b'));
    const db2 = tempDb();
    expect(getActor(db2, 'a')).not.toBe(getActor(db, 'a'));
  });

  it('openDb supports :memory:', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const a = new ConversationActor(db, 'c');
    const e: ConvEvent = a.append({ type: 'stop_all', clientReqId: 'r' });
    expect(e.seq).toBe(1);
  });
});
