import { randomUUID } from 'node:crypto';
import type { ModelMessage } from 'ai';
import type { AgentId, Effort, EventBody } from '../../shared/events.js';
import type { ConversationView } from '../../shared/reducer.js';
import { MIN_RESTORE_CHARS, type ConversationActor } from '../actor.js';
import { buildPromptFromView, type PromptMode } from '../agents/prompt.js';
import { modelSpec } from '../llm/registry.js';
import { streamChat } from '../llm/stream.js';

export const FLUSH_MS = 75;
/** Continue mode buffers this many leading chars to detect a repeated tail. */
const OVERLAP_WINDOW = 40;
const MIN_OVERLAP = 3;
/** A continuation sharing this many leading chars with one of the partial's sentences is restating it. */
const RESTATE_CHARS = 24;
/** Said in the agent's voice when a steer could not be applied, so the old answer is not mistaken for the new one. */
const COULD_NOT_APPLY = "\n\n(Sorry, I couldn't redo this just now. Could you ask me again?)";

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
  /** Set by launch; used for the time-to-first-visible-token log line. */
  kind: SegmentKind;
  startedAt: number;
  /** Has a token_delta from this segment been appended? */
  visible: boolean;
  /** The text this segment cut, put back if it ends with nothing to show for it. */
  readonly restore: string;
  /** A user steer caused it. */
  readonly moved: boolean;
  /** A failed start gets one more try. */
  retried: boolean;
}

interface ReopenArgs {
  messageId: string;
  agentId: AgentId;
  hop: number;
  effort: Effort;
  segment: number;
  steers: string[];
  moved: boolean;
  /** Pick the message up where it stops instead of rewriting it. */
  resume?: boolean;
}

/**
 * `moved`: a user steer caused this segment, so the message moves below that
 * steer in the chat. A segment the system starts on its own (the compliance
 * redo) leaves the message where it is.
 */
export interface SegmentOptions {
  moved: boolean;
}

export interface StartArgs {
  agentId: AgentId;
  turnId: string;
  hop: number;
  replyTo: string | null;
  effort: Effort;
  gist: string;
  othersReplying: AgentId[];
  /** Seq of the user message this answers; lets a stop know which asks it called off. */
  triggerSeq?: number;
}

/** One agent's streaming message, possibly re-steered into several segments. */
export class Generation {
  readonly messageId: string;
  readonly agentId: AgentId;
  readonly hop: number;
  readonly triggerSeq: number | undefined;
  segment = 0;
  effort: Effort;
  /** For the current segment: has a non-empty chunk arrived? */
  firstTokenSeen = false;
  /** When the current stream last produced anything. */
  lastActivityAt = Date.now();
  readonly done: Promise<Outcome>;

  private readonly actor: ConversationActor;
  private current: Segment;
  private terminal = false;
  private resolveDone!: (o: Outcome) => void;

  /**
   * Use startGeneration or reopenGeneration. A start appends message_started
   * and runs segment 0; a reopen appends message_segment_started (replace) on
   * an existing, finished message and streams into the same messageId.
   */
  constructor(actor: ConversationActor, init: { start: StartArgs } | { reopen: ReopenArgs }) {
    this.actor = actor;
    this.done = new Promise((r) => (this.resolveDone = r));
    // The agent's own start event is deliberately outside its context.
    const cutoff = actor.lastSeq;
    const view = actor.view;

    if ('start' in init) {
      const a = init.start;
      this.messageId = randomUUID();
      this.agentId = a.agentId;
      this.hop = a.hop;
      this.effort = a.effort;
      this.triggerSeq = a.triggerSeq;
      this.current = newSegment(0, '', '', false);
      this.begin({
        type: 'message_started',
        messageId: this.messageId,
        agentId: a.agentId,
        turnId: a.turnId,
        hop: a.hop,
        replyTo: a.replyTo,
        contextCutoffSeq: cutoff,
        effort: a.effort,
      });
      this.launch(this.current, 'reply', view, {
        kind: 'reply',
        gist: a.gist,
        effort: a.effort,
        hop: a.hop,
        othersReplying: a.othersReplying,
      });
      return;
    }

    const r = init.reopen;
    this.messageId = r.messageId;
    this.agentId = r.agentId;
    this.hop = r.hop;
    this.effort = r.effort;
    this.triggerSeq = undefined;
    this.segment = r.segment;
    const previous = actor.view.messages.find((m) => m.id === r.messageId)?.text ?? '';
    const partial = r.resume ? previous : '';
    this.current = newSegment(r.segment, partial, previous, r.moved);
    this.begin({
      type: 'message_segment_started',
      messageId: r.messageId,
      segment: r.segment,
      contextCutoffSeq: cutoff,
      truncateTo: partial.length,
      mode: r.resume ? 'continue' : 'replace',
      ...movedField(r.moved),
    });
    if (r.resume) {
      this.launch(this.current, 'continue', view, { kind: 'continue', partial, steers: r.steers, effort: r.effort });
    } else {
      this.launch(this.current, 'replace', view, { kind: 'replace', steers: r.steers, effort: r.effort });
    }
  }

