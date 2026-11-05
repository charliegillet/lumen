import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { modelFor, modelProblems, modelSpec } from '../../src/server/llm/registry.js';
import { generateStructured, reasoningFor, streamChat, toWellFormed, wellFormed } from '../../src/server/llm/stream.js';
import { fakeRequests, resetFake, setFakeScript } from '../../src/server/llm/fake.js';

const ENV = ['MODEL_AGENT', 'MODEL_AGENT_MAYA', 'MODEL_GATE', 'MODEL_CLASSIFIER', 'MODEL_JUDGE', 'MODEL_REASONING'];
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

describe('reasoning', () => {
  it('is omitted for compat endpoints and when MODEL_REASONING=off', () => {
    expect(reasoningFor('openai:gpt-5.6-luna', 'low')).toBe('low');
    expect(reasoningFor('fake:x', 'none')).toBe('none');
    expect(reasoningFor('compat:llama3', 'medium')).toBeUndefined();
    process.env.MODEL_REASONING = 'off';
    expect(reasoningFor('openai:gpt-5.6-luna', 'low')).toBeUndefined();
  });

  it('streamChat sends the effort reasoning unless turned off', async () => {
    process.env.MODEL_AGENT = 'fake:x';
    setFakeScript(() => ({ chunks: ['x'], delayMs: 0 }));
    for await (const _ of streamChat({ ...base(), effort: 'medium' })) void _;
    expect(fakeRequests[0]?.reasoning).toBe('low');
    process.env.MODEL_REASONING = 'off';
    for await (const _ of streamChat({ ...base(), effort: 'medium' })) void _;
    expect(fakeRequests[1]?.reasoning ?? 'provider-default').toBe('provider-default');
  });
});

describe('structured call reasoning', () => {
  const call = (kind: 'gate' | 'dedup' | 'classify' | 'judge') =>
    generateStructured({
      role: kind === 'gate' || kind === 'dedup' ? 'gate' : 'classifier',
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      meta: { kind },
    });
  beforeEach(() => {
    process.env.MODEL_GATE = 'fake:x';
    process.env.MODEL_CLASSIFIER = 'fake:x';
    setFakeScript(() => ({ object: { ok: true } }));
  });

  it('gate, dedup and classify ask for no reasoning; the judge keeps the default', async () => {
    for (const k of ['gate', 'dedup', 'classify', 'judge'] as const) await call(k);
    expect(fakeRequests.map((r) => r.reasoning ?? 'provider-default')).toEqual([
      'none',
      'none',
      'none',
      'provider-default',
    ]);
  });

  it('follows the compat / MODEL_REASONING=off rule', async () => {
    process.env.MODEL_REASONING = 'off';
    await call('classify');
    expect(fakeRequests[0]?.reasoning ?? 'provider-default').toBe('provider-default');
  });

  it('logs classify latency outside tests only', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await call('classify');
    expect(info).not.toHaveBeenCalled();
    const saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    try {
      await call('classify');
      await call('gate');
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toMatch(/^classify model=fake:x ok=true ms=\d+$/);
    info.mockRestore();
  });
});

describe('model configuration', () => {
  const KEYS = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'OPENAI_COMPAT_BASE_URL'];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('treats a blank override as unset', () => {
    process.env.MODEL_AGENT_MAYA = '';
    process.env.MODEL_GATE = '';
    expect(modelSpec('agent', 'maya')).toBe('openai:gpt-5.6-luna');
    expect(modelSpec('gate')).toBe('openai:gpt-5.6-luna');
  });

  it('reports bad specs and missing keys, and nothing for a good setup', () => {
    for (const k of KEYS) delete process.env[k];
    expect(modelProblems().join('\n')).toMatch(/OPENAI_API_KEY/);
    process.env.OPENAI_API_KEY = 'k';
    expect(modelProblems()).toEqual([]);
    process.env.MODEL_AGENT = 'nonsense';
    process.env.MODEL_GATE = 'anthropic:x';
    process.env.MODEL_CLASSIFIER = 'compat:x';
    const msg = modelProblems().join('\n');
    expect(msg).toMatch(/agent maya: "nonsense" is not a provider:model/);
    expect(msg).toMatch(/gate: .*ANTHROPIC_API_KEY/);
    expect(msg).toMatch(/classifier: .*OPENAI_COMPAT_BASE_URL/);
    process.env.MODEL_AGENT = 'fake:x';
    process.env.MODEL_GATE = 'fake:x';
    process.env.MODEL_CLASSIFIER = 'fake:x';
    expect(modelProblems()).toEqual([]);
  });

  it('wellFormed replaces lone surrogates in string and part content', () => {
    const out = wellFormed([
      { role: 'user', content: 'a \ud83d b' },
      { role: 'assistant', content: [{ type: 'text', text: 'c \ude00 d' }] },
    ]);
    expect(out[0]!.content).toBe('a \ufffd b');
    expect((out[1]!.content as { text: string }[])[0]!.text).toBe('c \ufffd d');
    expect(toWellFormed('ok \ud83d\ude00 \ud83d')).toBe('ok \ud83d\ude00 \ufffd');
  });
});

describe('compat provider over HTTP', () => {
  const real = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = real;
    delete process.env.OPENAI_COMPAT_BASE_URL;
    delete process.env.OPENAI_COMPAT_STRUCTURED;
  });
  const reply = (content: string) =>
    new Response(
      JSON.stringify({
        id: 'x',
        created: 1,
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('retries a 429, sends the schema when OPENAI_COMPAT_STRUCTURED=1, and strips <think>', async () => {
    process.env.OPENAI_COMPAT_BASE_URL = 'http://compat.test/v1';
    process.env.OPENAI_COMPAT_STRUCTURED = '1';
    process.env.MODEL_CLASSIFIER = 'compat:m';
    const bodies: string[] = [];
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) return new Response('slow down', { status: 429, headers: { 'retry-after-ms': '1' } });
      return reply('<think>hmm</think>{"ok":true}');
    }) as typeof fetch;
    const out = await generateStructured({
      role: 'classifier',
      system: 's',
      prompt: 'p',
      schema: z.object({ ok: z.boolean() }),
      meta: { kind: 'classify' },
    });
    expect(out).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatch(/json_schema/);
  });
});
