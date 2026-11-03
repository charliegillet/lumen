# Mid-Stream Steering of Streaming LLM Responses (multi-agent group chat)

Scope: how to redirect, stop, or permanently re-instruct one or more LLM agents while they are still streaming, so the redirect lands in the same answer. Researched 2026-11-03. This was a time-boxed pass of about 16 tool calls. Where a claim rests on training knowledge or a third-party source rather than primary docs, these notes say so.

---

## 1. Known mechanisms, and which providers support assistant prefill

### Takeaway
No major hosted API accepts new input during a generation, so every approach is abort-and-restart in some form. The classic trick of prefilling the assistant turn with the partial output is now **rejected with a 400 by current Claude models (Opus 4.6 and later, including Opus 5.5)**. It is also reportedly rejected by Gemini 3.6+ and is not natively supported by OpenAI. The portable approach is: abort, then restart with the conversation ending in a **user** turn that holds the steer and the already-visible partial text, and ask the model to continue that message.

### Cited Findings
- **Anthropic, current models reject prefill.** The Opus 5.5 migration guide's request requirements say: "Prefill: Don't end `messages` with a prefilled assistant turn: it is rejected. Use structured outputs or system prompt instructions instead." — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- The same guide: "Prefilling assistant messages returns a 400 error on Claude Opus 4.6 and later Opus models, including Claude Opus 5.5, so this is a change only if you come from Claude Opus 4.5 or earlier." It also says assistant prefill returns a 400 on Sonnet 5 ("on both models"). — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- The current migration-guide index lists Fable 5.1 / Mythos 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 as the latest models. — [Anthropic migration guides index](https://platform.claude.com/docs/en/about-claude/models/migration-guide)
- **Opus 5.5 also forces thinking on.** `thinking: {"type":"disabled"}` and manual budgets are rejected, and adaptive thinking is always on. Sampling params (`temperature`, `top_p`, `top_k`) must be omitted, and forced `tool_choice` is rejected. — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide). This matters for latency: every restart pays thinking time before the first visible token.
- Error text seen in the wild: "This model does not support assistant message prefill. The conversation must end with a user message." — [Agno issue #7015](https://github.com/agno-agi/agno/issues/7015) (via search snippet); also [Claude Code issue on Opus 4.6 prefill 400s](https://claudeissues.com/issue/28478-bug-claude-code-prefilling-assistant-messages-when-using-opus-4-6)
- **LiveKit** hit the same break and proposed adding a trailing user message such as "[SYSTEM] Continue." when history ends on an assistant turn. This is a community workaround, not Anthropic guidance. — [livekit/agents issue #4907](https://github.com/livekit/agents/issues/4907)
- **Gemini (unverified, third-party).** A blog quotes a Gemini 3.6 migration note: "If the last non-empty turn in the request is a model turn, the API returns a 400 error." It says this applies to Gemini 3.6 Flash, 3.5 Flash-Lite, "and all future Gemini model releases", and recommends sending a short user turn ("Continue.") instead. I could not confirm this on Google's own docs. — [laozhang.ai blog](https://blog.laozhang.ai/en/posts/gemini-requests-ending-with-model-turn-not-supported). The official API reference only says roles must alternate between user and model. — [Gemini API reference](https://ai.google.dev/api)
- **OpenRouter** documents "assistant prefill": end `messages` with a `role: "assistant"` message to have the model complete it. It does not list which upstream models honor it. — [OpenRouter API reference](https://openrouter.ai/docs/api-reference/overview)
- A third-party guide lists OpenAI, Azure OpenAI, Gemini/Vertex and Cerebras as providers where a trailing assistant prefill is **ignored**. It says OpenRouter support depends on the routed model. — [MemberJunction prefill guide](https://docs.memberjunction.org/api/media/PREFILL_AND_STOP_SEQUENCES.md) (secondary source)
- **Realtime / voice APIs offer out-of-band responses.** OpenAI Realtime can create a response with `response.conversation: "none"` that is not added to conversation state, and a custom `input` array can control context. — [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)

### Inferences
- Status of the candidate mechanisms for a 2026 build:
  - **(a) Abort + assistant prefill continuation:** dead on current Claude (400) and reportedly on new Gemini. It works only on older models (Claude ≤ Opus 4.5 / Sonnet 4.x per the guide) or open-weight models. Don't build on it.
  - **(a') Abort + "continue this message" in a user turn** (the portable replacement): send the history, then a final user turn with the steer and the partial text, plus a directive to output only the continuation. Continuity is a little less exact than true prefill, because the model may restate or re-open. Fix that with prompt wording and overlap stripping (section 2).
  - **(b) Abort + regenerate from scratch, replacing the bubble:** the most robust adherence (the whole answer is written under the new instruction), but visible text disappears or flickers. Best for drastic redirects ("stop, answer in French", "one line only"), where the old text would contradict the steer anyway.
  - **(c) Abort + new message from the same agent:** simplest, and natural in a group chat (people send a follow-up). It technically lands in a new bubble, which may fail "takes effect in that answer" if evaluators are strict.
  - **(d) Token-level injection (local models):** with vLLM/llama.cpp you can stop the decode, append tokens to the KV cache and resume. That gives true mid-stream injection, but it is not feasible with hosted frontier models and is overkill for 24h.
  - **(e) Chunked generation with checkpoints** (generate about one sentence at a time, check for pending steers between chunks): it adds a full request round trip and thinking per chunk. With Opus 5.5 that is a huge latency tax. Abort-on-demand beats polling.
- Use a fast, low-thinking-cost model (for example Haiku 5.5 at `low` effort, or a non-reasoning model) for agents. Restart latency is dominated by time-to-first-token, and an always-on-thinking model makes "steer feels instant" much harder.

### Gaps
- I did not confirm whether Sonnet 5.5, Haiku 5.5 or Fable 5.1 reject prefill. The 400 is confirmed for Opus 4.6+, Opus 5.5 and Sonnet 5. Assume all current models reject it.
- Older Anthropic docs had a rule that a prefill cannot end in trailing whitespace. I could not re-fetch the prefill doc (the URL redirected to the prompt-engineering overview), so this is unconfirmed. It only matters for legacy models.
- I found no primary OpenAI doc on trailing-assistant-message behavior in Chat Completions or Responses. From training knowledge, OpenAI starts a fresh assistant message rather than continuing; this is unverified.
- I did not check LiteLLM's handling of trailing assistant messages per provider.

---

## 2. Handling the visible partial text on redirect

### Takeaway
Voice frameworks commit only what the user actually saw or heard, and treat everything else as never said. That is the right model for text too. Commit the visible partial, trimmed to a clean boundary, as the start of the message. Then either continue it (soft steers) or replace it (hard steers that contradict it), and strip any overlap or restatement before the continuation joins the bubble.

### Cited Findings
- **Pipecat** releases text to the transport in step with playback, "so unplayed text never reaches the assistant aggregator." On interruption the aggregator commits only the spoken-so-far portion as the assistant message. By default it then re-runs the LLM so the bot can resume or acknowledge, and an `on_assistant_turn_stopped` event exposes the committed content plus an `interrupted` flag. — [Pipecat interruptions docs](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)
- **LiveKit** `session.interrupt()`: "Any active agent speech is immediately ended and the context is truncated to contain only the speech that the user actually heard before interruption." — [LiveKit turn detection & interruptions](https://docs.livekit.io/agents/v1/build/turn-detection)
- A LiveKit community thread reports that LLM text which was never spoken can still leak into context. The transcript-sync estimate "can be off by a word or two". The suggested workaround is to listen for `conversation_item_added` and rebuild context for interrupted items. — [LiveKit community thread](https://community.livekit.io/t/chat-context-contains-text-that-wasnt-spoken-due-to-interruption/165)
- **OpenAI Realtime** (WebSocket): on `input_audio_buffer.speech_started`, "immediately stop playback … and discard any queued audio," then send `conversation.item.truncate` with `item_id`, `content_index` and `audio_end_ms`. Truncate "will cut the audio at a given place and remove the text transcript for the unplayed portion". The guide notes the model cannot precisely align transcript to audio. Over WebRTC/SIP the server truncates automatically. — [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)

### Inferences
- **Text analogue of "truncate to what was played":** keep a per-agent client-side render cursor. The server may have streamed tokens the client has not painted yet; on steer, the committed partial is **what was rendered**, not what was received. Throw away the unrendered tail silently. This also handles late tokens (section 4).
- **Boundary trimming:** cut the committed partial back to the last clause or sentence boundary (`. ! ? ; : —` or newline) only if the cut removes a few words at most. Otherwise keep it to the word boundary. Deleting a full visible sentence reads as a glitch. A small typing-cadence buffer (render 20–40ms behind receipt) makes small trims invisible, because the trimmed words were never painted.
- **Continue vs. replace decision** (decide during classification, section 5):
  - *Additive or soft* steers ("be brief", "mention X too", "wrap it up", "be funnier"): **continue**. Prompt: "The user just said: «steer». Your message so far, already visible to everyone: «partial». Continue this same message from exactly where it stops, applying the instruction from the very next word. Output only the new text; don't repeat anything already written." Then strip any prefix of the output that duplicates the tail of the partial (longest suffix/prefix overlap match) and stitch.
  - *Contradicting or format-changing* steers ("in French", "only bullet points", "actually talk about Y", "stop and just say yes/no"): **replace** in place. Swap the bubble content with a quick fade or rewrite animation, then stream the regenerated answer. Keeping the English half and continuing in French looks broken, and it reads as ignoring the steer.
  - Humans in group chats pivot visibly, so a continuation that opens with a natural pivot ("— ok, short version:", "…actually, keeping it brief:") is fine and even reads as human. Let the model choose whether to pivot, but forbid meta-talk about instructions or system messages.
- If the partial is very short (under about 10 words rendered), just regenerate. A replace there is invisible.
- Store the final message as one record: the committed partial plus the continuation. Future turns then see a coherent message, and no "[interrupted]" artifact shows after reload.

### Gaps
- I found no published text-chat product or paper describing seamless in-bubble continuation after a steer. The recommendations above are extrapolated from voice frameworks.
- I found no empirical data on how often "continue from here" prompts (without true prefill) restate the partial. Plan to test and use overlap stripping.

---

## 3. How products handle interrupts and queued messages; lessons for text

### Takeaway
Two interaction models have emerged in coding agents: **steer** (the message is injected into the running turn at the next safe boundary) and **queue** (the message is held until the turn ends). Codex CLI exposes both (Enter = steer, Tab = queue), and Claude Code primarily queues and offers Esc as a hard interrupt. Voice stacks (OpenAI Realtime, LiveKit, Pipecat) treat barge-in as cancel + truncate-to-observed + respond. For a group chat, every human message mid-stream should behave like a steer to its targets, with Esc / "stop" as the hard stop.

### Cited Findings
- **Codex CLI:** during agent execution, Enter injects new instructions into the running turn (steer mode) and Tab holds a prompt until the turn finishes (queue). Sources disagree on whether steer is the default or opt-in via `/experimental`. Defaults are version-dependent. — [Dev Genius: Codex CLI steer mode](https://blog.devgenius.io/codex-clis-busy-week-steer-mode-fork-and-7-releases-in-3-days-ece5c742923e); [Codex CLI TUI shortcuts reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/); [Codex commit "tui: align pending steers with core acceptance (#12868)"](https://git.halfakop.ru/rad/codex/src/commit/299b8ac4455a76d510f9967f0392058c62e4a7ce)
- A Codex commit notes that Enter during an active turn submits a normal user turn immediately, while Tab uses the queued-message path. The commit refers to "pending steers" that the core must "accept", which suggests steers apply at an engine-side boundary rather than at token level. — [Codex commit #12868](https://git.halfakop.ru/rad/codex/src/commit/299b8ac4455a76d510f9967f0392058c62e4a7ce) (mirror; via search snippet)
- **Claude Code:** typing and pressing Enter mid-turn queues the message without interrupting, and queued items can be edited or deleted with Up. Esc interrupts the current action but keeps the work already done. — [wmedia Claude Code tip](https://wmedia.es/en/tips/claude-code-queue-messages-while-working). Users report that queued messages are read between tool calls, at the next step boundary, though others say only at end of turn. There is a bug report (v2.1.112) where messages typed during "Thinking" were not delivered until Esc. — [claude-code issue #63190](https://github.com/anthropics/claude-code/issues/63190); [claudeissues #52509](https://claudeissues.com/issue/52509-bug-messages-typed-during-thinking-deliberating-manifesting-state-arent-delivere); [claudeissues #50246](https://claudeissues.com/issue/50246-feature-request-message-queue-mode-queue-messages-instead-of-interrupting-active)
- A Claude Code feature request contrasts Codex, whose input "continuously steers the in-flight turn", with Claude Code's queue. — [claude-code issue #69124](https://github.com/anthropics/claude-code/issues/69124)
- **OpenAI Realtime:** with server VAD, "Realtime API handles interruptions" by default: it cancels the in-progress response and starts a new one. A cancelled response emits `response.done` with `status: "cancelled"`. The guide says "don't wait for it before stopping playback or sending the truncation event." Setting `interrupt_response` and `create_response` to false keeps VAD but stops auto-responding. — [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)
- **Pipecat:** the InterruptionFrame is a SystemFrame, so it is processed immediately, ahead of queued frames. Each processor "cancels its processing task and discards queued DataFrames and ControlFrames". `enable_interruptions=False` protects a turn, and `allow_interruptions` is deprecated in favor of interruption strategies. — [Pipecat interruptions docs](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)
- **LiveKit:** per-utterance `allow_interruptions=False` on `session.say`/`generate_reply`. Legacy `interrupt_speech_duration` sets the minimum speech needed to count as an intentional interruption. — [LiveKit interrupt-user recipe](https://docs.livekit.io/reference/recipes/interrupt_user.md); [LiveKit VoicePipelineAgent docs](https://docs.livekit.io/agents/voice-agent/voice-pipeline)

### Inferences
- **Lessons that transfer to text:**
  1. **Stop output first, reason later.** Realtime and Pipecat stop playback before confirming the cancel. In text, freeze the targeted bubble's rendering the instant the user hits send, before any network round trip or classification.
  2. **Priority lane for control signals.** Pipecat's SystemFrame bypasses queued data. Steer and stop events need their own channel and handler, separate from token fan-out, so they are not stuck behind a backlog of token events.
  3. **Commit only what was observed** (section 2).
  4. **Auto-respond after interrupt.** Pipecat and Realtime re-run the LLM after barge-in by default. For a steer, the targeted agent should immediately resume under the new instruction, and the user should never have to prompt again.
  5. **Steer vs. queue:** in a group chat with no modes, the product should infer which one applies. A message addressed to a streaming agent is a steer, and a message with no relation to the in-flight content is a new turn. "Queue" is the fallback when the target already finished.
- Claude Code's queue-only behavior and the related bug reports show what to avoid. Evaluators will notice a delayed or ignored mid-stream message more than anything else.

### Gaps
- I found no authoritative docs for Cursor's mid-generation interrupt or queue behavior.
- I did not research Gemini Live barge-in specifics. Behavior is presumably similar (server VAD interrupts), but this is unverified.
- Official Codex docs on the exact steer injection point were not fetched. The evidence comes from community write-ups and commit mirrors.

---

## 4. Stream cancellation mechanics, billing, and late-token races

### Takeaway
To stop generation you must propagate the abort all the way to the provider HTTP request. A client-side `stop()` alone leaves the server generating, and billing for, the full response. Assume you pay for input plus tokens generated up to disconnect, and possibly more. Guard the UI against late tokens with a per-agent generation ID, not by relying on the abort taking effect instantly.

### Cited Findings
- **Vercel AI SDK:** `useChat().stop()` "aborts the HTTP request from the client". The server keeps generating unless it receives the disconnect. Pass `abortSignal: req.signal` to `streamText`. On Vercel, request cancellation needs `supportsCancellation: true` in `vercel.json` (Node runtime only); without it "the server-side generation may continue." — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- `onAbort` fires only on an AbortSignal abort and receives `steps` (the completed steps), so you can persist partial output. For UI message streams, `onEnd` receives `isAborted`, and you should pass `consumeStream` as `consumeSseStream` to `createUIMessageStreamResponse` so abort handling works. — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- **Abort and resumable streams don't mix:** "Stream abort functionality is not compatible with stream resumption … Choose either abort or resume functionality, but not both." — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams). With resumable streams, `stop()` only closes the current connection. Ably recommends a dedicated stop endpoint that aborts the model request writing to the stored stream. — [Ably: stop vs disconnect](https://ably.com/blog/stop-vs-disconnect-canceling-ai-streaming) (secondary)
- **OpenAI billing (community):** streamed completions are aborted, and no further tokens are billed, "if and only if you use streaming responses and close the connection". Input context is still charged. — [OpenAI community thread](https://community.openai.com/t/cancel-openai-api-request/720603). A 2026 blog says `responses.cancel` works only for background responses, and that synchronous streams have no cancel endpoint, so you just disconnect. — [tianpan.co: Cancellation tax](https://tianpan.co/blog/2026-04-23-cancellation-tax-streaming-abort-billing) (secondary)
- **Anthropic:** the same blog says the Messages API "offers no server-side cancel primitive", so a TCP close is the only signal. I found no official Anthropic statement on post-disconnect billing. — [tianpan.co: streaming abort billed anyway](https://tianpan.co/blog/2026-06-03-the-streaming-abort-signal-your-frontend-sent-that-your-provider-billed-for-the-unsent-tokens-anyway) (secondary; it claims a gap of about 14% between sent and billed tokens, a figure I did not verify)
- **Gateways:** TrueFoundry says that for streams the provider has usually already charged for generated tokens. For self-hosted vLLM, wire the gateway's `on_disconnect` to the engine's `abort(request_id)`. — [TrueFoundry stream disconnect cost accounting](https://www.truefoundry.com/docs/ai-gateway/stream-disconnect-cost-accounting). A Vercel community thread asks whether AI Gateway stops billing on cancel. — [Vercel community](https://community.vercel.com/t/does-vercel-ai-gateway-stop-billing-when-stream-is-cancelled-mid-way/43860)

### Inferences
- **Concrete mechanics:**
  - Node/TS: one `AbortController` per agent generation, held server-side in a `Map<agentId, {genId, controller}>`. On steer, call `controller.abort()` and pass the signal into the SDK call (`anthropic.messages.stream({...}, {signal})`, `openai.chat.completions.create({...stream:true}, {signal})`, or AI SDK `abortSignal`). Abort server-side from the steer handler. Do not rely on the browser disconnecting, especially since one SSE/WebSocket connection carries all agents.
  - Python: run each agent stream in an `asyncio.Task` and call `task.cancel()`. Use `async with client.messages.stream(...)` so exiting the context closes the httpx response. Catch `CancelledError` for cleanup, then re-raise.
  - **Generation epoch:** every token event carries `{agentId, genId, seq}`. On steer, bump `genId` before aborting. Server and client drop any event whose `genId` is not current, and the client renders only up to the committed cursor. This makes late tokens harmless. Never rely on abort being synchronous: the SDK may emit buffered chunks after `abort()`.
  - Use **one multiplexed WebSocket or SSE channel** for all agents, not per-agent `fetch` streams from the browser. Steering one agent must never touch the others' connections.
- **Stop everything:** abort every controller, bump every `genId`, commit each bubble's rendered text as final, and launch no restarts. Persist immediately.
- **Reload during a stream:** make the server the source of truth. Either finalize in-flight messages as committed partials on disconnect, or keep generating server-side and let the reloaded client resubscribe. Skip AI SDK resumable streams, since they conflict with abort; a custom pub/sub (Redis or in-memory) keyed by `genId` handles both cases.

### Gaps
- I found no official Anthropic or Google documentation on whether generation and billing stop immediately on client disconnect. The available evidence is community and blog posts.

---

## 5. Parsing who a steer targets, and one-off vs. standing instructions

### Takeaway
Use a two-stage parser. A synchronous, deterministic pass (regex for @mentions, leading names, "everyone/all") freezes the likely targets in under 1ms. A fast LLM classifier with structured output (run in parallel, about 200–500ms) then settles targets, whether it's a stop or a steer, whether it continues or replaces, and whether the instruction is one-off or standing. Store standing instructions server-side and inject them into every relevant agent's system prompt.

### Cited Findings
- I found no dedicated published source on steer-target classification for multi-agent chat. The design below is inference. Supporting primitives: Anthropic recommends structured outputs or system-prompt instructions in place of prefill for format control. — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide). OpenAI Realtime's out-of-band `conversation: "none"` responses illustrate running a side classification without polluting the main conversation. — [OpenAI Realtime conversations guide](https://developers.openai.com/api/docs/guides/realtime-conversations)

### Inferences
- **Stage 1, deterministic (runs on send, before any network call):**
  - `@Name` anywhere; `^Name[,:!]`, `^(hey|ok|so) Name`; `Name, stop`; case-insensitive and fuzzy (edit distance 1) over the agent roster.
  - Broadcast words: `everyone|everybody|all of you|you all|y'all|guys|team|both of you`.
  - Stop lexicon: `^(stop|wait|hold on|enough|shh|quiet|pause)\b`, or Esc / a stop button.
  - If the message names no one and agents are streaming, the default provisional target is **all currently-streaming agents**. Freeze their rendering (pause, don't abort yet) so nothing ignores the message while classification runs.
- **Stage 2, LLM classifier** (fast model, JSON schema), with the roster, which agents are streaming, the last N messages and each agent's visible partial as input. Output: `{targets: [agentId]|"all", kind: "stop"|"steer"|"new_message", apply: "continue"|"replace", scope: "one_off"|"standing", standing_text: string|null, rationale}`.
  - Standing cues: "from now on", "always", "for the rest of", "stop doing X" (habitual), "every time", "keep it", "no more". One-off cues: "this time", "for this one", or a steer aimed at content in flight ("shorter", "skip the history part").
  - If the result is ambiguous, apply the instruction now and also store it as standing when it describes style (language, length, tone, persona). Applying a one-off style steer to later turns is less harmful than dropping a "from now on".
- **Resolution timing:** if the classifier says an agent is *not* targeted, unfreeze it and flush its buffered tokens (its stream never stopped, so there is no cost). Targeted agents get abort + restart. Regex-confirmed targets (@Nova) can be aborted immediately without waiting for the classifier. That gives the "instant" feel.
- **Standing-instruction store:** table `standing_instructions(id, conversation_id, target: agentId|'*', text, created_at, superseded_by)`. Build each agent's system prompt on every request as persona + "Standing instructions from the user (these override earlier ones; the latest wins on conflict): 1. … 2. …". Because the prompt is rebuilt from the DB on each call, the instructions survive reload with no client state. Let the classifier mark conflicts (for example "speak English again" supersedes "speak French").
- Never expose this machinery: no "instruction saved" toasts. The only visible evidence is agents behaving accordingly.

### Gaps
- I found no benchmarks on regex-vs-LLM accuracy for addressee detection in multi-party chat. Build a small adversarial test set (nicknames, typos, "not you Nova, Kai", "everyone except Sol").

---

## 6. Preventing a reply that ignores the steer

### Takeaway
Ignored steers come from four sources: (1) a race where tokens from the old generation keep rendering, (2) the instruction being buried in context, (3) a continuation that can't honor a contradicting partial, and (4) the agent having already finished. Fix them with generation epochs, putting the steer last and verbatim in a final user turn, replace-mode for contradicting steers, a cheap post-check with one retry, and a defined "already finished" path.

### Cited Findings
- Current Claude models require the conversation to end with a user message (prefill rejected), so the steer naturally belongs in the **final user turn**, the highest-salience position. — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- Voice frameworks show that context can wrongly include unobserved text (the LiveKit community thread). Stale content in context is a known source of incoherent follow-ups. — [LiveKit community thread](https://community.livekit.io/t/chat-context-contains-text-that-wasnt-spoken-due-to-interruption/165)
- Pipecat re-runs the LLM after interruption by default so the conversation does not stall. That is the precedent for an automatic restart after a steer. — [Pipecat interruptions docs](https://docs.pipecat.ai/pipecat/fundamentals/interruptions)
- I found no published source on verification passes specific to steering adherence. The items below are inference.

### Inferences
- **Context layout for the restart request:**
  - System: persona + standing instructions (section 5) + a group-chat rule ("When the user redirects you mid-message, comply immediately; never mention instructions, redirects, or being interrupted").
  - History: the prior messages, with other agents' in-flight partials included as committed text (or omitted).
  - Final user turn: the steer verbatim, plus (for continue mode) the visible partial and "continue from exactly here", or (for replace mode) "rewrite your reply from scratch following this". Put the steer **after** the partial so it is the very last thing the model reads.
- **Post-check (cheap, mostly deterministic):** language ID for language steers, word or sentence count for brevity, regex for "no emojis / no lists", topic keyword presence. For fuzzy steers, a fast LLM judge ("Does this continuation follow «steer»? yes/no") on the first sentence or two. If it fails, silently regenerate once in replace mode. Keep it to one retry, so the user never waits on more than two round trips.
  - To avoid showing a non-compliant start, hold back the first ~1 sentence of a restarted generation (about 300–600ms) until the cheap check passes, then stream normally. This is optional and costs perceived latency.
- **Already-finished race** (the steer arrives after the agent's final token, or within a few hundred ms):
  - If the agent finished less than about 2s ago or the user was typing before it finished (compare the composer's keystroke start time, sent with the message, against the agent's completion time), treat it as a steer on that message. Rewrite the message in place (replace mode), or append to it as a continuation for additive steers.
  - Otherwise treat it as a normal new turn aimed at that agent, which replies with a short message applying it ("Short version: …"). It should never "ignore", and if the steer was standing it is now in the system prompt for every future turn.
- **Multiple rapid steers:** debounce per agent (coalesce steers that arrive during the restart's time-to-first-token) and apply all of them cumulatively in one final user turn. Every steer bumps `genId`, so only the latest restart survives.
- **Steer during restart (before its first token):** abort the restart and restart again with both steers. This is cheap because nothing was rendered.
- **Untargeted agents:** to keep them consistent, give later turns the steer as ordinary chat history. A standing "everyone" instruction goes into all system prompts.

### Gaps
- I found no measured data on steer-adherence failure rates for continue vs. replace prompting. Test empirically with the adversarial set.

---

## 7. Recommended approach for a ~24h build

### Takeaway
Use a server-authoritative orchestrator with one abortable generation per agent, generation-epoch tagging, render-cursor commits, a regex + fast-LLM steer classifier, "continue-via-user-turn" for soft steers and in-place replace for hard ones, standing instructions in the DB compiled into each system prompt, and one cheap compliance check with a silent single retry. Don't use assistant prefill (rejected by current Claude and reportedly by new Gemini), AI SDK resumable streams (incompatible with abort), or polling-chunked generation (latency).

### Cited Findings
- Prefill rejected on Opus 4.6+ / Opus 5.5 / Sonnet 5 — [Claude Opus 5.5 migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide)
- Abort must reach the server (`abortSignal: req.signal`, `supportsCancellation`), and abort is incompatible with resumable streams — [AI SDK: Stopping streams](https://ai-sdk.dev/docs/advanced/stopping-streams)
- Commit only observed output on interrupt, then auto-respond — [Pipecat](https://docs.pipecat.ai/pipecat/fundamentals/interruptions); [LiveKit](https://docs.livekit.io/agents/v1/build/turn-detection); [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime-conversations)
- Steer-vs-queue precedent (Codex Enter/Tab) — [Codex CLI shortcuts reference](https://codex.danielvaughan.com/2026/04/08/codex-cli-tui-shortcuts-slash-commands/)

### Inferences
**Architecture**
- Backend (Node/TS or Python): an `Orchestrator` per conversation holds `agents[agentId] = {genId, controller|task, status, renderedText}` plus the message log and standing instructions in SQLite or Postgres. The client gets one WebSocket carrying `token{agentId,genId,seq,text}`, `msg_final{...}`, `msg_replace{...}`; the client sends `user_msg{text, typingStartedAt}`, `ack_render{agentId,genId,charCount}` (throttled to about every 100ms) and `stop_all`.
- Agent model: a fast, low-latency model (for example Haiku 5.5 at low effort, or any non-reasoning fast model) for the agents and the classifier. Time-to-first-token after a restart is the whole "instant" budget.

**Steer pipeline (target under 150ms to visible freeze, under 1s to new tokens)**
1. Client on send: show the user message, run the regex targeter, and **freeze rendering** of the provisional targets (hold their incoming tokens in a buffer). This is instant and needs no server round trip.
2. Server on `user_msg`: persist it, run the regex, and **abort regex-certain targets immediately** (bump `genId`, `controller.abort()`). Commit each aborted agent's `renderedText`, trimmed to a clean boundary when that is cheap.
3. Run the LLM classifier in parallel (structured JSON). Unfreeze any agents it marks untargeted. Abort any newly found targets. Upsert standing instructions.
4. For each target, build the restart request: system = persona + compiled standing instructions + "comply instantly; never mention redirects"; final user turn = steer verbatim + (continue: the visible partial + "continue exactly from here, output only new text") or (replace: "rewrite your reply following this").
5. Stream the restart. In continue mode, strip the duplicated overlap and append to the same bubble. In replace mode, swap the bubble content (a quick crossfade) and stream into it.
6. Cheap compliance check on the first sentence (deterministic, or a fast judge for fuzzy steers). If it fails, do a silent replace-mode regeneration, once.
7. On finish, persist one coherent message (partial + continuation), with no interrupt markers.

**Edge cases evaluators will try**
- "Everyone stop" / Esc: abort all, commit rendered text, no restarts, and the agents stay quiet until the next user message.
- Spamming steers: per-agent debounce and coalescing; `genId` guarantees only the latest generation renders.
- Steer right after finish: the typing-start-time rule decides between rewriting in place and a short follow-up message. Standing instructions apply either way.
- "@Nova be brief" while Kai and Sol stream: only Nova's genId changes, and Kai and Sol never pause visibly (the regex is certain, so no freeze is needed for them).
- "From now on all of you speak French", then a reload: the DB holds the standing instruction, every system prompt is rebuilt on each request, and the reloaded client fetches the log, where in-flight messages appear as committed or continuing via resubscribe.
- Contradictions ("speak English again"): the classifier marks the old standing instruction as superseded.
- Untargeted chatter while agents stream ("lol"): the classifier returns `new_message`, nothing is aborted, and the agents may respond after they finish.

**Explicitly avoid**
- Assistant prefill on current Claude or Gemini (400), and relying on OpenRouter prefill passthrough unless the target model is verified.
- AI SDK resumable streams together with abort.
- Client-only `stop()` without a server-side abort (keeps billing and generating).
- Any UI that hints at the mechanism ("redirecting…", steering logs, mode toggles).

### Gaps
- End-to-end latency numbers (classifier plus restart TTFT) for specific models were not researched. Measure early and swap models if time-to-first-token after a restart exceeds about 700ms.
- The best continue-mode prompt wording to minimize restatement is unverified. Iterate with tests.
