import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentId, ConvEvent, EventBody } from '../../src/shared/events.js';
import { emptyView, GapError, type MessageView } from '../../src/shared/reducer.js';
import {
  ackPending,
  addPending,
  advanceReveal,
  AWAIT_CAP_MS,
  canStop,
  displayedText,
  failPending,
  freezeAll,
  freezeFor,
  initialState,
  onEvent,
  renderedCounts,
  REVEAL_BASE_CPS,
  REVEAL_FINISH_MS,
  REVEAL_MAX_LAG_MS,
  revealPending,
  revealRate,
  SAFETY_UNFREEZE_MS,
  setAnimate,
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
const segStart = (
  seq: number,
  id: string,
  segment: number,
  truncateTo: number,
  mode: 'continue' | 'replace',
  moved?: true,
) =>
  ev(seq, {
    type: 'message_segment_started',
    messageId: id,
    segment,
    contextCutoffSeq: seq - 1,
    truncateTo,
    mode,
    ...(moved ? { moved } : {}),
  });
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

/** Like twoStreaming, with the typewriter on and everything so far revealed. */
function animated(): ClientState {
  return apply(initialState(undefined, { animate: true }), user(1, 'u1'), started(2, 'A', 'maya'), started(3, 'B', 'theo'));
}
const deltaAt = (seq: number, id: string, text: string, offset: number, segment = 0): ConvEvent =>
  ev(seq, { type: 'token_delta', messageId: id, segment, offset, text });
/** Advance in 16 ms frames. */
function frames(s: ClientState, n: number): ClientState {
  for (let i = 0; i < n; i++) s = advanceReveal(s, 16);
  return s;
}

describe('typewriter reveal', () => {
  it('live words appear gradually at the base rate, at word boundaries', () => {
    let s = apply(animated(), deltaAt(4, 'A', 'ab cd ef gh ', 0));
    expect(msg(s, 'A').text).toBe('ab cd ef gh ');
    expect(shown(s, 'A')).toBe(''); // nothing yet: still typing dots
    expect(shownMessages(s).find((m) => m.id === 'A')?.typing).toBe(true);
    s = advanceReveal(s, 40); // 75 chars/s * 40 ms = 3 chars
    expect(shown(s, 'A')).toBe('ab ');
    s = advanceReveal(s, 40);
    expect(shown(s, 'A')).toBe('ab cd ');
    s = advanceReveal(s, 20); // 1.5 more chars: not enough for the next word
    expect(shown(s, 'A')).toBe('ab cd ');
    s = frames(s, 10);
    expect(shown(s, 'A')).toBe('ab cd ef gh ');
    expect(revealPending(s)).toBe(false); // caught up, waiting for more
  });

  it('the rate grows with the backlog and the display stays within about 400 ms of what arrived', () => {
    expect(revealRate(3, false)).toBe(REVEAL_BASE_CPS);
    expect(revealRate(300, false)).toBeCloseTo((300 * 1000) / REVEAL_MAX_LAG_MS);
    expect(revealRate(300, true)).toBeGreaterThan(revealRate(300, false));
    // A fast model: 400 chars/s, flushed every 75 ms, rendered at 60 fps for 4 s.
    let s = animated();
    const cps = 400;
    let sent = 0;
    let seq = 4;
    let worstLagMs = 0;
    for (let t = 0; t < 4000; t += 16) {
      if (Math.floor(t / 75) !== Math.floor((t - 16) / 75)) {
        const want = Math.floor((t / 1000) * cps);
        const chunk = 'word '.repeat(Math.ceil((want - sent) / 5));
        s = apply(s, deltaAt(seq++, 'A', chunk, sent));
        sent += chunk.length;
      }
      s = advanceReveal(s, 16);
      worstLagMs = Math.max(worstLagMs, ((sent - shown(s, 'A').length) / cps) * 1000);
    }
    expect(worstLagMs).toBeLessThan(450);
    expect(shown(s, 'A').length).toBeGreaterThan(sent - cps * 0.45);
  });

  it('a freeze stops the reveal exactly where it is; renderedCounts reports what is on screen', () => {
    let s = apply(animated(), deltaAt(4, 'A', 'one two three four five six ', 0), deltaAt(5, 'B', 'alpha beta ', 0));
    s = advanceReveal(s, 60);
    const before = shown(s, 'A');
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(msg(s, 'A').text.length);
    expect(renderedCounts(s).A).toBe(before.length); // displayed, not received
    s = freezeFor(s, '@Maya shorter');
    expect(s.frozen.get('A')).toBe(before.length);
    s = frames(apply(s, deltaAt(6, 'A', 'seven eight ', msg(s, 'A').text.length)), 30);
    expect(shown(s, 'A')).toBe(before);
    expect(renderedCounts(s).A).toBe(before.length);
    expect(shown(s, 'B')).toBe('alpha beta '); // others keep revealing
    s = frames(unfreeze(s, ['A']), 60);
    expect(shown(s, 'A')).toBe('one two three four five six seven eight ');
  });

  it('a truncating segment or abort clamps the reveal', () => {
    let s = apply(animated(), deltaAt(4, 'A', 'one two three four ', 0));
    s = frames(s, 8);
    const n = shown(s, 'A').length;
    expect(n).toBeGreaterThan(4);
    s = apply(s, user(5, 'u2'), segStart(6, 'A', 1, 4, 'continue'));
    expect(shown(s, 'A')).toBe('one ');
    expect(s.reveal.get('A')!.shown).toBeLessThanOrEqual(4);
    s = apply(s, deltaAt(7, 'A', 'more words here ', 4, 1));
    expect(shown(s, 'A')).toBe('one '); // the continuation is revealed from the cut, not shown at once
    s = frames(s, 6);
    expect(shown(s, 'A').length).toBeGreaterThan(4);
    s = apply(s, aborted(8, 'A', 2));
    expect(shown(s, 'A')).toBe('on');
    s = frames(s, 2);
    expect(s.reveal.has('A')).toBe(false);
    expect(shown(s, 'A')).toBe('on');
  });

  it('a completed message finishes quickly but not in one frame', () => {
    let s = apply(animated(), deltaAt(4, 'A', 'x '.repeat(60), 0), completed(5, 'A'));
    s = advanceReveal(s, 16);
    expect(shown(s, 'A').length).toBeGreaterThan(0);
    expect(shown(s, 'A').length).toBeLessThan(120);
    let n = 1;
    while (s.reveal.has('A') && n < 100) {
      s = advanceReveal(s, 16);
      n++;
    }
    expect(shown(s, 'A')).toBe('x '.repeat(60));
    expect(n * 16).toBeLessThanOrEqual(REVEAL_FINISH_MS + 32);
    expect(revealPending(s)).toBe(false);
  });

  it('snapshots, finished messages and reduced motion show text at once', () => {
    // A snapshot (initial load or reload) is shown whole.
    const view = apply(initialState(), user(1, 'u1'), started(2, 'A', 'maya'), delta(3, 'A', 'all of it already')).view;
    let s = withSnapshot(initialState(undefined, { animate: true }), view);
    expect(shown(s, 'A')).toBe('all of it already');
    // A reveal in progress is dropped by a snapshot (recovery after a gap).
    s = apply(s, deltaAt(4, 'A', ' and more', 'all of it already'.length));
    expect(shown(s, 'A')).toBe('all of it already');
    s = withSnapshot(s, s.view);
    expect(shown(s, 'A')).toBe('all of it already and more');
    // Reduced motion: deltas show as they arrive.
    const still = apply(initialState(undefined, { animate: false }), user(1, 'u1'), started(2, 'A', 'maya'), delta(3, 'A', 'now'));
    expect(shown(still, 'A')).toBe('now');
    const off = setAnimate(apply(animated(), deltaAt(4, 'A', 'hello there ', 0)), false);
    expect(shown(off, 'A')).toBe('hello there ');
  });

  it('never splits a surrogate pair inside a long unbroken run', () => {
    let s = apply(animated(), deltaAt(4, 'A', '😀'.repeat(40), 0));
    for (let i = 0; i < 40 && s.reveal.has('A'); i++) {
      s = advanceReveal(s, 16);
      const t = shown(s, 'A');
      if (t.length > 0) expect(t.charCodeAt(t.length - 1)).not.toBe(0xd83d);
      expect(t.length % 2).toBe(0);
    }
  });

  it('held words from before a rewrite stay until the rewrite shows its first word', () => {
    let s = apply(animated(), deltaAt(4, 'B', 'Old answer ', 0));
    s = frames(s, 20);
    expect(shown(s, 'B')).toBe('Old answer ');
    s = apply(s, user(5, 'u2'), segStart(6, 'B', 1, 0, 'replace'), deltaAt(7, 'B', 'New words ', 0, 1));
    expect(shown(s, 'B')).toBe('Old answer ');
    expect(shownMessages(s).find((m) => m.id === 'B')?.typing).toBe(false);
    s = frames(s, 4);
    expect(shown(s, 'B')).toBe('New ');
    expect(s.held.has('B')).toBe(false);
    // Completing before anything was revealed still does not flash dots.
    s = apply(s, user(8, 'u3'), segStart(9, 'B', 2, 0, 'replace'), deltaAt(10, 'B', 'Short.', 0, 2), completed(11, 'B'));
    expect(shown(s, 'B')).toBe('New '); // the words that were on screen
    s = frames(s, 20);
    expect(shown(s, 'B')).toBe('Short.');
    expect(s.held.has('B')).toBe(false);
  });
});

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

  it('a moved segment puts the steered bubble below the steer, keeping freezes and pendings', () => {
    // Own steer at Maya is confirmed; a second send is still unconfirmed.
    let s = freezeFor(addPending(twoStreaming(), 'cmS', '@Maya shorter'), '@Maya shorter');
    s = freezeFor(addPending(s, 'cmP', '@Theo and you?'), '@Theo and you?');
    expect([...s.frozen.keys()].sort()).toEqual(['A', 'B']);
    s = apply(s, user(6, 'S', 'cmS', '@Maya shorter'), delta(7, 'A', ' hidden'));
    const keys = () => shownMessages(s).map((m) => m.key);
    expect(keys()).toEqual(['cmu1', 'A', 'B', 'cmS', 'cmP']);

    s = apply(s, segStart(8, 'A', 1, 'Maya says'.length, 'continue', true));
    expect(keys()).toEqual(['cmu1', 'B', 'cmS', 'A', 'cmP']);
    expect(msg(s, 'A')).toMatchObject({ anchorSeq: 8, startSeq: 2 });
    expect(s.frozen.has('A')).toBe(false); // the moved bubble shows its new segment
    expect(s.frozen.get('B')).toBe('Theo says'.length); // Theo stays frozen for the pending send
    expect(shown(s, 'A')).toBe('Maya says');
    expect(shownMessages(s).find((m) => m.key === 'cmP')).toMatchObject({ pending: true });

    s = apply(s, delta(9, 'A', ' briefly', 1), delta(10, 'B', ' more'));
    expect(shown(s, 'A')).toBe('Maya says briefly');
    expect(shown(s, 'B')).toBe('Theo says');
    s = apply(s, resolved(11, 'S', ['maya']));
    expect(shown(s, 'B')).toBe('Theo says more');
    s = apply(s, user(12, 'P', 'cmP', '@Theo and you?'));
    expect(keys()).toEqual(['cmu1', 'B', 'cmS', 'A', 'cmP']);
    expect(s.pendingSends).toHaveLength(0);
  });

  it('a moved replace keeps its words on screen at the new place', () => {
    let s = freezeFor(twoStreaming(), '@Theo again');
    s = apply(s, user(6, 'S'), segStart(7, 'B', 1, 0, 'replace', true));
    expect(shownMessages(s).map((m) => m.key)).toEqual(['cmu1', 'A', 'cmS', 'B']);
    expect(shown(s, 'B')).toBe('Theo says');
    s = apply(s, delta(8, 'B', 'New', 1));
    expect(shown(s, 'B')).toBe('New');
  });

  it('a segment without moved leaves the bubble in place', () => {
    const s = apply(twoStreaming(), user(6, 'S'), segStart(7, 'A', 1, 4, 'continue'));
    expect(shownMessages(s).map((m) => m.key)).toEqual(['cmu1', 'A', 'B', 'cmS']);
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

  it('shows typing dots once a message started, until it has words; an empty ended message has no bubble', () => {
    const typing = (s: ClientState) => shownMessages(s).map((m) => `${m.id}${m.typing ? '…' : ''}`);
    let s = apply(initialState(), user(1, 'u1'));
    expect(typing(s)).toEqual(['u1']); // nobody has started: no dots (gating is invisible)
    s = apply(s, started(2, 'A', 'maya'));
    expect(typing(s)).toEqual(['u1', 'A…']);
    s = apply(s, delta(3, 'A', 'Hi'));
    expect(typing(s)).toEqual(['u1', 'A']);
    s = apply(s, started(4, 'B', 'theo'));
    expect(typing(s)).toEqual(['u1', 'A', 'B…']);
    s = apply(s, aborted(5, 'B', 0));
    expect(typing(s)).toEqual(['u1', 'A']);
    s = apply(s, started(6, 'C', 'priya'), ev(7, { type: 'message_aborted', messageId: 'C', reason: 'error', truncateTo: 0 }));
    expect(typing(s)).toEqual(['u1', 'A']);
  });

  it('a steered restart with nothing kept shows dots; a replace keeps its held words instead', () => {
    const typing = (s: ClientState, id: string) => shownMessages(s).find((m) => m.id === id)?.typing;
    let s = apply(twoStreaming(), user(6, 'u2'), segStart(7, 'A', 1, 0, 'continue'));
    expect(typing(s, 'A')).toBe(true);
    s = apply(s, segStart(8, 'B', 1, 0, 'replace'));
    expect(typing(s, 'B')).toBe(false);
    expect(shown(s, 'B')).toBe('Theo says');
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
