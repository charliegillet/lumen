import { describe, expect, it } from 'vitest';
import type { ConvEvent, EventBody } from '../../src/shared/events.js';
import {
  applyEvent,
  emptyView,
  fold,
  GapError,
  visibleMessages,
  type ConversationView,
} from '../../src/shared/reducer.js';

let t = 1000;
function ev(seq: number, body: EventBody): ConvEvent {
  return { ...body, seq, conversationId: 'c1', at: t + seq } as ConvEvent;
}
const user = (seq: number, id: string): ConvEvent =>
  ev(seq, { type: 'user_message', messageId: id, clientMsgId: 'cm' + id, text: 'hi ' + id });
const started = (seq: number, id: string, agentId: 'maya' | 'theo' | 'priya' = 'maya'): ConvEvent =>
  ev(seq, {
    type: 'message_started',
    messageId: id,
    agentId,
    turnId: 't1',
    hop: 1,
    replyTo: null,
    contextCutoffSeq: 1,
    effort: 'low',
  });
const delta = (seq: number, id: string, text: string, segment = 0, offset = 0): ConvEvent =>
  ev(seq, { type: 'token_delta', messageId: id, segment, offset, text });
const segment = (
  seq: number,
  id: string,
  seg: number,
  truncateTo: number,
  mode: 'continue' | 'replace',
  moved?: boolean,
): ConvEvent =>
  ev(seq, {
    type: 'message_segment_started',
    messageId: id,
    segment: seg,
    contextCutoffSeq: seq - 1,
    truncateTo,
    mode,
    ...(moved === undefined ? {} : { moved }),
  });
const msg = (v: ConversationView, id: string) => v.messages.find((m) => m.id === id)!;

