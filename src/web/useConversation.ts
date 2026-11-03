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
  /** server messageId -> clientMsgId, so a confirmed bubble keeps its React key. */
  keys: Map<string, string>;
}

export type ShownMessage = MessageView & { key: string; pending: boolean; failed: boolean };

export const SAFETY_UNFREEZE_MS = 2000;

export function initialState(view: ConversationView = emptyView): ClientState {
  return { view, frozen: new Map(), held: new Map(), pendingSends: [], keys: new Map() };
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

/** Applies one server event. Throws GapError when events were missed. */
export function onEvent(s: ClientState, e: ConvEvent): ClientState {
  const view = applyEvent(s.view, e);
  if (view === s.view) return s; // replayed event
  const next: ClientState = { ...s, view };

  switch (e.type) {
    case 'user_message': {
      if (!s.pendingSends.some((p) => p.clientMsgId === e.clientMsgId)) return next;
      const keys = new Map(s.keys);
      keys.set(e.messageId, e.clientMsgId);
      return { ...next, keys, pendingSends: s.pendingSends.filter((p) => p.clientMsgId !== e.clientMsgId) };
    }
    case 'steer_resolved': {
      const ids = view.messages
        .filter((m) => s.frozen.has(m.id) && !(m.author.kind === 'agent' && e.targets.includes(m.author.agentId)))
        .map((m) => m.id);
      return unfreeze(next, ids);
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
    case 'message_aborted':
      return { ...next, frozen: without(s.frozen, e.messageId), held: without(s.held, e.messageId) };
    case 'stop_all':
      // The aborts that follow carry the final text; hold everything until they land.
      return freezeAll(next);
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
  return { ...s, pendingSends: [...s.pendingSends, { clientMsgId, text, seq: null, failed: false }] };
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

export function failPending(s: ClientState, clientMsgId: string, failed: boolean): ClientState {
  return {
    ...s,
    pendingSends: s.pendingSends.map((p) => (p.clientMsgId === clientMsgId ? { ...p, failed } : p)),
  };
}

/** Replace the view wholesale (initial load, or recovery after a gap). */
export function withSnapshot(s: ClientState, view: ConversationView): ClientState {
  return {
    ...s,
    view,
    frozen: new Map(),
    held: new Map(),
    pendingSends: s.pendingSends.filter((p) => p.seq === null || p.seq > view.lastSeq),
  };
}

/** What the conversation shows: confirmed messages in order, then unconfirmed sends. */
export function shownMessages(s: ClientState): ShownMessage[] {
  const out: ShownMessage[] = [];
  for (const m of visibleMessages(s.view)) {
    if (m.author.kind === 'agent' && displayedText(s, m) === '') continue; // no words yet
    out.push({ ...m, key: s.keys.get(m.id) ?? m.id, pending: false, failed: false });
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

  const update = useCallback(
    (f: (s: ClientState) => ClientState, now = false) => {
      latest.current = f(latest.current);
      if (now) flushNow();
      else schedule();
    },
    [flushNow, schedule],
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
        update((s) => withSnapshot(s, view), true);
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

  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const set = timers.current;
    return () => {
      for (const t of set) clearTimeout(t);
    };
  }, []);

  /** Whatever a freeze froze is released after a while, come what may. */
  const releaseLater = useCallback(
    (before: ClientState, after: ClientState) => {
      const ids = [...after.frozen.keys()].filter((k) => !before.frozen.has(k));
      if (ids.length === 0) return;
      const t = setTimeout(() => {
        timers.current.delete(t);
        update((s) => unfreeze(s, ids));
      }, SAFETY_UNFREEZE_MS);
      timers.current.add(t);
    },
    [update],
  );

  const post = useCallback(
    (clientMsgId: string) => {
      const info = sendInfo.current.get(clientMsgId);
      if (!info) return;
      postJson(`${base}/messages`, { clientMsgId, ...info })
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
      const before = latest.current;
      const after = freezeFor(addPending(before, clientMsgId, text), text);
      latest.current = after;
      flushNow(); // what is frozen is exactly what is on screen
      releaseLater(before, after);
      sendInfo.current.set(clientMsgId, { text, typingStartedAt, rendered: renderedCounts(after) });
      post(clientMsgId);
    },
    [flushNow, post, releaseLater],
  );

  const retry = useCallback(
    (clientMsgId: string) => {
      update((s) => failPending(s, clientMsgId, false), true);
      post(clientMsgId);
    },
    [post, update],
  );

  const stop = useCallback(() => {
    const before = latest.current;
    if (!before.view.messages.some((m) => m.status === 'streaming')) return;
    const after = freezeAll(before);
    latest.current = after;
    flushNow();
    releaseLater(before, after);
    postJson(`${base}/stop`, { clientReqId: uuid(), rendered: renderedCounts(after) }).catch(() => {
      update((s) => unfreeze(s, [...after.frozen.keys()].filter((k) => !before.frozen.has(k))));
    });
  }, [base, flushNow, releaseLater, update]);

  const messages = useMemo(() => shownMessages(state), [state]);
  const displayed = useCallback((m: MessageView) => displayedText(state, m), [state]);
  const anyStreaming = useMemo(() => state.view.messages.some((m) => m.status === 'streaming'), [state]);

  return { messages, displayed, send, retry, stop, anyStreaming, loaded };
}
