import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, ConvEvent } from '../shared/events.js';
import {
  applyEvent,
  emptyView,
  GapError,
  visibleMessages,
  type ConversationView,
  type MessageView,
} from '../shared/reducer.js';
import { parseTargets } from '../shared/targets.js';

// ---------------------------------------------------------------------------
// Pure client state. The React hook below only wires these to the network.

export interface PendingSend {
  clientMsgId: string;
  text: string;
  /** Seq of the server's user_message, once the POST answered. */
  seq: number | null;
  failed: boolean;
}

/** Typewriter progress of one message: `shown` chars are on screen, `pos` is the (fractional) reveal credit. */
export interface Reveal {
  shown: number;
  pos: number;
  /** Set once the message has ended: the steady rate that drains the rest within REVEAL_FINISH_MS. */
  finishCps?: number;
}

export interface ClientState {
  view: ConversationView;
  /** Animate live deltas (false: show them at once, e.g. prefers-reduced-motion). */
  animate: boolean;
  /** messageId -> typewriter progress, only for messages whose live deltas are still being revealed. */
  reveal: Map<string, Reveal>;
  /** messageId -> frozen char count. Text past it is buffered, not shown. */
  frozen: Map<string, number>;
  /** messageId -> words kept on screen while a rewrite has produced nothing yet. */
  held: Map<string, string>;
  pendingSends: PendingSend[];
  /** Own sends (clientMsgId -> client time sent) whose steer_resolved has not arrived. */
  awaiting: Map<string, number>;
  /** Client time of the last agent completion or own steer_resolved; null once stopped. */
  lastWorkAt: number | null;
  /** Seq of the latest stop_all seen. */
  lastStopSeq: number;
}

/** `typing`: the agent has started its message but no words are on screen yet. */
export type ShownMessage = MessageView & { key: string; pending: boolean; failed: boolean; typing: boolean };

/**
 * A freeze is released after this long even if the server never says so.
 * Longer than the server's 6 s classifier cap: unfreezing earlier would show
 * buffered words that the steer then cuts back.
 */
export const SAFETY_UNFREEZE_MS = 7000;
/** Stop stays offered this long after work ends: the next wave may still be gating. */
export const STOP_GRACE_MS = 3000;
/** An own send counts as pending work at most this long (classifier cap plus a gate). */
export const AWAIT_CAP_MS = 15_000;

export function initialState(view: ConversationView = emptyView, opts: { animate?: boolean } = {}): ClientState {
  return {
    view,
    animate: opts.animate ?? false,
    reveal: new Map(),
    frozen: new Map(),
    held: new Map(),
    pendingSends: [],
    awaiting: new Map(),
    lastWorkAt: null,
    lastStopSeq: 0,
  };
}

const failedSend = (s: ClientState, clientMsgId: string) =>
  s.pendingSends.some((p) => p.clientMsgId === clientMsgId && p.failed);

/**
 * Is there anything Stop could act on? Something streaming, an own send the
 * server is still deciding, or work that ended moments ago (the next wave may
 * be gating, before anyone visibly writes). The server is idempotent either way.
 */
export function canStop(s: ClientState, now: number): boolean {
  if (streamingAgents(s).length > 0) return true;
  for (const [id, at] of s.awaiting) if (now - at < AWAIT_CAP_MS && !failedSend(s, id)) return true;
  return s.lastWorkAt !== null && now - s.lastWorkAt < STOP_GRACE_MS;
}

/** Ms until canStop may turn false by time alone, or null when no timer is needed. */
export function stopExpiresIn(s: ClientState, now: number): number | null {
  if (streamingAgents(s).length > 0) return null;
  const ends = [...s.awaiting].filter(([id]) => !failedSend(s, id)).map(([, at]) => at + AWAIT_CAP_MS);
  if (s.lastWorkAt !== null) ends.push(s.lastWorkAt + STOP_GRACE_MS);
  const left = ends.map((t) => t - now).filter((ms) => ms > 0);
  return left.length > 0 ? Math.min(...left) : null;
}

