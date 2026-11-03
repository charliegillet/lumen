import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { AgentId, Effort } from '../../shared/events.js';
import type { ConversationActor } from '../actor.js';
import { buildPrompt, type PromptMode } from '../agents/prompt.js';
import { streamChat } from '../llm/stream.js';

export const FLUSH_MS = 75;
/** Continue mode buffers this many leading chars to detect a repeated tail. */
const OVERLAP_WINDOW = 40;
const MIN_OVERLAP = 3;

type Outcome = 'completed' | 'stopped' | 'error';
type SegmentKind = 'reply' | 'continue' | 'replace';

/**
 * State of one stream. Exactly one segment is `current` at a time; every
 * callback (chunk, timer flush, end, error) checks `seg === this.current`
 * before touching the log, so a superseded stream can never append, however
 * late its chunks arrive.
 */
interface Segment {
  readonly segment: number;
  readonly ctrl: AbortController;
  /** Unflushed text, appended as one token_delta per flush. */
  buf: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** Continue mode only: leading text held back until overlap is resolved. */
  head: string | null;
  readonly partial: string;
}

export interface StartArgs {
  agentId: AgentId;
  turnId: string;
  hop: number;
  replyTo: string | null;
  effort: Effort;
  gist: string;
  othersReplying: AgentId[];
}

/** One agent's streaming message, possibly re-steered into several segments. */
export class Generation {
  readonly messageId: string;
  readonly agentId: AgentId;
  readonly hop: number;
  segment = 0;
  effort: Effort;
  /** For the current segment: has a non-empty chunk arrived? */
  firstTokenSeen = false;
  readonly done: Promise<Outcome>;

  private readonly actor: ConversationActor;
  private current: Segment;
  private terminal = false;
  private resolveDone!: (o: Outcome) => void;

  /** Use startGeneration. Appends message_started and starts segment 0. */
  constructor(actor: ConversationActor, a: StartArgs) {
    this.actor = actor;
    this.messageId = randomUUID();
    this.agentId = a.agentId;
    this.hop = a.hop;
    this.effort = a.effort;
    this.done = new Promise((r) => (this.resolveDone = r));

    // The agent's own message_started is deliberately outside its context.
    const cutoff = actor.lastSeq;
    this.current = newSegment(0, '');
    actor.generations.set(this.messageId, this);
    try {
      actor.append({
        type: 'message_started',
        messageId: this.messageId,
        agentId: a.agentId,
        turnId: a.turnId,
        hop: a.hop,
        replyTo: a.replyTo,
        contextCutoffSeq: cutoff,
        effort: a.effort,
      });
    } catch (err) {
      actor.generations.delete(this.messageId);
      throw err;
    }
    this.launch(this.current, 'reply', cutoff, {
      kind: 'reply',
      gist: a.gist,
      effort: a.effort,
      hop: a.hop,
      othersReplying: a.othersReplying,
    });
  }

  /** Committed text, as folded into actor.view. */
  textSoFar(): string {
    return this.actor.view.messages.find((m) => m.id === this.messageId)?.text ?? '';
  }

  /**
   * Supersede the current segment with a new one in the same message.
   * `continue` keeps text[0, truncateTo); `replace` starts empty.
   * Returns false (and does nothing) once the generation is terminal.
   */
  restart(mode: 'continue' | 'replace', truncateTo: number, steers: string[]): boolean {
    if (this.terminal) return false;
    const keep = mode === 'continue' ? Math.max(0, truncateTo) : 0;
    const partial = this.textSoFar().slice(0, keep);
    this.retire(this.current); // unflushed text was never visible: drop it

    this.segment += 1;
    this.firstTokenSeen = false;
    this.current = newSegment(this.segment, mode === 'continue' ? partial : '');
    const cutoff = this.actor.lastSeq;
    this.actor.append({
      type: 'message_segment_started',
      messageId: this.messageId,
      segment: this.segment,
      contextCutoffSeq: cutoff,
      truncateTo: keep,
      mode,
    });
    this.launch(
      this.current,
      mode,
      cutoff,
      mode === 'continue'
        ? { kind: 'continue', partial, steers, effort: this.effort }
        : { kind: 'replace', steers, effort: this.effort },
    );
    return true;
  }

  /** User stop: truncate to what the user saw and end the message. No-op once terminal. */
  stop(truncateTo: number): void {
    if (this.terminal) return;
    this.terminal = true;
    this.retire(this.current);
    this.actor.append({
      type: 'message_aborted',
      messageId: this.messageId,
      reason: 'user_stop',
      truncateTo: Math.max(0, truncateTo),
    });
    this.settle('stopped');
  }

