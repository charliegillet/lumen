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

export interface ClientState {
  view: ConversationView;
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

export type ShownMessage = MessageView & { key: string; pending: boolean; failed: boolean };

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

export function initialState(view: ConversationView = emptyView): ClientState {
  return {
    view,
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

export function displayedText(s: ClientState, m: MessageView): string {
  if (m.text === '') {
    const held = s.held.get(m.id);
    if (held !== undefined) return held;
  }
  const n = s.frozen.get(m.id);
  return n === undefined ? m.text : m.text.slice(0, n);
}

const streamingAgents = (s: ClientState) =>
  s.view.messages.filter(
    (m): m is MessageView & { author: { kind: 'agent'; agentId: AgentId } } =>
      m.author.kind === 'agent' && m.status === 'streaming',
  );

function freezeWhere(s: ClientState, pick: (agentId: AgentId) => boolean): ClientState {
  const frozen = new Map(s.frozen);
  for (const m of streamingAgents(s)) {
    if (pick(m.author.agentId) && !frozen.has(m.id)) frozen.set(m.id, displayedText(s, m).length);
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
      const ids = view.messages
        .filter((m) => s.frozen.has(m.id) && !(m.author.kind === 'agent' && e.targets.includes(m.author.agentId)))
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
      return { ...next, held, frozen: without(s.frozen, e.messageId) };
    }
    case 'token_delta': {
      const m = view.messages.find((x) => x.id === e.messageId);
      if (m && m.text !== '' && s.held.has(e.messageId)) return { ...next, held: without(s.held, e.messageId) };
      return next;
    }
    case 'message_completed':
      return { ...next, frozen: without(s.frozen, e.messageId), held: without(s.held, e.messageId), lastWorkAt: Date.now() };
    case 'message_aborted':
      return { ...next, frozen: without(s.frozen, e.messageId), held: without(s.held, e.messageId) };
    case 'stop_all':
      // The aborts that follow carry the final text; hold everything until they land.
      // Sends before it are stopped too, so they no longer count as pending work.
      return freezeAll({ ...next, awaiting: new Map(), lastWorkAt: null, lastStopSeq: e.seq });
    default:
      return next;
  }
}

/** Characters the person can see, per streaming message. Sent with every send and stop. */
export function renderedCounts(s: ClientState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of s.view.messages) {
    if (m.status === 'streaming') out[m.id] = displayedText(s, m).length;
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
    pendingSends: s.pendingSends.filter(
      (p) => !sent.has(p.clientMsgId) && (p.seq === null || p.seq > view.lastSeq),
    ),
  };
}

/** What the conversation shows: confirmed messages in order, then unconfirmed sends. */
export function shownMessages(s: ClientState): ShownMessage[] {
  const out: ShownMessage[] = [];
  for (const m of visibleMessages(s.view)) {
    if (m.author.kind === 'agent' && displayedText(s, m) === '') continue; // no words yet
    // Keyed by clientMsgId so a confirmed send does not remount its bubble.
    out.push({ ...m, key: m.clientMsgId ?? m.id, pending: false, failed: false });
  }
  for (const p of s.pendingSends) {
    out.push({
      id: p.clientMsgId,
      key: p.clientMsgId,
      author: { kind: 'user' },
      text: p.text,
      status: 'done',
      startSeq: Number.POSITIVE_INFINITY,
      segment: 0,
      completedAt: null,
      hop: 0,
      pending: true,
      failed: p.failed,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// React hook

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  // `latest` gets every event immediately; React sees it once per animation frame.
  const latest = useRef<ClientState>(initialState());
  const [state, setState] = useState<ClientState>(latest.current);
  const [loaded, setLoaded] = useState(false);
  const frame = useRef<number | null>(null);
  const sendInfo = useRef(new Map<string, { text: string; typingStartedAt: number | null; rendered: Record<string, number> }>());

  const flushNow = useCallback(() => {
    if (frame.current !== null) {
      cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    setState(latest.current);
  }, []);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setState(latest.current);
    });
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
      }, SAFETY_UNFREEZE_MS);
      timers.current.set(id, t);
    }
  }, []);
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
    };
  }, [base, update]);

  const post = useCallback(
    (clientMsgId: string) => {
      const info = sendInfo.current.get(clientMsgId);
      if (!info) return;
      // sentAt lets the server map typingStartedAt onto its own clock.
      postJson(`${base}/messages`, { clientMsgId, ...info, sentAt: Date.now() })
        .then((r) => {
          const seq = (r as { seq?: unknown }).seq;
          if (typeof seq === 'number') update((s) => ackPending(s, clientMsgId, seq));
        })
        .catch(() => update((s) => failPending(s, clientMsgId, true), true));
    },
    [base, update],
  );

  const send = useCallback(
    (raw: string, typingStartedAt: number | null) => {
      const text = raw.trim();
      if (text === '') return;
      const clientMsgId = uuid();
      // Rendered now, so what is frozen is exactly what is on screen.
      const after = update((s) => freezeFor(addPending(s, clientMsgId, text), text), true);
      sendInfo.current.set(clientMsgId, { text, typingStartedAt, rendered: renderedCounts(after) });
      post(clientMsgId);
    },
    [post, update],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      update((s) => failPending(s, clientMsgId, false), true);
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