// ---------------------------------------------------------------------------
// Typewriter reveal. Live deltas land in ~75 ms bursts; the display catches up
// at a steady rate instead, never more than about REVEAL_MAX_LAG_MS behind.

/** Reveal speed with little backlog, in chars per second. */
export const REVEAL_BASE_CPS = 75;
/** The rate grows with the backlog so the display lags at most about this much. */
export const REVEAL_MAX_LAG_MS = 300;
/** Once a message has ended, what is left is revealed within about this long. */
export const REVEAL_FINISH_MS = 150;
/** A word longer than this is revealed mid-word rather than waiting for its end. */
const REVEAL_MAX_WORD = 12;

/** Characters of the message's own text on screen (frozen and typewriter limits applied). */
export function shownLength(s: ClientState, m: MessageView): number {
  let n = m.text.length;
  const r = s.reveal.get(m.id);
  if (r !== undefined) n = Math.min(n, r.shown);
  const f = s.frozen.get(m.id);
  if (f !== undefined) n = Math.min(n, f);
  return n;
}

export function displayedText(s: ClientState, m: MessageView): string {
  const n = shownLength(s, m);
  if (n === 0) {
    const held = s.held.get(m.id);
    if (held !== undefined) return held;
  }
  return m.text.slice(0, n);
}

/** Never end a reveal between the two halves of a surrogate pair. */
function safeCut(text: string, n: number): number {
  if (n <= 0 || n >= text.length) return Math.max(0, Math.min(n, text.length));
  const c = text.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n - 1 : n;
}

/**
 * Where to stop when `limit` chars are allowed: the last word boundary after
 * `from`, or mid-word (surrogate-safe) once a word runs longer than
 * REVEAL_MAX_WORD. The end of the text is a boundary only once it is final.
 */
function revealCut(text: string, from: number, limit: number, final: boolean): number {
  if (limit >= text.length && final) return text.length;
  const cap = Math.min(limit, text.length);
  for (let i = cap; i > from; i--) {
    if (/\s/.test(text[i - 1]!)) return i;
  }
  return cap - from >= REVEAL_MAX_WORD ? Math.max(from, safeCut(text, cap)) : from;
}

/** Chars per second for this backlog. For an ended message, the rate that drains it within REVEAL_FINISH_MS. */
export function revealRate(backlog: number, ended: boolean): number {
  const rate = Math.max(REVEAL_BASE_CPS, (backlog * 1000) / REVEAL_MAX_LAG_MS);
  return ended ? Math.max(rate, (backlog * 1000) / REVEAL_FINISH_MS) : rate;
}

/** Advances every typewriter by `dtMs`. Frozen messages do not move; finished reveals are dropped. */
export function advanceReveal(s: ClientState, dtMs: number): ClientState {
  if (s.reveal.size === 0) return s;
  const byId = new Map(s.view.messages.map((m) => [m.id, m]));
  const reveal = new Map<string, Reveal>();
  let changed = false;
  for (const [id, r] of s.reveal) {
    const m = byId.get(id);
    if (!m) {
      changed = true;
      continue;
    }
    const ended = m.status !== 'streaming';
    const total = m.text.length;
    if (r.shown >= total && ended) {
      changed = true; // caught up with a final text: nothing left to animate
      continue;
    }
    if (s.frozen.has(id) || r.shown >= total) {
      reveal.set(id, r);
      continue;
    }
    // Once ended, the rate is fixed from the backlog left at that moment, so the
    // rest drains in about REVEAL_FINISH_MS (a rate tied to a shrinking backlog would trail off).
    const finishCps = ended ? (r.finishCps ?? revealRate(total - r.shown, true)) : undefined;
    const rate = finishCps ?? revealRate(total - r.shown, false);
    const pos = Math.min(total, Math.max(r.pos, r.shown) + (rate * dtMs) / 1000);
    const shown = revealCut(m.text, r.shown, Math.floor(pos), ended);
    if (shown >= total && ended) {
      changed = true;
      continue;
    }
    reveal.set(id, finishCps === undefined ? { shown, pos } : { shown, pos, finishCps });
    changed = true;
  }
  if (!changed) return s;
  // Words reached the screen: held text from before a rewrite is no longer needed.
  let held = s.held;
  for (const [id, r] of reveal) if (r.shown > 0 && held.has(id)) held = without(held, id);
  for (const id of s.held.keys()) if (!reveal.has(id) && s.reveal.has(id)) held = without(held, id);
  return { ...s, reveal, held };
}

