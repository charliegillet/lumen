import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { modelFor, modelSpec } from '../../src/server/llm/registry.js';
import { generateStructured, streamChat } from '../../src/server/llm/stream.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';

const ENV = ['MODEL_AGENT', 'MODEL_AGENT_MAYA', 'MODEL_GATE', 'MODEL_CLASSIFIER', 'MODEL_JUDGE'];
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  resetFake();
});
afterEach(() => {
  for (const k of ENV) delete process.env[k];
});

const base = (signal = new AbortController().signal) => ({
  role: 'agent' as const,
  agentId: 'maya' as const,
  system: 'sys',
  messages: [{ role: 'user' as const, content: 'hi' }],
  signal,
  effort: 'low' as const,
  meta: { kind: 'reply' as const, agentId: 'maya' as const },
});

describe('modelSpec', () => {
  it('defaults and overrides', () => {
    expect(modelSpec('agent', 'maya')).toBe('openai:gpt-5.6-luna');
    expect(modelSpec('gate')).toBe('openai:gpt-5.6-luna');
    expect(modelSpec('classifier')).toBe('openai:gpt-5.6-luna');
    expect(modelSpec('judge')).toBe('openai:gpt-6-sol');
    process.env.MODEL_AGENT_MAYA = 'fake:maya';
    expect(modelSpec('agent', 'maya')).toBe('fake:maya');
    process.env.MODEL_AGENT = 'anthropic:claude-haiku-5-5';
    expect(modelSpec('agent', 'theo')).toBe('anthropic:claude-haiku-5-5');
  });
});

describe('modelFor compat', () => {
  afterEach(() => {
    delete process.env.OPENAI_COMPAT_BASE_URL;
  });

  it('throws without OPENAI_COMPAT_BASE_URL', () => {
    delete process.env.OPENAI_COMPAT_BASE_URL;
    process.env.MODEL_GATE = 'compat:llama3';
    expect(() => modelFor('gate')).toThrow(/OPENAI_COMPAT_BASE_URL/);
  });

  it('builds a model when the base URL is set', () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://example.test/v1';
    process.env.MODEL_GATE = 'compat:llama3';
    const m = modelFor('gate');
    expect(typeof m === 'object' && m.modelId).toBe('llama3');
  });
});

describe('fake provider', () => {
  beforeEach(() => {
    process.env.MODEL_AGENT = 'fake:x';
    process.env.MODEL_GATE = 'fake:x';
  });

  it('streams chunks with delay', async () => {
    setFakeScript(() => ({ chunks: ['a', 'b', 'c'], delayMs: 10 }));
    let out = '';
    for await (const t of streamChat(base())) out += t;
    expect(out).toBe('abc');
  });

  it('honors abort', async () => {
    setFakeScript(() => ({ chunks: Array.from({ length: 20 }, (_, i) => String(i)), delayMs: 50 }));
    const ac = new AbortController();
    const got: string[] = [];
    let abortedAt = 0;
    setTimeout(() => {
      abortedAt = got.length;
      ac.abort();
    }, 120);
    try {
      for await (const t of streamChat(base(ac.signal))) got.push(t);
    } catch (e) {
      expect((e as Error).name).toBe('AbortError');
    }
    expect(got.length).toBeLessThan(5);
    expect(got.length).toBe(abortedAt);
  });

  it('records meta', async () => {
    setFakeScript(() => ({ chunks: ['x'], delayMs: 0 }));
    for await (const _ of streamChat(base())) void _;
    expect(fakeRequests[0]?.kind).toBe('reply');
    expect(fakeRequests[0]?.agentId).toBe('maya');
    expect(fakeRequests[0]?.system).toBe('sys');
  });

  it('generateStructured parses fake object', async () => {
    setFakeScript(() => ({ object: { n: 3, s: 'ok' } }));
    const r = await generateStructured({
      role: 'gate',
      system: 's',
      prompt: 'p',
      schema: z.object({ n: z.number(), s: z.string() }),
      meta: { kind: 'gate' },
    });
    expect(r).toEqual({ n: 3, s: 'ok' });
    expect(fakeRequests[0]?.kind).toBe('gate');
    expect(fakeRequests[0]?.prompt).toBe('p');
  });

  it('error after chunks', async () => {
    setFakeScript(() => ({ error: '429', afterChunks: 2 }));
    const got: string[] = [];
    await expect(
      (async () => {
        for await (const t of streamChat(base())) got.push(t);
      })(),
    ).rejects.toThrow(/429/);
    expect(got).toHaveLength(2);
  });
});
