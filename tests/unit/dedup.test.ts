import { describe, expect, it } from 'vitest';
import { noveltyThreshold, selectSpeakers } from '../../src/server/orchestrator/dedup.js';
import type { Bid } from '../../src/server/orchestrator/gate.js';
import type { AgentId } from '../../src/shared/events.js';

const bid = (agentId: AgentId, o: Partial<Bid> = {}): Bid => ({
  agentId,
  should_respond: true,
  novelty: 2,
  gist: `${agentId} point`,
  addresses: ['user'],
  effort: 'low',
  ...o,
});
const solo = (...ids: AgentId[]): AgentId[][] => ids.map((i) => [i]);
const ids = (r: { agentId: AgentId }[]) => r.map((s) => s.agentId).sort();

describe('selectSpeakers', () => {
  it('thresholds by hop', () => {
    expect([0, 1, 2, 5].map(noveltyThreshold)).toEqual([1, 2, 3, 3]);
  });

  it('forced always included', () => {
    const bids = [bid('maya', { should_respond: false, novelty: 0, effort: 'high' })];
    const r = selectSpeakers(bids, solo('maya'), { forced: ['maya', 'theo'], hop: 3, excluded: [] });
    expect(ids(r)).toEqual(['maya', 'theo']);
    expect(r.find((s) => s.agentId === 'maya')!.effort).toBe('high');
    expect(r.find((s) => s.agentId === 'theo')!.effort).toBe('medium');
  });

  it('cluster keeps one', () => {
    const bids = [bid('maya', { novelty: 2 }), bid('theo', { novelty: 3 })];
    const r = selectSpeakers(bids, [['maya', 'theo']], { forced: [], hop: 0, excluded: [] });
    expect(ids(r)).toEqual(['theo']);
  });

  it('cluster tie breaks by AGENT_IDS order; forced wins first', () => {
    const bids = [bid('priya', { novelty: 3 }), bid('maya', { novelty: 3 }), bid('theo', { novelty: 1 })];
    expect(ids(selectSpeakers(bids, [['priya', 'maya', 'theo']], { forced: [], hop: 0, excluded: [] }))).toEqual(['maya']);
    expect(ids(selectSpeakers(bids, [['priya', 'maya', 'theo']], { forced: ['theo'], hop: 0, excluded: [] }))).toEqual(['theo']);
  });

  it('threshold rises with hop', () => {
    const bids = [bid('maya', { novelty: 1 })];
    expect(selectSpeakers(bids, solo('maya'), { forced: [], hop: 0, excluded: [] })).toHaveLength(1);
    expect(selectSpeakers(bids, solo('maya'), { forced: [], hop: 1, excluded: [] })).toHaveLength(0);
  });

  it('at-least-one at hop 0', () => {
    const bids = [
      bid('maya', { should_respond: false, novelty: 1 }),
      bid('theo', { should_respond: false, novelty: 3 }),
      bid('priya', { should_respond: false, novelty: 3 }),
    ];
    const r = selectSpeakers(bids, solo('maya', 'theo', 'priya'), { forced: [], hop: 0, excluded: [] });
    expect(ids(r)).toEqual(['theo']);
  });

  it('at-least-one skips excluded', () => {
    const bids = [bid('maya', { should_respond: false, novelty: 3 }), bid('theo', { should_respond: false, novelty: 1 })];
    const r = selectSpeakers(bids, solo('maya', 'theo'), { forced: [], hop: 0, excluded: ['maya'] });
    expect(ids(r)).toEqual(['theo']);
  });

  it('none at hop>0 when no bids', () => {
    const bids = [bid('maya', { should_respond: false })];
    expect(selectSpeakers(bids, solo('maya'), { forced: [], hop: 1, excluded: [] })).toEqual([]);
    expect(selectSpeakers([], [], { forced: [], hop: 2, excluded: [] })).toEqual([]);
  });

  it('excluded agent dropped unless forced', () => {
    const bids = [bid('maya'), bid('theo')];
    const o = { hop: 0, excluded: ['maya' as AgentId] };
    expect(ids(selectSpeakers(bids, solo('maya', 'theo'), { ...o, forced: [] }))).toEqual(['theo']);
    expect(ids(selectSpeakers(bids, solo('maya', 'theo'), { ...o, forced: ['maya'] }))).toEqual(['maya', 'theo']);
  });

  it('is deterministic and returns gist from bid', () => {
    const bids = [bid('theo', { gist: 'g' })];
    const a = selectSpeakers(bids, solo('theo'), { forced: [], hop: 0, excluded: [] });
    expect(a).toEqual([{ agentId: 'theo', effort: 'low', gist: 'g' }]);
  });
});