/** Is any typewriter still behind (and free to move)? The hook keeps animating while true. */
export function revealPending(s: ClientState): boolean {
  for (const [id, r] of s.reveal) {
    if (s.frozen.has(id)) continue;
    const m = s.view.messages.find((x) => x.id === id);
    if (!m || m.status !== 'streaming') return true; // ends (or is dropped) on the next frame
    // Still streaming: only while a whole word (or an over-long one) is waiting.
    // A half-arrived last word stalls until the next delta, which reschedules.
    if (revealCut(m.text, r.shown, m.text.length, false) > r.shown) return true;
  }
  return false;
}

/** Clamp a typewriter after its message's text was cut back. */
function clampReveal(reveal: Map<string, Reveal>, id: string, len: number): Map<string, Reveal> {
  const r = reveal.get(id);
  if (r === undefined || (r.shown <= len && r.pos <= len)) return reveal;
  return new Map(reveal).set(id, { shown: Math.min(r.shown, len), pos: Math.min(r.pos, len) }); // a new segment re-derives its rate
}

/** Turns the typewriter on or off; off shows everything received at once. */
export function setAnimate(s: ClientState, animate: boolean): ClientState {
  if (s.animate === animate) return s;
  return { ...s, animate, reveal: animate ? s.reveal : new Map() };
}

const streamingAgents = (s: ClientState) =>
  s.view.messages.filter(
    (m): m is MessageView & { author: { kind: 'agent'; agentId: AgentId } } =>
      m.author.kind === 'agent' && m.status === 'streaming',
  );

function freezeWhere(s: ClientState, pick: (agentId: AgentId) => boolean): ClientState {
  const frozen = new Map(s.frozen);
  for (const m of streamingAgents(s)) {
    if (pick(m.author.agentId) && !frozen.has(m.id)) frozen.set(m.id, shownLength(s, m));
  }
  return { ...s, frozen };
}

/** Freeze the streaming messages a send may steer: the named agents, or everyone. */
export function freezeFor(s: ClientState, text: string): ClientState {
  const { targets, broadcast } = parseTargets(text);
  if (broadcast || targets.length === 0) return freezeAll(s);
  return freezeWhere(s, (id) => (targets as AgentId[]).includes(id));
}

export function freezeAll(s: ClientState): ClientState {
  return freezeWhere(s, () => true);
}

export function unfreeze(s: ClientState, ids?: Iterable<string>): ClientState {
  if (s.frozen.size === 0) return s;
  if (ids === undefined) return { ...s, frozen: new Map() };
  const frozen = new Map(s.frozen);
  for (const id of ids) frozen.delete(id);
  return { ...s, frozen };
}

function without<V>(map: Map<string, V>, id: string): Map<string, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

/** Held words stay after a message ends while its typewriter has text to show but has shown none yet. */
function keepHeld(s: ClientState, view: ConversationView, id: string): boolean {
  const r = s.reveal.get(id);
  const m = view.messages.find((x) => x.id === id);
  return r !== undefined && r.shown === 0 && m !== undefined && m.text !== '';
}

