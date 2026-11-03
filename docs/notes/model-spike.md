# Model spike

## Installed versions
- ai 7.0.162, @ai-sdk/openai 4.0.108, @ai-sdk/openai-compatible 3.0.84
- zod 4.6.7, hono 4.13.16, @hono/node-server 2.1.6, better-sqlite3 13.0.3
- typescript 7.0.2, vitest 4.1.12, vite 8.3.5, @playwright/test 1.64.1

## Reasoning mechanism
AI SDK v7 `streamText` accepts a top-level `reasoning` option
(`'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`, from `CallSettings` in `ai/dist/index.d.ts`).
`@ai-sdk/openai` also still exposes `providerOptions.openai.reasoningEffort` (`none|low|medium|high|xhigh|max|minimal`).
`scripts/spike-ttft.ts` uses the top-level `reasoning` option and typechecks against it.
Whether the API accepts `none` for gpt-6-luna is confirmed only once the spike runs (below).

## Results
PENDING: run `npm run spike` once OPENAI_API_KEY is set in `.env`.

To do after the run:
1. Confirm `gpt-6-luna` exists: `curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | grep -o '"id": *"gpt-[^"]*luna[^"]*"'`
2. Paste the TTFT table and the `abort ok` line here.
3. Decision rule: if median TTFT at the lowest reasoning level is over 700 ms, set `gpt-5.6-luna` as the default in `.env.example` and re-run (`SPIKE_MODEL=gpt-5.6-luna npm run spike`).

## Conventions
Server code (`src/shared`, `src/server`) is built with NodeNext ESM (`tsconfig.server.json`), so relative imports must include the `.js` extension (e.g. `import { x } from './db.js'`).
