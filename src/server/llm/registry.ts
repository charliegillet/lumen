import { createProviderRegistry, extractReasoningMiddleware, wrapLanguageModel, type LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { AgentId } from '../../shared/events.js';
import { fakeProvider } from './fake.js';

export type Role = 'agent' | 'gate' | 'classifier' | 'judge';

/** `provider:modelId` for a role. Env is read at call time so tests can set it. */
export function modelSpec(role: Role, agentId?: AgentId): string {
  const env = process.env;
  switch (role) {
    case 'agent':
      return (
        (agentId ? env[`MODEL_AGENT_${agentId.toUpperCase()}`] : undefined) ||
        env.MODEL_AGENT ||
        'openai:gpt-5.6-luna'
      );
    case 'gate':
      return env.MODEL_GATE || 'openai:gpt-5.6-luna';
    case 'classifier':
      return env.MODEL_CLASSIFIER || 'openai:gpt-5.6-luna';
    case 'judge':
      return env.MODEL_JUDGE || 'openai:gpt-6-sol';
  }
}

const KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

/** Why a `provider:model` spec cannot work, or null when it looks usable. Checks the string and the key, not the network. */
export function specProblem(spec: string): string | null {
  const i = spec.indexOf(':');
  const provider = i > 0 ? spec.slice(0, i) : '';
  const id = i > 0 ? spec.slice(i + 1) : '';
  if (!id) return `"${spec}" is not a provider:model string (providers: openai, anthropic, google, compat, fake)`;
  if (provider === 'fake') return null;
  if (provider === 'compat') {
    return process.env.OPENAI_COMPAT_BASE_URL ? null : `"${spec}" needs OPENAI_COMPAT_BASE_URL to be set`;
  }
  const key = KEY_ENV[provider];
  if (!key) return `"${spec}" has an unknown provider "${provider}" (use openai, anthropic, google, compat or fake)`;
  return process.env[key] ? null : `"${spec}" needs ${key} to be set`;
}

/** Every configuration problem for the models the chat itself uses (the judge is eval-only). Empty when fine. */
export function modelProblems(): string[] {
  const roles: [string, string][] = [
    ...(['maya', 'theo', 'priya'] as const).map((a): [string, string] => [`agent ${a}`, modelSpec('agent', a)]),
    ['gate', modelSpec('gate')],
    ['classifier', modelSpec('classifier')],
  ];
  return roles.flatMap(([role, spec]) => {
    const p = specProblem(spec);
    return p ? [`${role}: ${p}`] : [];
  });
}

// Provider factories only read API keys when a request is made, so building the
// registry without keys is safe (tests run keyless).
let registry: ReturnType<typeof buildRegistry> | undefined;
function buildRegistry() {
  return createProviderRegistry({
    openai: createOpenAI(),
    anthropic: createAnthropic(),
    google: createGoogleGenerativeAI(),
    fake: fakeProvider,
  });
}

export function modelFor(role: Role, agentId?: AgentId): LanguageModel {
  const spec = modelSpec(role, agentId);
  if (spec.startsWith('compat:')) return compatModel(spec);
  registry ??= buildRegistry();
  return registry.languageModel(spec as Parameters<ReturnType<typeof buildRegistry>['languageModel']>[0]);
}

/** Built per call so the base URL is read from env at request time, never a guessed default. */
function compatModel(spec: string): LanguageModel {
  const baseURL = process.env.OPENAI_COMPAT_BASE_URL;
  if (!baseURL) {
    throw new Error(`model "${spec}" requires OPENAI_COMPAT_BASE_URL to be set`);
  }
  const model = createOpenAICompatible({
    name: 'compat',
    baseURL,
    apiKey: process.env.OPENAI_COMPAT_API_KEY,
    // Without this the structured calls send json_object with no schema, which small local models answer in free form.
    supportsStructuredOutputs: process.env.OPENAI_COMPAT_STRUCTURED === '1',
  }).languageModel(spec.slice('compat:'.length));
  // Local reasoning models stream their thinking inline as <think>...</think>.
  return wrapLanguageModel({ model, middleware: extractReasoningMiddleware({ tagName: 'think' }) });
}