/** Applies one server event. Throws GapError when events were missed. Reads the clock for canStop. */
export function onEvent(s: ClientState, e: ConvEvent): ClientState {
  const view = applyEvent(s.view, e);
  if (view === s.view) return s; // replayed event
  const next: ClientState = { ...s, view };

  switch (e.type) {
    case 'user_message':
      if (!s.pendingSends.some((p) => p.clientMsgId === e.clientMsgId)) return next;
      return { ...next, pendingSends: s.pendingSends.filter((p) => p.clientMsgId !== e.clientMsgId) };
    case 'steer_resolved': {
      // Targets stay frozen for their segment event, unless they already ended: nothing more is coming for them.
      const ids = view.messages
        .filter(
          (m) =>
            s.frozen.has(m.id) &&
            (m.status !== 'streaming' || !(m.author.kind === 'agent' && e.targets.includes(m.author.agentId))),
        )
        .map((m) => m.id);
      const u = view.messages.find((m) => m.id === e.userMessageId);
      const own = u?.clientMsgId !== undefined && s.awaiting.has(u.clientMsgId);
      if (!own) return unfreeze(next, ids);
      return unfreeze(
        {
          ...next,
          awaiting: without(s.awaiting, u.clientMsgId!),
          lastWorkAt: u.startSeq > s.lastStopSeq ? Date.now() : s.lastWorkAt,
        },
        ids,
      );
    }
    case 'message_segment_started': {
      let held = without(s.held, e.messageId);
      const before = s.view.messages.find((m) => m.id === e.messageId);
      if (e.mode === 'replace' && before) {
        const words = displayedText(s, before);
        if (words !== '') {
          held = new Map(held);
          held.set(e.messageId, words);
        }
      }
      const len = view.messages.find((m) => m.id === e.messageId)?.text.length ?? 0;
      return { ...next, held, frozen: without(s.frozen, e.messageId), reveal: clampReveal(s.reveal, e.messageId, len) };
    }
    case 'token_delta': {
      const before = s.view.messages.find((x) => x.id === e.messageId);
      const m = view.messages.find((x) => x.id === e.messageId);
      if (!before || !m || m.text === before.text) return next;
      if (s.animate && m.status === 'streaming') {
        // Text that begins with the held words (a failed rewrite putting the
        // answer back, or a rewrite that opens the same way) continues from
        // them: those words are on screen already and must not be retyped.
        const held = s.held.get(e.messageId);
        if (held !== undefined && m.text.startsWith(held)) {
          return {
            ...next,
            held: without(s.held, e.messageId),
            reveal: new Map(s.reveal).set(e.messageId, { shown: held.length, pos: held.length }),
          };
        }
        // Live words: start (or keep) the typewriter from what was on screen.
        if (s.reveal.has(e.messageId)) return next;
        const from = before.text.length;
        return { ...next, reveal: new Map(s.reveal).set(e.messageId, { shown: from, pos: from }) };
      }
      if (s.held.has(e.messageId) && shownLength(next, m) > 0) return { ...next, held: without(s.held, e.messageId) };
      return next;
    }
    case 'message_completed': {
      // The typewriter (if any) finishes on its own, quickly; held words stay until it shows something.
      // A freeze set by a send still being decided survives completion: the rest of
      // the old answer must not appear, and the steer's segment or resolution releases it.
      const holdFreeze = s.frozen.has(e.messageId) && [...s.awaiting.keys()].some((id) => !failedSend(s, id));
      return {
        ...next,
        frozen: holdFreeze ? s.frozen : without(s.frozen, e.messageId),
        held: keepHeld(s, view, e.messageId) ? s.held : without(s.held, e.messageId),
        lastWorkAt: Date.now(),
      };
    }
    case 'message_aborted': {
      const reveal = clampReveal(s.reveal, e.messageId, e.truncateTo);
      return {
        ...next,
        frozen: without(s.frozen, e.messageId),
        held: keepHeld({ ...s, reveal }, view, e.messageId) ? s.held : without(s.held, e.messageId),
        reveal,
      };
    }
    case 'stop_all':
      // The aborts that follow carry the final text; hold everything until they land.
      // Sends before it are stopped too, so they no longer count as pending work.
      return freezeAll({
        ...next,
        frozen: new Map([...s.frozen].filter(([id]) => view.messages.find((m) => m.id === id)?.status === 'streaming')),
        awaiting: new Map(),
        lastWorkAt: null,
        lastStopSeq: e.seq,
      });
    default:
      return next;
  }
}

