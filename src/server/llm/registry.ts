import { createProviderRegistry, type LanguageModel } from 'ai';
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
        (agentId ? env[`MODEL_AGENT_${agentId.toUpperCase()}`] : undefined) ??
        env.MODEL_AGENT ??
        'openai:gpt-6-luna'
      );
    case 'gate':
      return env.MODEL_GATE ?? 'openai:gpt-6-luna';
    case 'classifier':
      return env.MODEL_CLASSIFIER ?? 'openai:gpt-6-luna';
    case 'judge':
      return env.MODEL_JUDGE ?? 'openai:gpt-6-sol';
  }
}

// Provider factories only read API keys when a request is made, so building the
// registry without keys is safe (tests run keyless).
let registry: ReturnType<typeof buildRegistry> | undefined;
function buildRegistry() {
  return createProviderRegistry({
    openai: createOpenAI(),
    anthropic: createAnthropic(),
    google: createGoogleGenerativeAI(),
    compat: createOpenAICompatible({
      name: 'compat',
      baseURL: process.env.OPENAI_COMPAT_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: process.env.OPENAI_COMPAT_API_KEY,
    }),
    fake: fakeProvider,
  });
}

export function modelFor(role: Role, agentId?: AgentId): LanguageModel {
  registry ??= buildRegistry();
  return registry.languageModel(modelSpec(role, agentId) as Parameters<ReturnType<typeof buildRegistry>['languageModel']>[0]);
}
