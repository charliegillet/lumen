import type { ConvEvent, EventBody } from '../shared/events.js';
import { applyEvent, emptyView, fold, type ConversationView } from '../shared/reducer.js';
import type { Db } from './db.js';
import type { Generation } from './orchestrator/generation.js';

interface Row {
  seq: number;
  body: string;
  at: number;
}

/**
 * Single writer of the append-only event log for one conversation.
 * Ordering invariant: seq assignment and the synchronous INSERT happen with no await between.
 */
export class ConversationActor {
  readonly id: string;
  readonly generations = new Map<string, Generation>();
  turnAbort: AbortController | null = null;
  /** Seq of the message the running turn answers. Meaningful while turnAbort is set. */
  turnTriggerSeq = 0;
  /** User messages the previous process died before deciding. */
  readonly undecidedAtBoot: { messageId: string; clientMsgId: string; text: string; seq: number; at: number }[] = [];

  private readonly db: Db;
  private _lastSeq = 0;
  private _view: ConversationView;
  private readonly subscribers = new Set<(e: ConvEvent) => void>();
  private readonly pending: ConvEvent[] = [];
  private draining = false;
  private holds = 0;
  private readonly insertStmt;
  private readonly afterStmt;
  private readonly upToStmt;
  private readonly findUserStmt;
  private readonly findStopStmt;
  private readonly eventStmt;

  constructor(db: Db, id: string) {
    this.db = db;
    this.id = id;
    this.insertStmt = db.prepare(
      'INSERT INTO events (conversation_id, seq, type, body, at) VALUES (?, ?, ?, ?, ?)',
    );
    this.afterStmt = db.prepare(
      'SELECT seq, body, at FROM events WHERE conversation_id = ? AND seq > ? ORDER BY seq',
    );
    this.upToStmt = db.prepare(
      'SELECT seq, body, at FROM events WHERE conversation_id = ? AND seq <= ? ORDER BY seq',
    );
    this.findUserStmt = db.prepare(
      "SELECT seq, body, at FROM events WHERE conversation_id = ? AND type = 'user_message' AND json_extract(body,'$.clientMsgId') = ?",
    );

    this.findStopStmt = db.prepare(
      "SELECT seq, body, at FROM events WHERE conversation_id = ? AND type = 'stop_all' AND json_extract(body,'$.clientReqId') = ?",
    );

    this.eventStmt = db.prepare('SELECT seq, body, at FROM events WHERE conversation_id = ? AND seq = ?');

    // What each message read just before a segment cut it, for recovery below.
    const cleared = new Map<string, string>();
    let view = emptyView;
    for (const e of this.eventsAfter(0)) {
      if (e.type === 'message_segment_started') {
        const before = view.messages.find((m) => m.id === e.messageId)?.text ?? '';
        if (before.length * 2 >= (cleared.get(e.messageId)?.length ?? 0)) cleared.set(e.messageId, before);
      }
      if (e.type === 'user_message') {
        this.undecidedAtBoot.push({ messageId: e.messageId, clientMsgId: e.clientMsgId, text: e.text, seq: e.seq, at: e.at });
      } else if (e.type === 'steer_resolved') {
        const i = this.undecidedAtBoot.findIndex((u) => u.messageId === e.userMessageId);
        if (i >= 0) this.undecidedAtBoot.splice(i, 1);
      }
      view = applyEvent(view, e);
    }
    this._view = view;
    this._lastSeq = view.lastSeq;

    // Recovery: close any stream left dangling by a previous process. A rewrite
    // that had barely started must not cost the answer it was replacing.
    for (const m of this._view.messages) {
      if (m.status !== 'streaming') continue;
      const old = cleared.get(m.id) ?? '';
      const restore = old !== '' && (m.text === '' || (old.length >= MIN_RESTORE_CHARS && m.text.length * 2 < old.length));
      this.append({
        type: 'message_aborted',
        messageId: m.id,
        reason: 'server_restart',
        truncateTo: restore ? old.length : m.text.length,
        ...(restore ? { restoreText: old } : {}),
      });
    }
  }