/** Characters the person can see, per streaming message. Sent with every send and stop. */
export function renderedCounts(s: ClientState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.view.messages) {
    if (m.status === 'streaming') out[m.id] = shownLength(s, m);
  }
  return out;
}

export function addPending(s: ClientState, clientMsgId: string, text: string): ClientState {
  return {
    ...s,
    pendingSends: [...s.pendingSends, { clientMsgId, text, seq: null, failed: false }],
    awaiting: new Map(s.awaiting).set(clientMsgId, Date.now()),
  };
}

/** The POST answered with the user_message's seq. */
export function ackPending(s: ClientState, clientMsgId: string, seq: number): ClientState {
  if (seq <= s.view.lastSeq) {
    // Already applied (e.g. via a snapshot that cannot carry clientMsgId).
    return { ...s, pendingSends: s.pendingSends.filter((p) => p.clientMsgId !== clientMsgId) };
  }
  return {
    ...s,
    pendingSends: s.pendingSends.map((p) => (p.clientMsgId === clientMsgId ? { ...p, seq, failed: false } : p)),
  };
}

/** Marks a send failed, or (failed=false) as being retried now. */
export function failPending(s: ClientState, clientMsgId: string, failed: boolean): ClientState {
  return {
    ...s,
    awaiting: failed ? s.awaiting : new Map(s.awaiting).set(clientMsgId, Date.now()),
    pendingSends: s.pendingSends.map((p) => (p.clientMsgId === clientMsgId ? { ...p, failed } : p)),
  };
}

/**
 * Replace the view wholesale (initial load, or recovery after a gap).
 * Freezes survive on messages that are still streaming; unconfirmed sends
 * the snapshot already contains are dropped.
 */
export function withSnapshot(s: ClientState, view: ConversationView): ClientState {
  const byId = new Map(view.messages.map((m) => [m.id, m]));
  const frozen = new Map([...s.frozen].filter(([id]) => byId.get(id)?.status === 'streaming'));
  const held = new Map([...s.held].filter(([id]) => byId.get(id)?.text === ''));
  const sent = new Set(view.messages.flatMap((m) => (m.clientMsgId ? [m.clientMsgId] : [])));
  return {
    ...s,
    view,
    frozen,
    held,
    reveal: new Map(), // snapshot text appears at once
    pendingSends: s.pendingSends.filter(
      (p) => !sent.has(p.clientMsgId) && (p.seq === null || p.seq > view.lastSeq),
    ),
  };
}