describe('reducer', () => {
  it('orders by start seq', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), started(3, 'B', 'theo'), delta(4, 'B', 'b'), delta(5, 'A', 'a'), user(6, 'u6')]);
    expect(v.messages.map((m) => m.id)).toEqual(['u1', 'A', 'B', 'u6']);
    expect(v.lastSeq).toBe(6);
    expect(msg(v, 'u1')).toMatchObject({ author: { kind: 'user' }, status: 'done', startSeq: 1, completedAt: 1001, hop: 0 });
  });

  it('ignores duplicate seq', () => {
    const e = user(1, 'u1');
    const once = applyEvent(emptyView, e);
    expect(applyEvent(once, e)).toEqual(once);
  });

  it('throws GapError on seq jump', () => {
    const v = applyEvent(emptyView, user(1, 'u1'));
    expect(() => applyEvent(v, user(3, 'u3'))).toThrow(GapError);
    expect(() => applyEvent(emptyView, user(2, 'u2'))).toThrow(GapError);
  });

  it('does not mutate its input view', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'x')]);
    const snapshot = structuredClone(v);
    applyEvent(v, delta(4, 'A', 'y'));
    applyEvent(v, ev(4, { type: 'instruction_set', instructionId: 'i', scope: 'all', text: 't' }));
    expect(v).toEqual(snapshot);
  });

  it('continue segment truncates then appends', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'Hello wor'), segment(4, 'A', 1, 5, 'continue'), delta(5, 'A', ' there', 1, 5)]);
    expect(msg(v, 'A').text).toBe('Hello there');
    expect(msg(v, 'A').segment).toBe(1);
  });

  it('replace segment clears', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'Hello wor'), segment(4, 'A', 1, 0, 'replace'), delta(5, 'A', 'New', 1, 0)]);
    expect(msg(v, 'A').text).toBe('New');
  });

  it('drops deltas for stale segment', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'abc'), segment(4, 'A', 1, 3, 'continue'), delta(5, 'A', 'STALE', 0, 3)]);
    expect(msg(v, 'A').text).toBe('abc');
  });

  it('segment on a done message reopens it', () => {
    const done = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'abc'), ev(4, { type: 'message_completed', messageId: 'A' })]);
    expect(msg(done, 'A')).toMatchObject({ status: 'done', completedAt: 1004 });
    const v = applyEvent(done, segment(5, 'A', 1, 3, 'continue'));
    expect(msg(v, 'A').status).toBe('streaming');
    expect(msg(v, 'A').completedAt).toBeNull();
  });

  it('aborted keeps truncated text', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'abcdefg'), ev(4, { type: 'message_aborted', messageId: 'A', reason: 'user_stop', truncateTo: 4 })]);
    expect(msg(v, 'A')).toMatchObject({ text: 'abcd', status: 'stopped', completedAt: null });
  });

  it('appends deltas with mismatched offset and ignores unknown message ids', () => {
    const v = fold([user(1, 'u1'), started(2, 'A'), delta(3, 'A', 'ab', 0, 0), delta(4, 'A', 'cd', 0, 99), delta(5, 'ghost', 'zz')]);
    expect(msg(v, 'A').text).toBe('abcd');
    expect(v.lastSeq).toBe(5);
    expect(v.messages).toHaveLength(2);
  });

  it('steer_resolved and stop_all only advance lastSeq', () => {
    const v1 = applyEvent(emptyView, user(1, 'u1'));
    const v2 = applyEvent(v1, ev(2, { type: 'steer_resolved', userMessageId: 'u1', targets: ['maya'] }));
    const v3 = applyEvent(v2, ev(3, { type: 'stop_all', clientReqId: 'r' }));
    expect(v3).toEqual({ ...v1, lastSeq: 3 });
  });

  it('instructions fold', () => {
    const v = fold([
      ev(1, { type: 'instruction_set', instructionId: 'i1', scope: 'all', text: 'be brief' }),
      ev(2, { type: 'instruction_set', instructionId: 'i2', scope: 'theo', text: 'be formal' }),
      ev(3, { type: 'instruction_revoked', instructionId: 'i1' }),
    ]);
    expect(v.instructions).toEqual([{ id: 'i2', scope: 'theo', text: 'be formal' }]);
  });

  it('visibleMessages hides empty stopped agent bubble', () => {
    const v = fold([
      user(1, 'u1'),
      started(2, 'A'),
      started(3, 'B', 'theo'),
      ev(4, { type: 'message_aborted', messageId: 'A', reason: 'user_stop', truncateTo: 0 }),
    ]);
    expect(visibleMessages(v).map((m) => m.id)).toEqual(['u1', 'B']);
  });

  it('a moved segment puts the message after everything before it', () => {
    const log = [
      user(1, 'u1'),
      started(2, 'A'),
      started(3, 'B', 'theo'),
      started(4, 'C', 'priya'),
      delta(5, 'B', 'Hello wor'),
      user(6, 'u6'),
      segment(7, 'B', 1, 5, 'continue', true),
      delta(8, 'B', ' there', 1, 5),
    ];
    const v = fold(log);
    expect(v.messages.map((m) => m.id)).toEqual(['u1', 'A', 'C', 'u6', 'B']);
    expect(msg(v, 'B')).toMatchObject({ text: 'Hello there', startSeq: 3, anchorSeq: 7, segment: 1 });
    expect(msg(v, 'A')).toMatchObject({ startSeq: 2, anchorSeq: 2 });
    expect(msg(v, 'u6')).toMatchObject({ startSeq: 6, anchorSeq: 6 });
    // Messages started after the move still land below it.
    const later = applyEvent(v, started(9, 'D', 'maya'));
    expect(later.messages.map((m) => m.id)).toEqual(['u1', 'A', 'C', 'u6', 'B', 'D']);
  });

  it('a segment that is not moved keeps the message in place', () => {
    for (const moved of [false, undefined]) {
      const v = fold([
        user(1, 'u1'),
        started(2, 'A'),
        started(3, 'B', 'theo'),
        delta(4, 'A', 'abc'),
        user(5, 'u5'),
        segment(6, 'A', 1, 3, 'continue', moved),
      ]);
      expect(v.messages.map((m) => m.id)).toEqual(['u1', 'A', 'B', 'u5']);
      expect(msg(v, 'A')).toMatchObject({ startSeq: 2, anchorSeq: 2, segment: 1 });
    }
  });

  it('a moved reopen of a finished message moves it too', () => {
    const v = fold([
      user(1, 'u1'),
      started(2, 'A'),
      delta(3, 'A', 'abc'),
      ev(4, { type: 'message_completed', messageId: 'A' }),
      started(5, 'B', 'theo'),
      user(6, 'u6'),
      segment(7, 'A', 1, 0, 'replace', true),
    ]);
    expect(v.messages.map((m) => m.id)).toEqual(['u1', 'B', 'u6', 'A']);
    expect(msg(v, 'A')).toMatchObject({ status: 'streaming', anchorSeq: 7, startSeq: 2 });
  });

  it('display order is anchorSeq order, and refolding any prefix agrees', () => {
    const log = [
      user(1, 'u1'),
      started(2, 'A'),
      started(3, 'B', 'theo'),
      user(4, 'u4'),
      segment(5, 'A', 1, 0, 'replace', true),
      user(6, 'u6'),
      segment(7, 'B', 1, 0, 'replace', true),
      segment(8, 'A', 2, 0, 'replace', false),
      user(9, 'u9'),
      segment(10, 'A', 3, 0, 'replace', true),
    ];
    const v = fold(log);
    expect(v.messages.map((m) => m.id)).toEqual(['u1', 'u4', 'u6', 'B', 'u9', 'A']);
    const anchors = v.messages.map((m) => m.anchorSeq);
    expect(anchors).toEqual([...anchors].sort((a, b) => a - b));
    for (let n = 0; n <= log.length; n++) {
      const step = log.slice(0, n).reduce(applyEvent, emptyView);
      expect(step).toEqual(fold(log.slice(0, n)));
      const a = step.messages.map((m) => m.anchorSeq);
      expect(a).toEqual([...a].sort((x, y) => x - y));
    }
  });

  it('a moved segment for an unknown message changes nothing but lastSeq', () => {
    const v = fold([user(1, 'u1'), started(2, 'A')]);
    const w = applyEvent(v, segment(3, 'ghost', 1, 0, 'replace', true));
    expect(w).toEqual({ ...v, lastSeq: 3 });
  });

  it('keeps the clientMsgId on user messages only', () => {
    const v = fold([user(1, 'u1'), started(2, 'A')]);
    expect(msg(v, 'u1').clientMsgId).toBe('cmu1');
    expect(msg(v, 'A').clientMsgId).toBeUndefined();
  });
});
