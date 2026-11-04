import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, ConvEvent, EventBody } from '../../src/shared/events.js';
import { emptyView, GapError, type MessageView } from '../../src/shared/reducer.js';
import {
  ackPending,
  addPending,
  AWAIT_CAP_MS,
  canStop,
  displayedText,
  failPending,
  freezeAll,
  freezeFor,
  initialState,
  onEvent,
  renderedCounts,
  SAFETY_UNFREEZE_MS,
  shownMessages,
  STOP_GRACE_MS,
  stopExpiresIn,
  unfreeze,
  withSnapshot,
  type ClientState,
} from '../../src/web/useConversation.js';

function ev(seq: number, body: EventBody): ConvEvent {
  return { ...body, seq, conversationId: 'c1', at: 1000 + seq } as ConvEvent;
}
const user = (seq: number, id: string, clientMsgId = 'cm' + id, text = 'hi'): ConvEvent =>
  ev(seq, { type: 'user_message', messageId: id, clientMsgId, text });
const started = (seq: number, id: string, agentId: AgentId): ConvEvent =>
  ev(seq, {
    type: 'message_started',
    messageId: id,
    agentId,
    turnId: 't1',
    hop: 1,
    replyTo: null,
    contextCutoffSeq: seq - 1,
    effort: 'low',
  });
const delta = (seq: number, id: string, text: string, segment = 0): ConvEvent =>
  ev(seq, { type: 'token_delta', messageId: id, segment, offset: 0, text });
const segStart = (seq: number, id: string, segment: number, truncateTo: number, mode: 'continue' | 'replace') =>
  ev(seq, { type: 'message_segment_started', messageId: id, segment, contextCutoffSeq: seq - 1, truncateTo, mode });
const completed = (seq: number, id: string) => ev(seq, { type: 'message_completed', messageId: id });
const aborted = (seq: number, id: string, truncateTo: number) =>
  ev(seq, { type: 'message_aborted', messageId: id, reason: 'user_stop', truncateTo });
const resolved = (seq: number, userMessageId: string, targets: AgentId[]) =>
  ev(seq, { type: 'steer_resolved', userMessageId, targets });

const apply = (s: ClientState, ...es: ConvEvent[]) => es.reduce(onEvent, s);
const msg = (s: ClientState, id: string) => s.view.messages.find((m) => m.id === id) as MessageView;
const shown = (s: ClientState, id: string) => displayedText(s, msg(s, id));

/** u1, then Maya (A) and Theo (B) both streaming with some text. */
function twoStreaming(): ClientState {
  return apply(
    initialState(),
    user(1, 'u1'),
    started(2, 'A', 'maya'),
    started(3, 'B', 'theo'),
    delta(4, 'A', 'Maya says'),
    delta(5, 'B', 'Theo says'),
  );
}