/** What the conversation shows: confirmed messages in order, then unconfirmed sends. */
export function shownMessages(s: ClientState): ShownMessage[] {
  const out: ShownMessage[] = [];
  for (const m of visibleMessages(s.view)) {
    // An agent that started writing but shows no words yet gets typing dots;
    // one that ended with nothing to show has no bubble at all.
    const typing = m.author.kind === 'agent' && displayedText(s, m) === '';
    if (typing && m.status !== 'streaming' && m.text === '') continue;
    // Keyed by clientMsgId so a confirmed send does not remount its bubble.
    out.push({ ...m, key: m.clientMsgId ?? m.id, pending: false, failed: false, typing });
  }
  for (const p of s.pendingSends) {
    out.push({
      id: p.clientMsgId,
      key: p.clientMsgId,
      author: { kind: 'user' },
      text: p.text,
      status: 'done',
      startSeq: Number.POSITIVE_INFINITY,
      anchorSeq: Number.POSITIVE_INFINITY,
      segment: 0,
      completedAt: null,
      hop: 0,
      pending: true,
      failed: p.failed,
      typing: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// React hook

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** A POST that has not answered by now counts as failed. */
const POST_TIMEOUT_MS = 20_000;

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

export interface Conversation {
  messages: ShownMessage[];
  displayed: (m: MessageView) => string;
  send(text: string, typingStartedAt: number | null): void;
  retry(clientMsgId: string): void;
  stop(): void;
  anyStreaming: boolean;
  /** Stop has something to act on (see canStop). */
  canStop: boolean;
  loaded: boolean;
}

export function useConversation(id: string): Conversation {
  const base = `/api/conv/${encodeURIComponent(id)}`;
  // `latest` gets every event immediately; React sees it once per animation
  // frame, and each frame also moves the typewriter along.
  const latest = useRef<ClientState>(initialState(emptyView, { animate: !prefersReducedMotion() }));
  const [state, setState] = useState<ClientState>(latest.current);
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<number | null>(null);
  const lastFrameAt = useRef<number | null>(null);
  const sendInfo = useRef(
    new Map<string, { text: string; typingStartedAt: number | null; rendered: Record<string, number>; froze: string[] }>(),
  );
  // Sends go out one at a time, in the order typed; the bubble and freeze are instant.
  const postChain = useRef<Promise<void>>(Promise.resolve());

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    const tick = (t: number) => {
      frame.current = null;
      // A long gap (hidden tab, first frame after idle) counts as one short frame;
      // the backlog-scaled rate catches up from there.
      const dt = lastFrameAt.current === null ? 16 : Math.min(Math.max(0, t - lastFrameAt.current), 100);
      latest.current = advanceReveal(latest.current, dt);
      setState(latest.current);
      if (revealPending(latest.current)) {
        lastFrameAt.current = t;
        frame.current = requestAnimationFrame(tick);
      } else lastFrameAt.current = null;
    };
    frame.current = requestAnimationFrame(tick);
  }, []);

  const flushNow = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setState(latest.current);
    if (revealPending(latest.current)) schedule();
  }, [schedule]);

  // prefers-reduced-motion: words appear as they arrive.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {
      latest.current = setAnimate(latest.current, !mq.matches);
      setState(latest.current);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Every freeze, whoever caused it (a send, Stop, a stop_all from elsewhere,
  // a snapshot that kept it), is released after SAFETY_UNFREEZE_MS at the latest.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const arm = useCallback((ids: Iterable<string>) => {
    for (const id of ids) {
      const prev = timers.current.get(id);
      if (prev !== undefined) clearTimeout(prev);
      const t = setTimeout(() => {
        timers.current.delete(id);
        latest.current = unfreeze(latest.current, [id]);
        setState(latest.current);
        if (revealPending(latest.current)) schedule();
      }, SAFETY_UNFREEZE_MS);
      timers.current.set(id, t);
    }
  }, [schedule]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  /** Applies f; `now` renders synchronously; `rearm` restarts every freeze's timer. */
  const update = useCallback(
    (f: (s: ClientState) => ClientState, now = false, rearm = false) => {
      const before = latest.current;
      const after = f(before);
      latest.current = after;
      const ids = [...after.frozen.keys()].filter((k) => rearm || !before.frozen.has(k));
      if (ids.length > 0) arm(ids);
      if (now) flushNow();
      else schedule();
      return after;
    },
    [arm, flushNow, schedule],
  );

  // Snapshot, then the live stream from its seq. A gap means we missed
  // something: start over from a fresh snapshot.
  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 500;

    const restart = (delay: number) => {
      es?.close();
      es = null;
      if (disposed || retryTimer !== null) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void connect();
      }, delay);
    };

    const connect = async (): Promise<void> => {
      try {
        const res = await fetch(`${base}/snapshot`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`snapshot: ${res.status}`);
        const { view } = (await res.json()) as { view: ConversationView };
        if (disposed) return;
        update((s) => withSnapshot(s, view), true, true);
        setLoaded(true);
      } catch {
        restart(backoff);
        backoff = Math.min(backoff * 2, 8000);
        return;
      }
      if (disposed) return;
      const source = new EventSource(`${base}/events?after=${latest.current.view.lastSeq}`);
      es = source;
      source.onopen = () => {
        backoff = 500;
      };
      source.onmessage = (msg: MessageEvent<string>) => {
        if (es !== source) return;
        let e: ConvEvent;
        try {
          e = JSON.parse(msg.data) as ConvEvent;
        } catch {
          return;
        }
        try {
          update((s) => onEvent(s, e));
        } catch (err) {
          if (err instanceof GapError) restart(0);
          else throw err;
        }
      };
      source.onerror = () => {
        // The browser retries on its own (with Last-Event-ID) unless it gave up.
        if (source.readyState === EventSource.CLOSED && es === source) {
          restart(backoff);
          backoff = Math.min(backoff * 2, 8000);
        }
      };
    };

    void connect();
    return () => {
      disposed = true;
      es?.close();
      if (retryTimer !== null) clearTimeout(retryTimer);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      lastFrameAt.current = null;
    };
  }, [base, update]);

  const post = useCallback(
    (clientMsgId: string) => {
      const info = sendInfo.current.get(clientMsgId);
      if (!info) return;
      postChain.current = postChain.current.then(async () => {
        try {
          // sentAt lets the server map typingStartedAt onto its own clock.
          const { froze: _froze, ...body } = info;
          const r = await postJson(`${base}/messages`, { clientMsgId, ...body, sentAt: Date.now() });
          const seq = (r as { seq?: unknown }).seq;
          if (typeof seq === 'number') update((s) => ackPending(s, clientMsgId, seq));
        } catch {
          // Nothing will resolve this send, so what it froze is released too.
          update((s) => unfreeze(failPending(s, clientMsgId, true), info.froze), true);
        }
      });
    },
    [base, update],
  );

  const send = useCallback(
    (raw: string, typingStartedAt: number | null) => {
      const text = raw.trim();
      if (text === '') return;
      const clientMsgId = uuid();
      // Rendered now, so what is frozen is exactly what is on screen.
      const before = latest.current;
      const after = update((s) => freezeFor(addPending(s, clientMsgId, text), text), true);
      const froze = [...after.frozen.keys()].filter((k) => !before.frozen.has(k));
      sendInfo.current.set(clientMsgId, { text, typingStartedAt, rendered: renderedCounts(after), froze });
      post(clientMsgId);
    },
    [post, update],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      const info = sendInfo.current.get(clientMsgId);
      if (!info) return;
      // What is on screen now, not what was when it first failed.
      const before = latest.current;
      const after = update((s) => freezeFor(failPending(s, clientMsgId, false), info.text), true);
      sendInfo.current.set(clientMsgId, {
        text: info.text,
        typingStartedAt: null,
        rendered: renderedCounts(after),
        froze: [...after.frozen.keys()].filter((k) => !before.frozen.has(k)),
      });
      post(clientMsgId);
    },
    [post, update],
  );

  // Always posts: the server knows about work the client cannot see yet
  // (a send still being classified, a gate in flight) and is idempotent.
  const stop = useCallback(() => {
    const before = latest.current;
    const after = update(freezeAll, true);
    postJson(`${base}/stop`, { clientReqId: uuid(), rendered: renderedCounts(after) }).catch(() => {
      update((s) => unfreeze(s, [...after.frozen.keys()].filter((k) => !before.frozen.has(k))));
    });
  }, [base, update]);

  const messages = useMemo(() => shownMessages(state), [state]);
  const displayed = useCallback((m: MessageView) => displayedText(state, m), [state]);
  const anyStreaming = useMemo(() => state.view.messages.some((m) => m.status === 'streaming'), [state]);
  // canStop also turns false by time alone: re-render when its window ends.
  const [tick, setTick] = useState(0);
  const stopNow = useMemo(() => canStop(state, Date.now()), [state, tick]);
  useEffect(() => {
    const ms = stopExpiresIn(state, Date.now());
    if (ms === null) return;
    const t = setTimeout(() => setTick((x) => x + 1), ms + 20);
    return () => clearTimeout(t);
  }, [state, tick]);

  return { messages, displayed, send, retry, stop, anyStreaming, canStop: stopNow, loaded };
}
