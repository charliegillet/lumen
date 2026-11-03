import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/server/db.js';
import { ConversationActor } from '../../src/server/actor.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';
import { runGate } from '../../src/server/orchestrator/gate.js';
import { clusterGists } from '../../src/server/orchestrator/dedup.js';
import { PERSONAS } from '../../src/server/agents/personas.js';
import { publicRoster } from '../../src/server/agents/prompt.js';
import type { Bid } from '../../src/server/orchestrator/gate.js';

let actor: ConversationActor;
beforeEach(() => {
  process.env.MODEL_GATE = 'fake:x';
  resetFake();
  actor = new ConversationActor(openDb(':memory:'), 'c1');
  actor.append({ type: 'user_message', messageId: 'u1', clientMsgId: 'c1', text: 'what should we do?' });
});
afterEach(() => resetFake());

const SAFE = { should_respond: false, novelty: 0, gist: '', addresses: [], effort: 'low' };
const sig = () => new AbortController().signal;

describe('runGate', () => {
  it('invalid JSON gives the safe default', async () => {
    setFakeScript(() => ({ chunks: ['not json {{'], delayMs: 0 }));
    const b = await runGate(actor, 'maya', actor.lastSeq, 0, sig());
    expect(b).toEqual({ agentId: 'maya', ...SAFE });
  });

  it('LLM error gives the safe default; schema mismatch too', async () => {
    setFakeScript(() => ({ error: 'boom' }));
    expect(await runGate(actor, 'theo', actor.lastSeq, 0, sig())).toEqual({ agentId: 'theo', ...SAFE });
    setFakeScript(() => ({ object: { should_respond: 'yes' } }));
    expect(await runGate(actor, 'theo', actor.lastSeq, 0, sig())).toEqual({ agentId: 'theo', ...SAFE });
  });

  it('request has roster and no other agent canary', async () => {
    setFakeScript(() => ({ object: { should_respond: true, novelty: 2, gist: 'x', addresses: ['user'], effort: 'low' } }));
    const b = await runGate(actor, 'maya', actor.lastSeq, 0, sig());
    expect(b.should_respond).toBe(true);
    expect(b.agentId).toBe('maya');
    const req = fakeRequests.find((r) => r.kind === 'gate')!;
    expect(req.agentId).toBe('maya');
    const all = req.system + JSON.stringify(req.messages);
    expect(all).toContain(publicRoster());
    expect(all).not.toContain(PERSONAS.theo.canary);
    expect(all).not.toContain(PERSONAS.priya.canary);
  });

  it('coerces addresses and trims gist', async () => {
    setFakeScript(() => ({
      object: { should_respond: true, novelty: 1, gist: 'g'.repeat(250), addresses: ['theo', 'bob', 'user'], effort: 'high' },
    }));
    const b = await runGate(actor, 'maya', actor.lastSeq, 0, sig());
    expect(b.gist).toHaveLength(200);
    expect(b.addresses).toEqual(['theo', 'user']);
  });

  it('rethrows AbortError when aborted', async () => {
    setFakeScript(() => ({ error: 'x' }));
    const c = new AbortController();
    c.abort();
    await expect(runGate(actor, 'maya', actor.lastSeq, 0, c.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

const bid = (agentId: Bid['agentId'], should_respond = true): Bid => ({
  agentId, should_respond, novelty: 2, gist: `${agentId} says X`, addresses: [], effort: 'low',
});

describe('clusterGists', () => {
  it('skips the LLM with fewer than 2 responding bids', async () => {
    const r = await clusterGists([bid('maya'), bid('theo', false)], sig());
    expect(r).toEqual([['maya']]);
    expect(fakeRequests).toHaveLength(0);
  });

  it('clusters from the model; prompt only has gists', async () => {
    setFakeScript(() => ({ object: { clusters: [['maya', 'theo'], ['priya']] } }));
    const r = await clusterGists([bid('maya'), bid('theo'), bid('priya')], sig());
    expect(r).toEqual([['maya', 'theo'], ['priya']]);
    const req = fakeRequests[0]!;
    expect(req.kind).toBe('dedup');
    expect(req.prompt).toContain('maya: maya says X');
    expect(req.system + req.prompt).not.toMatch(/CANARY/);
  });

  it('repairs missing, unknown and duplicate ids', async () => {
    setFakeScript(() => ({ object: { clusters: [['maya', 'zed', 'maya'], ['maya', 'theo']] } }));
    const r = await clusterGists([bid('maya'), bid('theo'), bid('priya')], sig());
    expect(r).toEqual([['maya'], ['theo'], ['priya']]);
  });

  it('returns singletons on failure', async () => {
    setFakeScript(() => ({ error: 'boom' }));
    const r = await clusterGists([bid('maya'), bid('theo')], sig());
    expect(r).toEqual([['maya'], ['theo']]);
  });
});