describe('client conversation state', () => {
  it('freeze holds text while deltas arrive', () => {
    let s = freezeFor(twoStreaming(), '@Theo shorter');
    expect(s.frozen.get('B')).toBe('Theo says'.length);
    expect(s.frozen.has('A')).toBe(false);
    s = apply(s, delta(6, 'B', ' a lot more'), delta(7, 'A', ' more'));
    expect(shown(s, 'B')).toBe('Theo says');
    expect(shown(s, 'A')).toBe('Maya says more');
    expect(msg(s, 'B').text).toBe('Theo says a lot more');
  });

  it('freezes every streaming message when nobody is named', () => {
    const s = freezeFor(twoStreaming(), 'shorter please');
    expect([...s.frozen.keys()].sort()).toEqual(['A', 'B']);
  });

  it('freezes everyone on a broadcast even when a name appears', () => {
    const s = freezeFor(twoStreaming(), 'everyone, like Theo said, shorter');
    expect([...s.frozen.keys()].sort()).toEqual(['A', 'B']);
  });

  it('never freezes finished messages and keeps an existing freeze', () => {
    let s = apply(twoStreaming(), completed(6, 'A'));
    s = freezeFor(s, 'hmm');
    expect([...s.frozen.keys()]).toEqual(['B']);
    s = apply(s, delta(7, 'B', ' extra'));
    s = freezeFor(s, 'again');
    expect(s.frozen.get('B')).toBe('Theo says'.length);
  });

  it('steer_resolved unfreezes non-targets and shows buffered text', () => {
    let s = freezeFor(twoStreaming(), 'make it shorter');
    s = apply(s, user(6, 'u2'), delta(7, 'A', ' buffered'), delta(8, 'B', ' buffered'), resolved(9, 'u2', ['theo']));
    expect(s.frozen.has('A')).toBe(false);
    expect(shown(s, 'A')).toBe('Maya says buffered');
    expect(s.frozen.has('B')).toBe(true);
    expect(shown(s, 'B')).toBe('Theo says');
  });

  it('segment_started continue unfreezes at the kept text', () => {
    let s = freezeFor(twoStreaming(), '@Theo shorter');
    s = apply(s, user(6, 'u2'), delta(7, 'B', ' stale'), segStart(8, 'B', 1, 'Theo says'.length, 'continue'));
    expect(s.frozen.has('B')).toBe(false);
    expect(shown(s, 'B')).toBe('Theo says');
    s = apply(s, delta(9, 'B', ' briefly', 1));
    expect(shown(s, 'B')).toBe('Theo says briefly');
  });

  it('segment_started replace shows new text only', () => {
    let s = freezeFor(twoStreaming(), '@Theo in French');
    s = apply(s, user(6, 'u2'), delta(7, 'B', ' stale'), segStart(8, 'B', 1, 0, 'replace'));
    expect(s.frozen.has('B')).toBe(false);
    // Until the rewrite's first words arrive, the old words stay put.
    expect(shown(s, 'B')).toBe('Theo says');
    s = apply(s, delta(9, 'B', 'Bonjour', 1), delta(10, 'B', ' stale-old-segment', 0));
    expect(shown(s, 'B')).toBe('Bonjour');
  });

  it('a replace on a finished message keeps its words until the rewrite streams', () => {
    let s = apply(twoStreaming(), completed(6, 'B'), user(7, 'u2'), segStart(8, 'B', 1, 0, 'replace'));
    expect(shown(s, 'B')).toBe('Theo says');
    expect(shownMessages(s).map((m) => m.id)).toContain('B');
    s = apply(s, delta(9, 'B', 'Short.', 1), completed(10, 'B'));
    expect(shown(s, 'B')).toBe('Short.');
  });

  it('completion and abort unfreeze', () => {
    let s = freezeFor(twoStreaming(), 'stop');
    s = apply(s, delta(6, 'A', ' xx'), delta(7, 'B', ' yy'), completed(8, 'A'), aborted(9, 'B', 4));
    expect(s.frozen.size).toBe(0);
    expect(shown(s, 'A')).toBe('Maya says xx');
    expect(shown(s, 'B')).toBe('Theo');
  });

  it('stop_all freezes whatever is still streaming until the aborts land', () => {
    let s = twoStreaming();
    s = apply(s, ev(6, { type: 'stop_all', clientReqId: 'r1' }), delta(7, 'A', ' late'));
    expect(shown(s, 'A')).toBe('Maya says');
    s = apply(s, aborted(8, 'A', 9), aborted(9, 'B', 9));
    expect(s.frozen.size).toBe(0);
    expect(shown(s, 'A')).toBe('Maya says');
  });

  it('freezeAll and unfreeze', () => {
    let s = freezeAll(twoStreaming());
    expect(s.frozen.size).toBe(2);
    s = unfreeze(s, ['A']);
    expect([...s.frozen.keys()]).toEqual(['B']);
    s = unfreeze(s);
    expect(s.frozen.size).toBe(0);
  });

  it('renderedCounts equals displayed lengths', () => {
    let s = freezeFor(twoStreaming(), '@Maya');
    s = apply(s, delta(6, 'A', ' hidden'), delta(7, 'B', ' shown'), started(8, 'C', 'priya'), completed(9, 'B'));
    const counts = renderedCounts(s);
    for (const m of s.view.messages.filter((x) => x.status === 'streaming')) {
      expect(counts[m.id]).toBe(displayedText(s, m).length);
    }
    expect(counts).toEqual({ A: 'Maya says'.length, C: 0 });
  });

  it('optimistic send reconciles by clientMsgId', () => {
    let s = addPending(twoStreaming(), 'cm-x', 'hello team');
    let list = shownMessages(s);
    expect(list.at(-1)).toMatchObject({ text: 'hello team', pending: true, key: 'cm-x' });
    const before = list.length;
    s = ackPending(s, 'cm-x', 6);
    s = apply(s, user(6, 'u2', 'cm-x', 'hello team'));
    list = shownMessages(s);
    expect(list.length).toBe(before);
    expect(list.filter((m) => m.text === 'hello team')).toHaveLength(1);
    // Same React key, so the bubble does not remount.
    expect(list.at(-1)).toMatchObject({ id: 'u2', pending: false, key: 'cm-x' });
  });

  it('an ack for an already-applied message drops the pending bubble', () => {
    let s = addPending(twoStreaming(), 'cm-x', 'hello');
    s = withSnapshot(s, apply(s, user(6, 'u2', 'cm-x', 'hello')).view);
    s = ackPending(s, 'cm-x', 6);
    expect(s.pendingSends).toHaveLength(0);
  });

  it('a snapshot drops acked pendings it already contains', () => {
    let s = addPending(twoStreaming(), 'cm-x', 'hello');
    s = ackPending(s, 'cm-x', 6);
    s = withSnapshot(s, apply(s, user(6, 'u2', 'cm-x', 'hello')).view);
    expect(s.pendingSends).toHaveLength(0);
  });

  it('failed sends stay visible and marked', () => {
    let s = addPending(initialState(), 'cm-x', 'hello');
    s = failPending(s, 'cm-x', true);
    expect(shownMessages(s).at(-1)).toMatchObject({ text: 'hello', failed: true });
  });

  it('hides agent bubbles until they have words', () => {
    let s = apply(initialState(), user(1, 'u1'), started(2, 'A', 'maya'));
    expect(shownMessages(s).map((m) => m.id)).toEqual(['u1']);
    s = apply(s, delta(3, 'A', 'Hi'));
    expect(shownMessages(s).map((m) => m.id)).toEqual(['u1', 'A']);
    s = apply(s, started(4, 'B', 'theo'), aborted(5, 'B', 0));
    expect(shownMessages(s).map((m) => m.id)).toEqual(['u1', 'A']);
  });

  it('surfaces sequence gaps', () => {
    expect(() => onEvent(initialState(), user(3, 'u1'))).toThrow(GapError);
  });

  it('ignores replays', () => {
    const s = twoStreaming();
    expect(onEvent(s, delta(5, 'B', 'dup'))).toBe(s);
  });

  it('a snapshot drops freezes on messages that are gone', () => {
    const s = withSnapshot(freezeFor(twoStreaming(), 'x'), emptyView);
    expect(s.frozen.size).toBe(0);
    expect(s.view).toBe(emptyView);
  });

  it('releases a freeze only after the classifier could have answered', () => {
    expect(SAFETY_UNFREEZE_MS).toBe(7000);
  });

  it('a snapshot drops an unacked pending send it already contains', () => {
    let s = addPending(twoStreaming(), 'cm-x', 'hello');
    s = withSnapshot(s, apply(s, user(6, 'u2', 'cm-x', 'hello')).view);
    expect(s.pendingSends).toHaveLength(0);
    expect(shownMessages(s).filter((m) => m.text === 'hello')).toHaveLength(1);
  });

  it('a snapshot keeps freezes on messages that are still streaming', () => {
    let s = freezeAll(twoStreaming());
    const next = apply(s, delta(6, 'A', ' more'), delta(7, 'B', ' more'), completed(8, 'A'));
    s = withSnapshot(s, next.view);
    expect([...s.frozen.keys()]).toEqual(['B']);
    expect(shown(s, 'B')).toBe('Theo says');
    expect(shown(s, 'A')).toBe('Maya says more');
  });
});

