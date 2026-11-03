import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  ProviderV4,
} from '@ai-sdk/provider';
import type { ModelMessage } from 'ai';
import type { AgentId } from '../../shared/events.js';
import { fakeScripts } from './fake-scripts.js';
import type { ReqMeta } from './stream.js';

export interface FakeRequest {
  kind: ReqMeta['kind'];
  agentId?: AgentId;
  system: string;
  messages: ModelMessage[];
  prompt?: string;
}
export type FakeReply =
  | { chunks: string[]; delayMs: number }
  | { object: unknown }
  | { error: string; afterChunks?: number };

export const fakeRequests: FakeRequest[] = [];

let script: ((r: FakeRequest) => FakeReply) | undefined;
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sleep: (ms: number) => Promise<void> = realSleep;

export function setFakeScript(fn: (r: FakeRequest) => FakeReply): void {
  script = fn;
}
/** Route all fake delays through `fn` (e.g. a fast-check scheduler). */
export function setFakeSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}
export function resetFake(): void {
  fakeRequests.length = 0;
  script = undefined;
  sleep = realSleep;
}

function currentScript(): (r: FakeRequest) => FakeReply {
  if (script) return script;
  const name = process.env.FAKE_SCRIPT ?? 'default';
  return fakeScripts[name] ?? fakeScripts.default!;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  return '';
}

function capture(o: LanguageModelV4CallOptions): FakeRequest {
  const h = o.headers ?? {};
  const system = o.prompt
    .filter((m) => m.role === 'system')
    .map((m) => textOf(m.content))
    .join('\n');
  const messages = o.prompt
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: textOf(m.content) })) as unknown as ModelMessage[];
  const lastUser = [...o.prompt].reverse().find((m) => m.role === 'user');
  const req: FakeRequest = {
    kind: (h['x-req-kind'] as ReqMeta['kind'] | undefined) ?? 'reply',
    system,
    messages,
    prompt: lastUser ? textOf(lastUser.content) : undefined,
  };
  const agentId = h['x-agent-id'] as AgentId | undefined;
  if (agentId) req.agentId = agentId;
  fakeRequests.push(req);
  return req;
}

function abortError(): Error {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const stop = { unified: 'stop', raw: 'stop' } as const;

const fakeModel = (modelId: string): LanguageModelV4 => ({
  specificationVersion: 'v4',
  provider: 'fake',
  modelId,
  supportedUrls: {},

  async doGenerate(options) {
    const reply = currentScript()(capture(options));
    if ('error' in reply) throw new Error(reply.error);
    const text = 'object' in reply ? JSON.stringify(reply.object) : reply.chunks.join('');
    return {
      content: [{ type: 'text', text }],
      finishReason: stop,
      usage,
      warnings: [],
    };
  },

  async doStream(options) {
    const reply = currentScript()(capture(options));
    const signal = options.abortSignal;
    const chunks =
      'chunks' in reply ? reply.chunks : 'object' in reply ? [JSON.stringify(reply.object)] : [];
    const delayMs = 'chunks' in reply ? reply.delayMs : 0;
    const failAfter = 'error' in reply ? (reply.afterChunks ?? 0) : -1;
    const errorMsg = 'error' in reply ? reply.error : '';
    // Error replies stream "afterChunks" placeholder chunks, then fail.
    const plan = 'error' in reply ? Array.from({ length: failAfter }, (_, i) => `c${i}`) : chunks;

    const stream = new ReadableStream<LanguageModelV4StreamPart>({
      async start(controller) {
        const aborted = () => signal?.aborted === true;
        // Abort wakes the sleep immediately so nothing is emitted afterwards.
        const abortP = new Promise<'abort'>((res) => {
          if (aborted()) res('abort');
          else signal?.addEventListener('abort', () => res('abort'), { once: true });
        });
        const wait = async (ms: number) =>
          (await Promise.race([sleep(ms).then(() => 'ok' as const), abortP])) === 'abort';
        try {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: 't' });
          for (const delta of plan) {
            if (await wait(delayMs)) return controller.error(abortError());
            controller.enqueue({ type: 'text-delta', id: 't', delta });
          }
          if (await wait(0)) return controller.error(abortError());
          if ('error' in reply) return controller.error(new Error(errorMsg));
          controller.enqueue({ type: 'text-end', id: 't' });
          controller.enqueue({ type: 'finish', usage, finishReason: stop });
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return { stream };
  },
});

export const fakeProvider: ProviderV4 = {
  specificationVersion: 'v4',
  languageModel: fakeModel,
  embeddingModel: (id) => {
    throw new Error(`fake: no embedding model ${id}`);
  },
  imageModel: (id) => {
    throw new Error(`fake: no image model ${id}`);
  },
};