  // -------------------------------------------------------------------------

  private live(seg: Segment): boolean {
    return !this.terminal && seg === this.current;
  }

  private launch(seg: Segment, kind: SegmentKind, cutoff: number, mode: PromptMode): void {
    let prompt: { system: string; messages: ModelMessage[] };
    try {
      prompt = buildPrompt(this.agentId, this.actor.eventsUpTo(cutoff), cutoff, mode);
    } catch (err) {
      // Defer so callers (constructor/restart) return before the terminal append.
      queueMicrotask(() => this.fail(seg, err));
      return;
    }
    void this.run(seg, kind, prompt);
  }

  private async run(
    seg: Segment,
    kind: SegmentKind,
    prompt: { system: string; messages: ModelMessage[] },
  ): Promise<void> {
    try {
      const stream = streamChat({
        role: 'agent',
        agentId: this.agentId,
        system: prompt.system,
        messages: prompt.messages,
        signal: seg.ctrl.signal,
        effort: this.effort,
        meta: { kind, agentId: this.agentId },
      });
      for await (const chunk of stream) {
        if (!this.live(seg)) return; // superseded or stopped: ignore late chunks
        this.receive(seg, chunk);
      }
      if (!this.live(seg)) return;
      this.releaseHead(seg);
      this.flush(seg);
      this.terminal = true;
      this.retire(seg);
      this.actor.append({ type: 'message_completed', messageId: this.messageId });
      this.settle('completed');
    } catch (err) {
      this.fail(seg, err);
    }
  }

  private receive(seg: Segment, chunk: string): void {
    if (chunk === '') return;
    this.firstTokenSeen = true;
    if (seg.head !== null) {
      seg.head += chunk;
      if (seg.head.length >= OVERLAP_WINDOW) this.releaseHead(seg);
      return;
    }
    this.buffer(seg, chunk);
  }

  /** Continue mode: drop the part of the head that repeats the partial's tail. */
  private releaseHead(seg: Segment): void {
    if (seg.head === null) return;
    const head = seg.head;
    seg.head = null;
    const rest = head.slice(overlapLength(seg.partial, head.slice(0, OVERLAP_WINDOW)));
    if (rest !== '') this.buffer(seg, rest);
  }

  private buffer(seg: Segment, text: string): void {
    seg.buf += text;
    seg.timer ??= setTimeout(() => {
      seg.timer = null;
      try {
        this.flush(seg);
      } catch (err) {
        this.fail(seg, err);
      }
    }, FLUSH_MS);
  }

  /** Append buffered text as one token_delta, unless the segment is stale. */
  private flush(seg: Segment): void {
    if (!this.live(seg) || seg.buf === '') return;
    const text = seg.buf;
    seg.buf = '';
    this.actor.append({
      type: 'token_delta',
      messageId: this.messageId,
      segment: seg.segment,
      offset: this.textSoFar().length,
      text,
    });
  }

  /** Errors from a stale segment (including our own aborts) are swallowed. */
  private fail(seg: Segment, err: unknown): void {
    if (!this.live(seg)) return;
    // Keep what already arrived: it is real model output.
    try {
      this.releaseHead(seg);
      this.flush(seg);
    } catch {
      // fall through to the abort below with whatever is committed
    }
    this.terminal = true;
    this.retire(seg);
    console.warn(`generation ${this.messageId} (${this.agentId}) failed:`, err);
    try {
      this.actor.append({
        type: 'message_aborted',
        messageId: this.messageId,
        reason: 'error',
        truncateTo: this.textSoFar().length,
      });
    } finally {
      this.settle('error');
    }
  }

  private retire(seg: Segment): void {
    if (seg.timer) clearTimeout(seg.timer);
    seg.timer = null;
    seg.buf = '';
    seg.head = null;
    seg.ctrl.abort();
  }

  private settle(o: Outcome): void {
    this.actor.generations.delete(this.messageId);
    this.resolveDone(o); // later calls are no-ops on a settled promise
  }
}

function newSegment(segment: number, partial: string): Segment {
  return {
    segment,
    ctrl: new AbortController(),
    buf: '',
    timer: null,
    head: partial === '' ? null : '',
    partial,
  };
}

/** Longest k ≥ MIN_OVERLAP such that `partial` ends with `head.slice(0, k)`; else 0. */
export function overlapLength(partial: string, head: string): number {
  for (let k = Math.min(partial.length, head.length); k >= MIN_OVERLAP; k--) {
    if (partial.endsWith(head.slice(0, k))) return k;
  }
  return 0;
}

export function startGeneration(actor: ConversationActor, a: StartArgs): Generation {
  return new Generation(actor, a);
}