  get lastSeq(): number {
    return this._lastSeq;
  }

  get view(): ConversationView {
    return this._view;
  }

  append(body: EventBody): ConvEvent {
    // No awaits: seq assignment and INSERT are one synchronous step.
    const seq = this._lastSeq + 1;
    const at = Date.now();
    this.insertStmt.run(this.id, seq, body.type, JSON.stringify(body), at);
    // Only reached on successful insert.
    const event = { ...body, seq, conversationId: this.id, at } as ConvEvent;
    this._view = applyEvent(this._view, event);
    this._lastSeq = seq;
    this.pending.push(event);
    if (!this.draining) this.drain();
    return event;
  }

  /**
   * Deliver queued events in seq order. A subscriber that appends re-entrantly only
   * enqueues; the outer drain delivers it after every subscriber has seen the current one.
   */
  private drain(): void {
    this.draining = true;
    try {
      for (let event = this.pending.shift(); event; event = this.pending.shift()) {
        for (const fn of [...this.subscribers]) {
          try {
            fn(event);
          } catch (err) {
            console.error('ConversationActor subscriber threw', err);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }

  eventsAfter(seq: number): ConvEvent[] {
    return (this.afterStmt.all(this.id, seq) as Row[]).map((r) => this.toEvent(r));
  }

  eventsUpTo(seq: number): ConvEvent[] {
    return (this.upToStmt.all(this.id, seq) as Row[]).map((r) => this.toEvent(r));
  }

  /** Marks work in progress outside any stream or turn. Call the result when it ends. */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (!released) this.holds--;
      released = true;
    };
  }

  /** Nothing depends on this object staying in memory: it can be rebuilt from the log. */
  isIdle(): boolean {
    return this.generations.size === 0 && this.turnAbort === null && this.subscribers.size === 0 && this.holds === 0;
  }

  /** One event by seq. */
  eventAt(seq: number): ConvEvent | undefined {
    const row = this.eventStmt.get(this.id, seq) as Row | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  /** The view as of `seq`: no refold when that is the head of the log. */
  viewAt(seq: number): ConversationView {
    return seq === this._lastSeq ? this._view : fold(this.eventsUpTo(seq));
  }

  subscribe(fn: (e: ConvEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  findUserMessage(clientMsgId: string): ConvEvent | undefined {
    const row = this.findUserStmt.get(this.id, clientMsgId) as Row | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  findStopAll(clientReqId: string): ConvEvent | undefined {
    const row = this.findStopStmt.get(this.id, clientReqId) as Row | undefined;
    return row ? this.toEvent(row) : undefined;
  }

  private toEvent(r: Row): ConvEvent {
    return { ...(JSON.parse(r.body) as EventBody), seq: r.seq, conversationId: this.id, at: r.at };
  }
}

/** An old answer shorter than this is not worth bringing back over new words. */
export const MIN_RESTORE_CHARS = 20;

const actors = new WeakMap<Db, Map<string, ConversationActor>>();

/** Conversations kept in memory when idle; any other is rebuilt from the log when next asked for. */
export const MAX_IDLE_ACTORS = 500;

let loader: ((a: ConversationActor) => void) | null = null;
/** Runs once for each actor getActor loads, after its recovery. */
export function setActorLoader(fn: (a: ConversationActor) => void): void {
  loader = fn;
}

export function getActor(db: Db, id: string): ConversationActor {
  let m = actors.get(db);
  if (!m) {
    m = new Map();
    actors.set(db, m);
  }
  let a = m.get(id);
  if (a) {
    // Map order doubles as recency.
    m.delete(id);
    m.set(id, a);
    return a;
  }
  a = new ConversationActor(db, id);
  m.set(id, a);
  evictIdle(m);
  loader?.(a);
  return a;
}

function evictIdle(m: Map<string, ConversationActor>): void {
  for (const [id, a] of m) {
    if (m.size <= MAX_IDLE_ACTORS) return;
    if (a.isIdle()) m.delete(id);
  }
}

/** How many actors are in memory for this database. */
export const actorCount = (db: Db): number => actors.get(db)?.size ?? 0;
