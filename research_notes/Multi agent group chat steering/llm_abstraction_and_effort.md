# LLM Abstraction Layers and Adaptive Effort Routing (for a 24h multi-agent group-chat build)

Research date: 2026-11-03. Model/API landscape has moved a lot in 2026: current Anthropic models are Claude Opus 5.5 / Sonnet 5.5 / Haiku 5.5 (plus Fable/Mythos tiers), Gemini 3.x (3.8 Flash, 3.5 Flash-Lite, 3.1 Pro preview), OpenAI GPT-5.x, and Vercel AI SDK v7 is current (v6 still widely used). Several things the brief assumes (assistant prefill, `budget_tokens` thinking, `temperature`) are now **removed or 400-erroring on current Claude models**. See flags below.

## Q1. Abstraction options compared (streaming, real cancellation, prefill, structured output, config-based swapping, maturity, gotchas)

### Takeaway
For TypeScript, Vercel AI SDK (v6/v7) is the strongest fit: `provider:model` string IDs via `createProviderRegistry`, `abortSignal` that cancels the upstream LLM call, `onAbort` with completed steps for persisting partial text, and (v7) a provider-agnostic top-level `reasoning` option. For Python, LiteLLM is the pragmatic choice for config-based swapping and cross-provider `reasoning_effort` translation, but its upstream cancellation on stream abort is not clearly documented — you must own cancellation (cancel the asyncio task / close the stream) yourself.