describe('canStop', () => {
  afterEach(() => vi.useRealTimers());
  const at = (t: number) => vi.setSystemTime(t);
  const stopAll = (seq: number) => ev(seq, { type: 'stop_all', clientReqId: 'r' });

  it('is offered from an own send until its steer_resolved, before anyone streams', () => {
    vi.useFakeTimers();
    at(10_000);
    let s = addPending(initialState(), 'cm-a', 'Will we keep Northwind?');
    expect(canStop(s, Date.now())).toBe(true);
    s = apply(s, user(1, 'ua', 'cm-a'));
    at(12_000);
    expect(canStop(s, Date.now())).toBe(true); // still being classified
    s = apply(s, resolved(2, 'ua', []));
    expect(s.awaiting.size).toBe(0);
    expect(canStop(s, Date.now())).toBe(true); // the turn may still be gating
    expect(canStop(s, Date.now() + STOP_GRACE_MS)).toBe(false);
  });

  it('is offered while streaming and for a short grace after the last message ended', () => {
    vi.useFakeTimers();
    at(1_000);
    let s = apply(initialState(), user(1, 'u1'), started(2, 'A', 'maya'), delta(3, 'A', 'hi'));
    expect(canStop(s, Date.now())).toBe(true);
    expect(stopExpiresIn(s, Date.now())).toBeNull();
    at(5_000);
    s = apply(s, completed(4, 'A'));
    expect(canStop(s, 5_000 + STOP_GRACE_MS - 1)).toBe(true); // a hop-1 gate may be in flight
    expect(stopExpiresIn(s, 5_000)).toBe(STOP_GRACE_MS);
    expect(canStop(s, 5_000 + STOP_GRACE_MS)).toBe(false);
    expect(stopExpiresIn(s, 5_000 + STOP_GRACE_MS)).toBeNull();
  });

  it('is not offered for someone else\'s message or for nothing at all', () => {
    vi.useFakeTimers();
    at(1_000);
    expect(canStop(initialState(), Date.now())).toBe(false);
    const s = apply(initialState(), user(1, 'u1', 'cm-other'));
    expect(canStop(s, Date.now())).toBe(false);
  });

  it('a stop_all ends the grace and drops pending own sends', () => {
    vi.useFakeTimers();
    at(1_000);
    let s = addPending(initialState(), 'cm-a', 'hello');
    s = apply(s, user(1, 'ua', 'cm-a'), stopAll(2));
    expect(canStop(s, Date.now())).toBe(false);
    s = apply(s, resolved(3, 'ua', [])); // resolved after the stop: no new grace
    expect(canStop(s, Date.now())).toBe(false);
  });

  it('an undelivered send is not pending work; a retry is', () => {
    vi.useFakeTimers();
    at(1_000);
    let s = failPending(addPending(initialState(), 'cm-a', 'hello'), 'cm-a', true);
    expect(canStop(s, Date.now())).toBe(false);
    at(50_000);
    s = failPending(s, 'cm-a', false);
    expect(canStop(s, Date.now())).toBe(true);
    expect(canStop(s, Date.now() + AWAIT_CAP_MS)).toBe(false); // never stuck on a lost steer_resolved
  });
});