  /** Registers as live and appends the opening event; a failed append ends the generation. */
  private begin(body: EventBody): void {
    this.actor.generations.set(this.messageId, this);
    try {
      this.actor.append(body);
    } catch (err) {
      this.terminal = true;
      this.settle('error');
      throw err;
    }
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
  restart(
    mode: 'continue' | 'replace',
    truncateTo: number,
    steers: string[],
    opts: SegmentOptions = { moved: false },
  ): boolean {
    if (this.terminal) return false;
    const committed = this.textSoFar();
    const keep = mode === 'continue' ? clamp(truncateTo, committed.length) : 0;
    const partial = committed.slice(0, keep);
    // Keeps what it cuts, or what an earlier rewrite that barely wrote had cut.
    const restore = committed.length * 2 >= this.current.restore.length ? committed : this.current.restore;
    this.retire(this.current); // unflushed text was never visible: drop it

    this.segment += 1;
    this.firstTokenSeen = false;
    this.current = newSegment(this.segment, partial, restore, opts.moved);
    const cutoff = this.actor.lastSeq;
    const view = this.actor.view;
    try {
      this.actor.append({
        type: 'message_segment_started',
        messageId: this.messageId,
        segment: this.segment,
        contextCutoffSeq: cutoff,
        truncateTo: keep,
        mode,
        ...movedField(opts.moved),
      });
    } catch (err) {
      this.terminal = true;
      this.retire(this.current);
      this.settle('error');
      throw err;
    }
    this.launch(
      this.current,
      mode,
      view,
      mode === 'continue'
        ? { kind: 'continue', partial, steers, effort: this.effort }
        : { kind: 'replace', steers, effort: this.effort },
    );
    return true;
  }

  /** User stop: truncate to what the user saw and end the message. No-op once terminal. */
  stop(truncateTo: number): void {
    if (this.terminal) return;
    const keep = clamp(truncateTo, this.textSoFar().length);
    // Stopping a rewrite before any of it was seen keeps the answer it was replacing.
    const back = keep === 0 && this.current.restore !== '' ? this.current.restore : undefined;
    this.terminal = true;
    this.retire(this.current);
    try {
      this.actor.append({
        type: 'message_aborted',
        messageId: this.messageId,
        reason: 'user_stop',
        truncateTo: back?.length ?? keep,
        ...(back !== undefined ? { restoreText: back } : {}),
      });
    } finally {
      this.settle('stopped'); // a failed append still ends the generation (and rethrows)
    }
  }

  isLive(): boolean {
    return !this.terminal;
  }

  /** Give up on a stream that has gone quiet; ends like any failed stream. */
  abandon(why: string): void {
    this.fail(this.current, new Error(why));
  }

  // -------------------------------------------------------------------------

  private live(seg: Segment): boolean {
    return !this.terminal && seg === this.current;
  }

  private launch(seg: Segment, kind: SegmentKind, view: ConversationView, mode: PromptMode): void {
    seg.kind = kind;
    seg.startedAt = performance.now();
    this.lastActivityAt = Date.now();
    let prompt: { system: string; messages: ModelMessage[] };
    try {
      prompt = buildPromptFromView(this.agentId, view, mode);
    } catch (err) {
      // Defer so callers (constructor/restart) return before the terminal append.
      queueMicrotask(() => this.fail(seg, err));
      return;
    }
    this.run(seg, kind, prompt).catch((err: unknown) => {
      // run() handles its own errors; this is a last line of defence.
      console.warn(`generation ${this.messageId}: unexpected error`, err);
    });
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
        fast: seg.moved, // the person just steered and is waiting for words
        meta: { kind, agentId: this.agentId },
      });
      for await (const chunk of stream) {
        if (!this.live(seg)) return; // superseded or stopped: ignore late chunks
        this.receive(seg, chunk);
      }
      if (!this.live(seg)) return;
      this.releaseHead(seg);
      this.flush(seg);
      if (kind !== 'reply' && !seg.visible) throw new Error('the model wrote nothing');
    } catch (err) {
      if (kind !== 'reply' && !seg.retried && this.live(seg) && !seg.visible && seg.buf === '') {
        seg.retried = true;
        seg.head = seg.partial === '' ? null : '';
        return this.run(seg, kind, prompt);
      }
      this.fail(seg, err);
      return;
    }
    this.terminal = true;
    this.retire(seg);
    try {
      this.actor.append({ type: 'message_completed', messageId: this.messageId });
      this.settle('completed');
    } catch (err) {
      console.warn(`generation ${this.messageId}: could not append message_completed`, err);
      this.settle('error');
    }
  }

  private receive(seg: Segment, chunk: string): void {
    if (chunk === '') return;
    this.firstTokenSeen = true;
    this.lastActivityAt = Date.now();
    if (seg.head !== null) {
      seg.head += chunk;
      const r = restatement(seg.partial, seg.head);
      if (!r.hold && !mustHold(seg.partial, seg.head.slice(r.drop))) this.releaseHead(seg);
      return;
    }
    this.buffer(seg, chunk);
  }

  /** Continue mode: drop whatever only repeats the partial, at its start or at the seam. */
  private releaseHead(seg: Segment): void {
    if (seg.head === null) return;
    const head = seg.head.slice(restatement(seg.partial, seg.head).drop);
    seg.head = null;
    const rest = stripContinuation(seg.partial, head);
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
    if (!seg.visible) {
      seg.visible = true;
      this.logTtft(seg);
    }
  }

  /** One line per segment; silent under tests. */
  private logTtft(seg: Segment): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) return;
    const ms = Math.round(performance.now() - seg.startedAt);
    console.info(
      `ttft agent=${this.agentId} model=${modelSpec('agent', this.agentId)} segment=${seg.segment} kind=${seg.kind} ms=${ms}`,
    );
  }

  /** Errors from a stale segment (including our own aborts) are swallowed. */
  private fail(seg: Segment, err: unknown): void {
    if (!this.live(seg)) return;
    // Keep what already arrived: it is real model output.
    let restoreText: string | undefined;
    try {
      this.releaseHead(seg);
      this.flush(seg);
      // A rewrite that ended with next to nothing must not erase the answer it
      // was replacing: put the old text back in this segment.
      const now = this.textSoFar();
      if (shouldRestore(seg, now)) {
        const back = seg.moved ? seg.restore + COULD_NOT_APPLY : seg.restore;
        if (back.startsWith(now)) {
          this.actor.append({
            type: 'token_delta',
            messageId: this.messageId,
            segment: seg.segment,
            offset: now.length,
            text: back.slice(now.length),
          });
        } else {
          restoreText = back;
        }
      }
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
        truncateTo: restoreText?.length ?? this.textSoFar().length,
        ...(restoreText !== undefined ? { restoreText } : {}),
      });
    } catch (err2) {
      console.warn(`generation ${this.messageId}: could not append message_aborted`, err2);
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

function newSegment(segment: number, partial: string, restore: string, moved: boolean): Segment {
  return {
    restore,
    moved,
    retried: false,
    segment,
    ctrl: new AbortController(),
    buf: '',
    timer: null,
    head: partial === '' ? null : '',
    partial,
    kind: 'reply',
    startedAt: performance.now(),
    visible: false,
  };
}

/** The event carries `moved` only when set, so unmoved segments look as they always did. */
const movedField = (moved: boolean) => (moved ? { moved: true as const } : {});

const clamp = (n: number, max: number) => Math.min(Math.max(0, n), max);

/** Did this segment leave so little that the text it cut is the better answer? */
function shouldRestore(seg: Segment, now: string): boolean {
  if (seg.restore === '') return false;
  return !seg.visible || (seg.restore.length >= MIN_RESTORE_CHARS && now.length * 2 < seg.restore.length);
}

const WS_END = /\s$/;
const WS_START = /^\s+/;

/**
 * Keep holding the continuation's head while a longer overlap with the
 * partial's tail is still possible: some suffix of the partial (longer than
 * head, at most OVERLAP_WINDOW) starts with head. Also hold pure whitespace
 * after a partial ending in whitespace, so it can be collapsed.
 */
export function mustHold(partial: string, head: string): boolean {
  if (WS_END.test(partial) && head.trim() === '') return true;
  const max = Math.min(partial.length, OVERLAP_WINDOW);
  for (let len = head.length + 1; len <= max; len++) {
    if (partial.endsWith(head, partial.length - len + head.length)) return true;
  }
  return false;
}

/**
 * Longest k such that `partial` ends with `head.slice(0, k)` and the overlap is
 * worth stripping: k ≥ MIN_OVERLAP and it spans a word boundary (whitespace
 * inside its trimmed form) or is ≥ 8 chars. This keeps a real doubled word
 * ("said that " + "that is") intact. Returns 0 when nothing qualifies.
 */
export function overlapLength(partial: string, head: string): number {
  for (let k = Math.min(partial.length, head.length, OVERLAP_WINDOW); k >= MIN_OVERLAP; k--) {
    const o = head.slice(0, k);
    if (partial.endsWith(o)) return /\s/.test(o.trim()) || k >= 8 ? k : 0;
  }
  return 0;
}

/** Strip a repeated overlap, then repair the whitespace at the seam. */
export function stripContinuation(partial: string, head: string): string {
  const rest = head.slice(overlapLength(partial, head));
  if (WS_END.test(partial)) return rest.replace(WS_START, '');
  // "...ship." + "Next": two sentences, not one word.
  return /[.!?:;,]$/.test(partial) && /^[\p{L}\p{N}]/u.test(rest) ? ` ${rest}` : rest;
}

const normalized = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trimStart();

/**
 * Where a continuation starts over instead of continuing: how much of its head
 * only restates sentences of the partial (`drop`), and whether it could still
 * turn out to (`hold`). Whole sentences are dropped, once they end.
 */
export function restatement(partial: string, head: string): { hold: boolean; drop: number } {
  const starts = partial.split(/(?<=[.!?\n])\s+/).map(normalized);
  let at = 0;
  for (;;) {
    const rest = head.slice(at);
    const n = normalized(rest);
    if (n === '') return { hold: at > 0, drop: at };
    const probe = n.slice(0, RESTATE_CHARS);
    if (!starts.some((s) => s.startsWith(probe))) return { hold: false, drop: at };
    if (n.length < RESTATE_CHARS) return { hold: true, drop: at };
    const end = /[.!?\n](?:\s+|$)/.exec(rest);
    if (!end) return { hold: true, drop: at };
    at += end.index + end[0].length;
  }
}

/** Index just past the partial's last finished sentence, or 0 when it has none. */
export function lastSentenceEnd(partial: string): number {
  let end = 0;
  for (const m of partial.matchAll(/[.!?\n]+(?:\s+|$)/g)) end = m.index + m[0].length;
  return end;
}

export function startGeneration(actor: ConversationActor, a: StartArgs): Generation {
  return new Generation(actor, { start: a });
}

/**
 * Rewrite a finished (done or stopped) agent message in place: a new `replace`
 * segment streams into the same messageId with the steers as the final ask.
 * Throws if the message is unknown, not an agent's, or still live.
 */
export function reopenGeneration(
  actor: ConversationActor,
  messageId: string,
  steers: string[],
  opts: SegmentOptions & { resume?: boolean } = { moved: false },
): Generation {
  const m = actor.view.messages.find((x) => x.id === messageId);
  if (!m || m.author.kind !== 'agent') throw new Error(`reopen: no agent message ${messageId}`);
  if (m.status === 'streaming' || actor.generations.has(messageId)) {
    throw new Error(`reopen: message ${messageId} is still live`);
  }
  const startEv = actor.eventAt(m.startSeq);
  const effort: Effort = startEv?.type === 'message_started' ? startEv.effort : 'low';
  return new Generation(actor, {
    reopen: {
      messageId,
      agentId: m.author.agentId,
      hop: m.hop,
      effort,
      segment: m.segment + 1,
      steers,
      moved: opts.moved,
      resume: opts.resume,
    },
  });
}