### Cited Findings
**Vercel AI SDK**
- `createProviderRegistry` takes a record of providers keyed by prefix; models are addressed as `providerId:modelId` (e.g. `registry.languageModel('openai:...')`); default separator `:` is configurable (e.g. `' > '`); TypeScript infers valid IDs; `languageModelMiddleware` option wraps all models from the registry. Page references V4 interface types (e.g. `VideoModelV4`) — i.e. current major version is newer than v5. — [AI SDK provider registry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry)
- Plain string model IDs default to Vercel AI Gateway when no default provider is configured (noted on the registry page for experimental decision models). — [AI SDK provider registry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry)
- Cancellation: pass `abortSignal` to `streamText` (e.g. `abortSignal: req.signal`) to cancel "from the server side to the LLM API". `onAbort` fires only on AbortSignal abort (not normal finish) and receives `steps` completed before the abort — usable to persist partial results; an `abort` stream part can also be observed in a `for await` loop. — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- Client `useChat().stop()` only aborts the client HTTP request; server-side generation stops only if the runtime propagates the disconnect to `req.signal` and the route forwards it. On Vercel this needs Node runtime + `"supportsCancellation": true` in `vercel.json`; otherwise "server-side generation may continue". — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- `toUIMessageStream` `onEnd` gets `isAborted`; pass `consumeStream` as `consumeSseStream` to make sure the stream is consumed when aborted. Distinguish `isCancelled` (consumer cancel) vs `isAborted`. — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- **Gotcha:** "Stream abort functionality is not compatible with stream resumption" — choose abort OR `resume: true`, not both. AI SDK RSC does not support stopping streams. — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- **Version change (v6 → v7):** top-level `reasoning` option and the `stream` property require AI SDK 7+; on v6 configure reasoning via `providerOptions` and iterate `result.fullStream` (renamed `stream` in v7). OpenAI: `providerOptions.openai.reasoningEffort`; Anthropic adaptive form `thinking: { type: 'adaptive', effort: 'high' }`. Provider options take full precedence over top-level `reasoning`. — [Vercel AI Gateway reasoning docs](https://vercel.com/docs/ai-gateway/models-and-providers/reasoning); [AI SDK provider options](https://ai-sdk.dev/docs/foundations/provider-options)

**LiteLLM (Python SDK + proxy)**
- Translates a unified `reasoning_effort` across providers. Anthropic pre-4.6: maps to `thinking.budget_tokens` — minimal 1024, low 1024, medium 2048, high 4096, xhigh 8192, max 16384 (override with `DEFAULT_REASONING_EFFORT_*_THINKING_BUDGET` env vars); `effort: "none"` disables thinking. Claude 4.6+: sends `thinking: {type: "adaptive"}` + `output_config.effort` (minimal→low), chosen via the model's `supports_adaptive_thinking` capability, not name. — [LiteLLM reasoning_content docs](https://docs.litellm.ai/docs/reasoning_content)
- For `gpt-5.4+` requests with both `reasoning_effort` and `tools`, LiteLLM auto-routes through the Responses API bridge; since v1.108.0 deployments can declare `reasoning_effort_levels` and LiteLLM rounds requested levels to supported ones. — [LiteLLM reasoning_content docs](https://docs.litellm.ai/docs/reasoning_content)
- **Gotcha:** with Anthropic thinking + tool calls, the prior assistant message must include `thinking_blocks` or the request 400s, unless `litellm.modify_params = True` (which drops `thinking` for that turn). — [LiteLLM reasoning_content docs](https://docs.litellm.ai/docs/reasoning_content)
- Cancellation: I found no LiteLLM doc/issue confirming that cancelling a streaming `acompletion` closes the upstream connection. Old issue #957 (2023) shows httpx surfacing `asyncio.CancelledError` under concurrency. Downstream projects (OpenHands) wrap LiteLLM streams with their own cancel checks between chunks / background cancel tasks. — [LiteLLM #957](https://github.com/BerriAI/litellm/issues/957); [OpenHands async_llm.py mirror](https://huggingface.co/spaces/Backup-bdg/OpenHands/blob/main/openhands/llm/async_llm.py)
- Related pitfall in another stack: llama-stack called `aclose()` on an OpenAI `AsyncStream` (which lacks it), breaking cleanup on client cancel; fix was the stream's async `close()`. — [llama-stack commit mirror](https://git.kvant.cloud/phoenix-oss/llama-stack-mirror/commit/c574db5f1d889533d5e33ab60dd0e9abe6109772)

**OpenRouter**
- Single OpenAI-compatible API; supports "Assistant Prefill" by putting a `role: "assistant"` message last in `messages`. — [OpenRouter API reference](https://openrouter.ai/docs/api/reference/overview)
- (OpenRouter passes the trailing-assistant message through; whether the *underlying* model honors it depends on that model — see Q2: current Claude models reject it.)

**RouteLLM serves through LiteLLM** (relevant to routing, see Q4) — [RouteLLM repo](https://github.com/lm-sys/RouteLLM)

### Inferences
- **AI SDK is the only option here with documented, end-to-end upstream abort semantics** (abortSignal → provider fetch → `onAbort(steps)`). That maps exactly onto "user interrupts agent → abort → restart with partial text". In a non-Vercel Node server (Express/Fastify/Hono), create one `AbortController` per agent stream and call `.abort()` on interrupt; don't rely on client disconnect.
- Config-swap pattern (TS): `MODEL_AGENT_A=anthropic:claude-haiku-5-5`, `MODEL_AGENT_B=google:gemini-3.8-flash`, `MODEL_ROUTER=openai:gpt-5.x-mini` → `registry.languageModel(process.env.MODEL_AGENT_A)`. Adding an OpenAI-compatible provider (`createOpenAICompatible`, Groq/Cerebras/OpenRouter/local) covers "any LLM".
- Config-swap pattern (Python): LiteLLM `model="anthropic/claude-haiku-5-5"` strings from env/YAML; or run the LiteLLM proxy and point the plain OpenAI SDK at it (`base_url`). For cancellation, run each agent stream in its own `asyncio.Task` and `task.cancel()` + explicitly close the underlying stream in `finally`.
- Plain "OpenAI-compatible `base_url`" (OpenRouter, LiteLLM proxy, Groq, Cerebras, Gemini's OpenAI-compat endpoint) gives the thinnest abstraction: abort works via the OpenAI SDK's `signal`/`AbortController` (TS) or closing the httpx stream (Python), but reasoning/thinking knobs and structured output vary per backend and you lose provider-native features.
- LangChain/LangChain.js, Mastra, Pydantic AI: not researched in depth within budget. Mastra is built on top of the AI SDK (so inherits its model strings/abort); Pydantic AI uses `provider:model` strings (e.g. `anthropic:...`) natively. These are recollection, not verified this session — treat as gaps. For a 24h build, the extra agent-framework layer adds little because the orchestration (who speaks, interrupts) is custom anyway.

### Gaps
- Did not verify current LangChain.js / Mastra / Pydantic AI docs on abort propagation, prefill handling, or model-string syntax.
- No authoritative confirmation that LiteLLM (SDK or proxy) closes the upstream provider connection when a streaming request is cancelled; test this empirically (watch provider usage/billing or server logs) before relying on it.
- AI SDK `generateObject`/`streamObject` vs v6+ `output` on `generateText` (structured output API shape) not re-verified this session.

## Q2. Assistant prefill support across providers, and what breaks when swapping

### Takeaway
**Assistant prefill is effectively dead on current Claude models**: Claude 4.6+ (Opus 4.6, Sonnet 4.6) and Haiku 5.5 return HTTP 400 if `messages` ends with an assistant turn — even with thinking off. Anthropic's own recommended replacement for "continuations" is to move the partial text into a user message ("Your previous response was interrupted and ended with `[previous_response]`. Continue from where you left off."). Design the interrupt/redirect flow around that, not prefill.

### Cited Findings
- Claude Haiku 5.5 migration guide: "Claude Haiku 4.5 accepts [a prefill] when thinking is off. Claude Haiku 5.5 rejects it with a 400 error, even with thinking turned off. End `messages` with a user turn." Replacements: output format → structured outputs / tools with enum fields; preambles → system prompt; **continuations → move into user message** ("Your previous response was interrupted and ended with `[previous_response]`. Continue from where you left off."); context reminders → user turn. — [Claude Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- Anthropic migration docs: prefilled assistant messages return 400 on Claude 4.6 models (Opus 4.6, Sonnet 4.6); recommended replacements are structured outputs, system prompt instructions, `output_config.format`. — [Anthropic migration guide (de)](https://platform.claude.com/docs/de/about-claude/models/migration-guide) (via search summary)
- Reported error string: "Prefilling assistant messages is not supported for this model." (third-party; not confirmed in Anthropic docs). Claude Code itself hit 400s on Opus 4.6 because of prefills. — [laozhang blog](https://blog.laozhang.ai/en/posts/claude-opus-prefill-error-fix); [claudeissues #28478](https://claudeissues.com/issue/28478-bug-claude-code-prefilling-assistant-messages-when-using-opus-4-6)
- Agno framework's fix: automatically inject a trailing user message when a conversation ends with an assistant turn on a model that doesn't support prefill. — [Agno changelog](https://www.agno.com/changelog/fix-assistant-message-prefill-compatibility-for-claude-4-6-across-all-providers)
- Other Haiku 5.5 breaking changes that bite when swapping models by config: `thinking: {type:"enabled", budget_tokens:N}` → 400 (use `adaptive` + effort); **`temperature`, `top_p`, `top_k` must be removed**; adaptive thinking on by default so the first content block may be `thinking` (select blocks by `type`); thinking tokens count toward `max_tokens` so a small `max_tokens` can end with `stop_reason: "max_tokens"` before any text; forced `tool_choice` skips thinking; handle `stop_reason: "refusal"`; ~30% more tokens than Haiku 4.5 for same text (new tokenizer); thinking blocks must be replayed append-only (prefix change → 400 on accounts created after 2026-08-31). — [Claude Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- Opus 5.5: adaptive thinking always on; `thinking: {"type":"disabled"}` → 400 at every effort level. Sonnet 5.5: use `thinking: {"type":"between_tools"}` to turn off up-front thinking (only at low/medium/high). — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- OpenRouter documents prefill as a generic feature (trailing assistant message). — [OpenRouter API reference](https://openrouter.ai/docs/api/reference/overview)
- Gemini: `max_output_tokens` includes thinking tokens; hitting the limit while reasoning yields status "incomplete". — [Gemini thinking docs](https://aistudio.google.com/docs/thinking)

### Inferences
- **Recommended provider-agnostic continuation pattern** for "interrupt/redirect takes effect in the same answer": on interrupt, abort the stream, keep the partial text visible in the UI as the start of the same bubble, then restart with history + a *user* turn like: `[Interrupted. Your reply so far: "<partial>". The user now says: "<redirect>". Continue the same message from exactly where it stopped, adjusting per the redirect; do not repeat what you already wrote.]` Append new tokens to the same bubble. This works identically on Claude, OpenAI, Gemini, Groq — no prefill dependency. Optionally keep a per-model capability flag `supportsPrefill` and use true prefill only on models that still honor it (some open-weight models via OpenAI-compatible hosts), but don't make the design depend on it.
- OpenAI Chat Completions / Responses do not provide a true "continue this assistant message" prefill (a trailing assistant message is treated as a completed prior turn) — from prior knowledge, not verified this session.
- Things that break when swapping models by config (build a small per-model "quirks" map): sampling params (Claude 5.x rejects them; OpenAI reasoning models also historically reject `temperature`), thinking config shape, `max_tokens` needing headroom for hidden thinking, reasoning/thinking content parts appearing in the stream (filter by part type), system-prompt placement (AI SDK normalizes), and JSON/structured output modes (use the SDK's schema-based structured output rather than provider JSON mode).

### Gaps
- Did not verify Gemini 3.x or GPT-5.x behaviour with a trailing assistant/model turn.
- Did not verify which Groq/Cerebras-hosted open models honor prefill via the OpenAI-compatible API.

## Q3. Latency (TTFT) and rate limits for 3–4 concurrent streams + gating calls

### Takeaway
Reliable, current, non-reasoning TTFT numbers were hard to find; most published 2026 numbers mix in reasoning time (time-to-first-*answer*-token of 10–20s for reasoning-mode small models). The practical lever is to **run chat agents at the lowest effort / thinking off-or-minimal** so TTFT stays sub-second-ish; Groq/Cerebras remain the low-latency outliers (~0.2–0.4s reported).

### Cited Findings
- Artificial Analysis comparison lists Gemini 3.6 Flash (high) at 15.67s vs Claude 4.5 Haiku (Reasoning) at 18.99s time-to-first-answer-token — reasoning time included. — [Artificial Analysis (ko)](https://artificialanalysis.ai/ko/models/comparisons/gemini-3-6-flash-vs-claude-4-5-haiku-reasoning) (via search summary)
- Artificial Analysis Haiku 5.5 (medium) vs Gemini 3.8 Flash (medium): blended price $0.077 vs $0.5775 per 1M tokens (as extracted; seems low for Haiku — verify), Intelligence Index 25 vs 30; a 13.81s TTFT and 168 tok/s were shown but not clearly attributable to one model. — [Artificial Analysis comparison](https://artificialanalysis.ai/models/comparisons/claude-haiku-5-5-medium-vs-gemini-3-8-flash-medium)
- Developer test (2025 models): Claude Haiku 4.5 first token ~597ms; Gemini slightly faster; GPT-4.1 mini ~2,400ms. — [kunalganglani.com latency benchmarks](https://www.kunalganglani.com/blog/llm-api-latency-benchmarks-2026.md)
- Third-party blog: Cerebras ~0.18s TTFT P50 (Qwen 3 235B), Groq ~0.18s; another says Groq consistently sub-400ms. GPT-5.5 Mini listed at 0.61s TTFT (source unclear). — [digitalapplied 2026 latency](https://www.digitalapplied.com/blog/ai-model-latency-benchmarks-2026-ttft-throughput); [fast.io](https://www.fast.io/resources/fastest-ai-2026.md)
- Claude Haiku 5.5 default effort is `medium` with adaptive thinking on; Anthropic recommends `low` "for chat, short tool tasks, and simple, high-volume requests". Sonnet 4.6 defaults to `high` — "explicitly set effort ... to avoid unexpected latency". — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Gemini 3.8 Flash default thinking `medium` (levels low/medium/high, no minimal); Gemini 3.5 Flash-Lite defaults to `minimal`; Gemini 2.5 Flash-Lite thinking off by default. — [Gemini thinking docs](https://aistudio.google.com/docs/thinking)

### Inferences
- Default effort on new small models is *not* "fast": Haiku 5.5 and Gemini 3.8 Flash both default to medium thinking. For a group chat, explicitly set `low`/`minimal`/`none` on agent replies and on the gating/classifier call, or TTFT will be seconds, not hundreds of ms.
- Per user message, expect 1 gating/router call + 3–4 agent streams (+ restarts on interrupt) ≈ 5–8 requests within a second or two. Spreading agents across providers (e.g. one Claude, one Gemini, one Groq/OpenAI) both demonstrates swappability and avoids hitting a single provider's RPM / concurrent-request limit on low-tier accounts. Put an exponential-backoff retry on 429 and a per-provider concurrency semaphore.
- Measure TTFT yourself in-app (log time from request start to first text delta, per model) — it's cheap and gives a defensible slide/README number.

### Gaps
- No verified, current (Nov 2026) non-reasoning TTFT table for Haiku 5.5, Gemini 3.8 Flash, GPT-5.x mini; Artificial Analysis pages didn't render per-model TTFT cleanly.
- Did not retrieve current rate-limit tiers (RPM/TPM) for Anthropic/OpenAI/Google entry tiers.

## Q4. Adaptive effort: deciding effort before answering, keeping it provider-agnostic

### Takeaway
Effort controls are now first-class and converging on the same vocabulary (`none/minimal/low/medium/high/xhigh/max`) across Anthropic (`output_config.effort`), OpenAI (`reasoning_effort`), Gemini (`thinking_level`), and both abstraction layers (AI SDK v7 top-level `reasoning`, LiteLLM `reasoning_effort`). The simplest robust design: one cheap structured-output router call → `{effort: "low"|"medium"|"high", maxWords, ...}` → map to (a) the unified reasoning level, (b) `max_tokens`, and (c) an explicit length instruction in the prompt. Prompt-level length guidance is what actually makes a light question get a *short* answer; reasoning effort mainly cuts hidden thinking/latency.

### Cited Findings
**Provider-native controls**
- Anthropic `output_config.effort` levels: `low` (most efficient; "subagents"), `medium`, `high`, `xhigh`, `max`. "Effort is a behavioral signal, not a strict token budget"; applies to every output token, with or without thinking; lower effort also means fewer, terser tool calls; at lower levels Claude "can skip thinking entirely for simpler problems". Where adaptive thinking is available, effort is the recommended control of thinking depth. Defaults: `high` on most models; `medium` on Opus 5.5 and Haiku 5.5. — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- `budget_tokens` (extended thinking token budget) is legacy: Haiku 5.5 returns 400 for `thinking: {type:"enabled", budget_tokens:N}`; Opus 4.5 is "the only extended-thinking-only model that supports effort" alongside `budget_tokens`. — [Claude Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide); [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Per-message effort (beta, header `mid-conversation-output-config-2026-07-01`) lets you change effort per turn by inserting an empty `role:"system"` message with `output_config.effort` — preserves prompt cache. Available on Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5, Fable/Mythos 5.1. Not with Haiku 5.5 `thinking: disabled` or Sonnet 5.5 `between_tools`. On other models, changing top-level effort restarts the cache. — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Opus 4.7+ "respects effort levels more strictly ... At lower effort levels, the model scopes its work to what was asked rather than doing more than requested." — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Gemini: `thinking_level` in `generation_config` (`minimal`/`low`/`medium`/`high`, model-dependent); Google recommends lowering `thinking_level` rather than setting a small `max_output_tokens` to cut cost. The fetched page documents only `thinking_level`, not `thinkingBudget` (the 2.5-era budget param appears superseded in docs). — [Gemini thinking docs](https://aistudio.google.com/docs/thinking)
- OpenAI `reasoning_effort` values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`; per-model support varies (gpt-5.1: none/low/medium/high; gpt-5: minimal/low/medium/high; xhigh on models after gpt-5.1-codex-max) — secondary sources, conflicting. Minimal effort reportedly used zero reasoning tokens in one test. — [docs.rs OpenAI schema mirror](https://docs.rs/agentsdk-openai/latest/agentsdk_openai/api/types/enum.ReasoningEffort.html); [OpenAI community thread](https://community.openai.com/t/request-for-compatibility-matrix-reasoning-effort-sampling-parameters-across-gpt-5-series/1371738); [DataCamp](https://datacamp.com/tutorial/openai-gpt-5-api)

**Provider-agnostic layers**
- AI SDK (v7) top-level `reasoning` on `generateText`/`streamText`: `'provider-default'` (default), `'none'` (or lowest level if cannot disable), `'minimal'`, `'low'`, `'medium'`, `'high'`, `'xhigh'`, `'max'`. Unsupported level rounds to closest supported at-or-below (else next higher); rounding never turns reasoning off; emits `compatibility` warning when value differs, `unsupported` warning and ignores param for non-reasoning models; OpenAI-compatible/unknown model IDs get the value passed through unchanged. Token-budget providers map level to a share of max output tokens (`max` = 95%). Provider-specific options override. — [AI SDK reasoning docs](https://ai-sdk.dev/docs/ai-sdk-core/reasoning)
- LiteLLM `reasoning_effort` maps to Anthropic budget tokens / adaptive effort and rounds to declared `reasoning_effort_levels` (v1.108.0+). — [LiteLLM reasoning_content docs](https://docs.litellm.ai/docs/reasoning_content)

**Model routing / cascades**
- RouteLLM (lm-sys): routers `mf` (matrix factorization, recommended), `sw_ranking`, `bert`, `causal_llm`, `random`; claims up to 85% cost reduction on MT Bench while keeping 95% of GPT-4 performance, and >40% cheaper than commercial routers at comparable quality. Trained on GPT-4 vs Mixtral 8x7B preference data, claimed to generalize. Cost threshold per request; `calibrate_threshold` on Chatbot Arena data (README gives conflicting example thresholds 0.11593 vs 0.1881 for 50% strong calls); recommends calibrating on your own traffic. OpenAI-compatible server (`model="router-mf-0.5"`), backends via LiteLLM; `mf`/`sw_ranking` need an OpenAI key for embeddings. 5.7k stars, 29 open issues; last-commit date not confirmed. — [RouteLLM GitHub](https://github.com/lm-sys/RouteLLM)

### Inferences
- **What to build (provider-agnostic):** Before each agent turn, a single fast router call (small model, `reasoning: 'none'/'low'`, structured output via zod/pydantic) returns per agent: `{shouldRespond, effort: 'low'|'medium'|'high', targetLength: 'one-liner'|'short'|'detailed'}`. Map:
  - `low` → `reasoning: 'none'|'minimal'`, `maxOutputTokens ≈ 150–300`, prompt: "Reply in 1–2 sentences."
  - `medium` → `reasoning: 'low'`, `maxOutputTokens ≈ 800`, "A short paragraph or a few bullets."
  - `high` → `reasoning: 'medium'|'high'`, `maxOutputTokens ≈ 3000+` (leave headroom: thinking counts toward the limit on Claude and Gemini), "Be thorough."
  The *prompt length guidance* is what users perceive; `max_tokens` is a safety cap (don't make it so tight replies get cut mid-sentence, and remember hidden thinking consumes it); reasoning effort controls latency/cost/depth.
- Fold the router into the gating call you likely need anyway (deciding which agents speak to a message) so effort routing costs zero extra round trips. Show the chosen effort as a small badge in the UI — makes the stretch goal visible to reviewers.
- Alternative "self-assessed" approach: let each agent model decide via adaptive thinking at low/medium effort (Claude "can skip thinking entirely for simpler problems"). Cheaper to implement, but it doesn't control answer *length* and isn't uniform across providers — weaker demo of the stretch goal.
- RouteLLM-style learned routers are overkill for 24h: they route between two models (strong/weak) rather than effort levels, need calibration, and add a Python service. A prompted LLM classifier with structured output is the pragmatic equivalent; mention RouteLLM/cascades as future work.
- Cascade (answer with cheap model, escalate if low confidence) conflicts with streaming UX (user sees the cheap answer first) — avoid for a live chat.

### Gaps
- Found no controlled evidence comparing "LLM classifier decides effort" vs "model adaptive thinking" on answer quality/latency for chat; only vendor guidance and RouteLLM's two-model routing results.
- Did not verify the official OpenAI per-model `reasoning_effort` matrix for current GPT-5.x models, nor exact AI SDK `reasoning` → Gemini `thinking_level` mapping.

## Q5. Concrete recommendation for a 24h build

### Takeaway
**TypeScript (preferred):** Node server + Vercel AI SDK (v7 if starting fresh; v6 fine) with `createProviderRegistry` and `provider:model` env strings, one `AbortController` per agent stream, `streamText({ abortSignal, reasoning, maxOutputTokens })`, `onAbort` to capture partial text, continuation via user-turn (not prefill), and a structured-output router call for gating + effort. **Python:** FastAPI + LiteLLM (`model="provider/model"` strings from config, `reasoning_effort`), each stream in its own asyncio Task you cancel explicitly, same user-turn continuation pattern.

### Cited Findings
- AI SDK registry `provider:model` IDs; `abortSignal` cancels upstream; `onAbort(steps)` for partials; abort incompatible with resumable streams. — [AI SDK provider registry](https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry); [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- AI SDK `reasoning` unified option with rounding + warnings. — [AI SDK reasoning docs](https://ai-sdk.dev/docs/ai-sdk-core/reasoning)
- LiteLLM unified `reasoning_effort` translation incl. Claude adaptive thinking. — [LiteLLM reasoning_content docs](https://docs.litellm.ai/docs/reasoning_content)
- Prefill → 400 on Claude 4.6+/Haiku 5.5; Anthropic's recommended continuation phrasing in the user turn. — [Claude Haiku 5.5 migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)
- Haiku 5.5: recommended for "high-volume, latency-sensitive tasks such as classification, extraction, and routing"; use `low` effort for chat. — [Claude effort docs](https://platform.claude.com/docs/en/build-with-claude/effort)
- Gemini 3.5 Flash-Lite defaults to `minimal` thinking; 3.8 Flash defaults medium. — [Gemini thinking docs](https://aistudio.google.com/docs/thinking)

### Inferences
- **Models to test with (deliberately multi-provider to prove swappability):**
  - Agent A: `anthropic:claude-haiku-5-5` at `reasoning: 'low'` (no temperature; no prefill).
  - Agent B: `google:gemini-3.8-flash` (or `gemini-3.5-flash-lite` for speed/cost) at low/minimal thinking.
  - Agent C: an OpenAI GPT-5.x mini at `reasoning_effort: 'minimal'|'none'`, or a Groq/Cerebras-hosted open model via `createOpenAICompatible` for very low TTFT and to prove the OpenAI-compatible path.
  - Router/gating: the fastest cheap model available (Haiku 5.5 low or Flash-Lite minimal) with schema-validated structured output.
  - One "smart" swap demo: change one env var to `anthropic:claude-sonnet-5-5` and show it works unchanged.
- **Implementation checklist:** per-model quirks map (supportsTemperature, supportsPrefill=false default, minReasoningLevel); always filter stream parts by type (text vs reasoning); `maxOutputTokens` with thinking headroom; per-provider concurrency limit + 429 backoff; log TTFT and effort per reply; do not enable resumable streams (conflicts with abort).
- **Interrupt flow:** `controller.abort()` → `onAbort` gives partial text (or accumulate deltas yourself) → build continuation user turn with partial + redirect → new `streamText` with new controller → append to same message bubble. Guard against race conditions (late deltas after abort) with a per-agent generation ID.
- If OpenRouter is used as the single gateway for speed of setup, it simplifies keys/billing but adds a hop (latency) and its "prefill" passthrough won't help on Claude 4.6+.

### Gaps
- Not verified: exact current OpenAI GPT-5.x mini model ID and its TTFT; Groq/Cerebras current model catalog.
- Not verified hands-on: AI SDK v7 `reasoning` behaviour per provider, LiteLLM upstream cancellation.
