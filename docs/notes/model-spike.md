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

## Results (2026-11-03, 5 runs per row)
Model IDs confirmed on the key: `gpt-6-luna`, `gpt-5.6-luna`, `gpt-6-sol`.

| model | reasoning | median TTFT ms | median total ms |
|---|---|---|---|
| gpt-6-luna (run 1) | none | 1050 | 1575 |
| gpt-6-luna (run 1) | low | 657 | 1184 |
| gpt-6-luna (run 2) | none | 722 | 1292 |
| gpt-6-luna (run 2) | low | 518 | 1150 |
| gpt-5.6-luna | none | 593 | 1161 |
| gpt-5.6-luna | low | 647 | 1307 |

Abort: `abort ok` (42 and 45 deltas before abort, 0 after) on two runs; one gpt-6-luna run produced no text within the 1 s window, so that run's check was inconclusive.

**Decision:** gpt-6-luna's lowest reasoning level (`none`) exceeded the 700 ms threshold in both runs, so the default is `openai:gpt-5.6-luna` (fastest measured at `none`). gpt-6-luna remains a one-line env swap. TTFT variance between runs is large (n=5), so log TTFT in the app as well.

## Conventions
Server code (`src/shared`, `src/server`) is built with NodeNext ESM (`tsconfig.server.json`), so relative imports must include the `.js` extension (e.g. `import { x } from './db.js'`).
