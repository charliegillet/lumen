import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';
import { classifySteer } from '../../src/server/steering/classify.js';
import { PERSONAS } from '../../src/server/agents/personas.js';

beforeEach(() => {
  process.env.MODEL_CLASSIFIER = 'fake:x';
  resetFake();
});
afterEach(() => resetFake());

const base = { text: 'Theo, shorter please', streaming: [], recentlyFinished: [], instructions: [] };

describe('classifySteer', () => {
  it('invalid output falls back to regex targets (new_message when nothing streams)', async () => {
    setFakeScript(() => ({ object: { kind: 'bogus' } }));
    expect(await classifySteer(base)).toEqual({
      kind: 'new_message', targets: ['theo'], apply: 'continue', scope: 'one_off', standing_text: null, revokes: [],
      fallback: true,
    });
  });

  it('fallback is steer while someone streams; LLM error too', async () => {
    setFakeScript(() => ({ error: 'boom' }));
    const d = await classifySteer({ ...base, streaming: [{ agentId: 'theo', partial: 'Well' }] });
    expect(d.kind).toBe('steer');
    expect(d.targets).toEqual(['theo']);
    expect(d.fallback).toBe(true);
  });

  it('guides stop-like openers followed by an instruction to steer', async () => {
    setFakeScript(() => ({ error: 'boom' }));
    await classifySteer({ ...base, text: 'Theo wait, focus on pricing' });
    expect(fakeRequests[0]!.system).toMatch(/stop-like opener followed by an instruction[^\n]*is "steer", not "stop"/);
  });

  it('request contains no private notes canary', async () => {
    setFakeScript(() => ({ object: { kind: 'new_message', targets: [], apply: 'continue', scope: 'one_off', standing_text: null, revokes: [] } }));
    await classifySteer({ ...base, instructions: [{ id: 'i1', scope: 'all', text: 'be brief' }] });
    const req = fakeRequests[0]!;
    expect(req.kind).toBe('classify');
    const all = req.system + JSON.stringify(req.messages);
    expect(all).toContain('[i1]');
    for (const p of Object.values(PERSONAS)) expect(all).not.toContain(p.privateNotes as string);
  });

  it('validates output: drops unknown revokes, fills standing_text, truncates partials', async () => {
    setFakeScript(() => ({
      object: { kind: 'steer', targets: ['maya'], apply: 'replace', scope: 'standing', standing_text: null, revokes: ['i1', 'zzz'] },
    }));
    const d = await classifySteer({
      ...base,
      text: 'always answer in French',
      streaming: [{ agentId: 'maya', partial: 'x'.repeat(1000) + 'END' }],
      instructions: [{ id: 'i1', scope: 'all', text: 'be brief' }],
    });
    expect(d.revokes).toEqual(['i1']);
    expect(d.standing_text).toBe('always answer in French');
    expect(JSON.stringify(fakeRequests[0]!.messages)).not.toContain('x'.repeat(401));
  });

  it('rethrows AbortError when aborted', async () => {
    setFakeScript(() => ({ error: 'boom' }));
    const c = new AbortController();
    c.abort();
    await expect(classifySteer(base, c.signal)).rejects.toThrow();
  });
});
