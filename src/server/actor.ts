import type { AgentId, ConvEvent, EventBody } from '../shared/events.js';
import { applyEvent, fold, type ConversationView } from '../shared/reducer.js';
import type { Db } from './db.js';

/** Minimal shape of a live generation; a later task retypes the map with the full Generation. */
export interface LiveGeneration {
  readonly messageId: string;
  readonly agentId: AgentId;
}

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
  readonly generations = new Map<string, LiveGeneration>();
  turnAbort: AbortController | null = null;

  private readonly db: Db;
  private _lastSeq = 0;
  private _view: ConversationView;
  private readonly subscribers = new Set<(e: ConvEvent) => void>();
  private readonly insertStmt;
  private readonly afterStmt;
  private readonly upToStmt;
  private readonly findUserStmt;

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

    const existing = this.eventsAfter(0);
    this._view = fold(existing);
    this._lastSeq = this._view.lastSeq;

    // Recovery: close any stream left dangling by a previous process.
    for (const m of this._view.messages) {
      if (m.status === 'streaming') {
        this.append({
          type: 'message_aborted',
          messageId: m.id,
          reason: 'server_restart',
          truncateTo: m.text.length,
        });
      }
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
    this._lastSeq = seq;
    this._view = applyEvent(this._view, event);
    for (const fn of [...this.subscribers]) {
      try {
        fn(event);
      } catch (err) {
        console.error('ConversationActor subscriber threw', err);
      }
    }
    return event;
  }

  eventsAfter(seq: number): ConvEvent[] {
    return (this.afterStmt.all(this.id, seq) as Row[]).map((r) => this.toEvent(r));
  }

  eventsUpTo(seq: number): ConvEvent[] {
    return (this.upToStmt.all(this.id, seq) as Row[]).map((r) => this.toEvent(r));
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

  private toEvent(r: Row): ConvEvent {
    return { ...(JSON.parse(r.body) as EventBody), seq: r.seq, conversationId: this.id, at: r.at };
  }
}

const actors = new WeakMap<Db, Map<string, ConversationActor>>();

export function getActor(db: Db, id: string): ConversationActor {
  let m = actors.get(db);
  if (!m) {
    m = new Map();
    actors.set(db, m);
  }
  let a = m.get(id);
  if (!a) {
    a = new ConversationActor(db, id);
    m.set(id, a);
  }
  return a;
}
