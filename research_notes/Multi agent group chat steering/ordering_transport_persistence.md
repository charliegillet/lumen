# Ordering, Transport, Persistence and Reload/Resume for a Multi-Agent Streaming Group Chat

Scope: architecture for one human + 3 or more LLM agents streaming at the same time into one conversation, with mid-stream steering, stop-all, agent-to-agent replies, reload-safe ordering, and persistent standing instructions. Target: a take-home built in about 24 hours that evaluators will try to break (reload mid-stream, rapid interrupts, ordering attacks).

Source-quality note: primary docs were used where possible (MDN, SQLite, Vercel, Cloudflare, Discord engineering blog, the vercel/resumable-stream README, AI SDK docs, Convex Stack). Secondary blogs (tianpan.co, community reverse-engineering of Linear) are labeled. Items under "Inferences" are design reasoning, not sourced facts.

---

## 1. Event sourcing / append-only log with server-assigned sequence numbers; event types; defining message order; deterministic ordering under concurrency

### Takeaway
Production chat systems order by a server-generated, sortable, per-channel ID, not by wall-clock time. Discord switched away from `created_at` because two messages can share a timestamp. For this app, use one append-only event log per conversation. A single writer assigns a gap-free integer `seq`. Order message bubbles by the `seq` of their `message_started` event, so a slot is reserved at start and nothing moves afterwards. Order is then a property of the log, not of which async task wins a race.

### Cited Findings
- Discord dropped `created_at` as the clustering key because "two messages can have the same creation time". It switched to Snowflake IDs, which are chronologically sortable, with primary key `(channel_id, message_id)`, later `((channel_id, bucket), message_id)`. — [Discord: How Discord Stores Billions of Messages](https://discord.com/blog/how-discord-stores-billions-of-messages)
- A Snowflake is a 64-bit ID with a millisecond timestamp in the high bits and worker/process/increment bits in the low bits. Sorting by ID approximates creation order. — [DiscordStore::Snowflake docs](https://rubydoc.info/gems/discord_store/DiscordStore/Snowflake) (secondary)
- Slack's message `ts` is unique only within a channel. Messages are identified by (channel, ts). — [Stack Overflow archive: is the message ts the id](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/49097120/is-the-message-ts-the-id-of-the-message); [clojurians-log import code](https://github.com/clojureverse/clojurians-log-app/blob/61bf0ddcd700d002d29f25f5426eabb22c813dc9/src/clojurians_log/db/import.clj). One system-design blog calls `ts` globally unique, which conflicts with Slack's own usage. — [adhdecode system design Slack](https://adhdecode.com/articles/system-design/system-design-slack/) (unreliable)
- Linear's sync engine, per community reverse-engineering, uses a monotonically increasing `lastSyncId` as a cursor. Clients compare their local value to the server's to detect lag. On reconnect they send their last `lastSyncId` and receive the delta "SyncActions" since then, not a full re-bootstrap. The server broadcasts deltas to all clients, including the one that made the change. Local state changes only when the delta arrives, which is server-confirmed optimism. — [reverse-linear-sync-engine](https://github.com/Aslam97/reverse-linear-sync-engine) (secondary); primary talk: [Scaling the Linear Sync Engine](https://linear.app/blog/scaling-the-linear-sync-engine)
- Cloudflare Durable Objects are "single-threaded and cooperatively multi-tasked". Each has a globally unique name and its own transactional, strongly consistent SQLite storage that only that instance can access. Cloudflare gives chat rooms as the canonical example ("coordinate between multiple clients, such as participants in a chat room"). This is the actor/single-writer-per-room pattern. — [Cloudflare: What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- SQLite (WAL) allows only one writer at a time ("there can only be one writer at a time"), and readers do not block the writer. This serialization at the storage layer suits a per-conversation monotonic counter. — [SQLite WAL](https://www.sqlite.org/wal.html)
- ChatGPT group chats (launched Nov 2025) decide when to respond from conversation flow or an @mention. GPT-5.1 Auto powers the responses, and up to 20 people can join. No public source says how concurrent responses are ordered or streamed. — [AI News](https://www.ainews.com/p/chatgpt-launches-group-chats-for-shared-ai-collaboration); [Digital Citizen](https://www.digitalcitizen.life/chatgpt-group-chat-what-it-is-and-how-to-use-it/)

### Inferences
**Event schema (one table `events`, PK `(conversation_id, seq)`):**
- `user_message {message_id, client_msg_id, text, mentions[]}`
- `message_started {message_id, agent_id, reply_to_message_id?, context_cutoff_seq, effort?}`. This reserves the bubble's slot.
- `token_delta {message_id, offset, text}`. Coalesced, see section 3.
- `message_completed {message_id, final_text_hash/len}`
- `message_aborted {message_id, reason: user_stop | steered | superseded | error, partial_len}`
- `steer {target_agent_id | "all", text, applies_to_message_id?}`. Store it as a user-visible `user_message` too if the person typed it in chat.
- `instruction_set {instruction_id, scope: agent_id | "all", text}` and `instruction_revoked`. Standing instructions are derived by folding these. They survive reload because they are in the log.
- `stop_all {}`
- Optionally `message_segment_started {message_id, segment, context_cutoff_seq}`. When a steer restarts generation inside the same bubble, this records the new cutoff.

**Two ways to define order:**
- *Start-seq ordering* (recommended): a bubble's position is fixed when it is created. A user message sent while three agents are mid-stream gets a higher seq and appears *below* those three bubbles. That is honest, because it was sent after they started. Nothing ever re-sorts, so no layout jump, and reload gives an identical order.
- *Completion-seq ordering*: bubbles jump when they finish, a fast short reply leapfrogs a long one, and an in-progress bubble needs a temporary "floating" zone. That is more confusing and harder to keep identical across reloads.
- Discord/Slack-style IDs are effectively "ID allocated at send/create time", which is the analogue of start-seq. Use start-seq. Agents that decide to stay silent never emit `message_started`, so they never take a slot.

**Determinism mechanism:**
- One Node.js process and one in-memory `ConversationActor` per conversation, holding `lastSeq`. All mutations go through `actor.append(evt)`, which does `seq = ++lastSeq` and a synchronous INSERT (better-sqlite3 is synchronous, so there is no `await` between assigning seq and committing). Then it fans out to subscribers. JavaScript's single thread plus no `await` inside `append` makes the order total and race-free by construction. Add `UNIQUE(conversation_id, seq)` as a belt-and-braces DB check.
- The ordering guarantee is "order = seq, seq assigned by one writer". Write it up as an invariant in the README and test it.
- Agent-to-agent replies: `reply_to_message_id` plus `context_cutoff_seq` give causality. An agent can only reply to messages with seq at or below its cutoff. To guarantee "an exchange ends on its own", put a hop/turn budget on agent-to-agent chains, derived from the log.

### Gaps
- No primary source found on how ChatGPT group chats, or any shipped multi-LLM group chat, orders concurrently streaming bot replies.
- I did not reach Linear's primary talk content. The `lastSyncId` details come from reverse-engineering write-ups.

---

## 2. Making "what the agent saw" consistent with what the user sees (seq-cutoff snapshots, replay)

### Takeaway
Record a `context_cutoff_seq` on every `message_started`, and on every steer-triggered restart segment. An agent's prompt is a pure function of (log up to cutoff, that agent's private context, active standing instructions at cutoff). Replay can rebuild exactly what each agent saw, and tests can assert it.

### Cited Findings
- Linear's model, where clients apply a server delta only once it arrives and track a single cursor, is the general pattern: state is a deterministic fold over an ordered log, and the position is just a number. — [reverse-linear-sync-engine](https://github.com/Aslam97/reverse-linear-sync-engine) (secondary)
- Durable Object storage is transactional and strongly consistent per object. A per-room actor sees its own writes in order. — [Cloudflare DO docs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- SQLite WAL readers get a consistent snapshot: a read transaction "only sees the database content as it existed at a single point in time". Building a prompt inside one read transaction cannot see a half-written state. — [SQLite WAL](https://www.sqlite.org/wal.html)
- Persist the assistant message and its tool results atomically in one transaction. Orphaned partial records can make a conversation unrecoverable. — [tianpan.co: Streaming infrastructure behind real-time agent UIs (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection) (secondary)

### Inferences
- `buildPrompt(agentId, cutoffSeq) = fold(events where seq <= cutoffSeq)`, then render: the shared transcript (other agents' messages labeled by name, aborted messages shown as truncated with their partial text), plus `agentId`'s private context, plus active `instruction_set` for `all` or `agentId`. Keep it a pure function and unit-test it with fixture logs.
- **Partial text from other agents that are still streaming at cutoff:** choose a rule and document it. Either (a) exclude in-flight messages from other agents' prompts, so an agent sees only completed and aborted messages, or (b) include the partial text up to the last persisted delta seq at or below the cutoff. Option (b) is deterministic only if deltas are persisted with seqs. Option (a) is simpler and makes "don't repeat what another said" weaker. A middle path: an agent that wants to react to an in-flight sibling waits for that sibling's `message_completed` before its own `message_started`, and an orchestrator decides this.
- **Mid-stream steering ("takes effect in that answer"):** on `steer` targeting agent X with an active message M: append `steer` (seq S), abort the LLM stream (AbortController), and append `message_segment_started {message_id: M, context_cutoff_seq: S}`. Then restart generation with a prompt that includes the steer and the already-emitted partial text, telling the model to continue or revise from there, and keep streaming into the same bubble M. The visible bubble never shows a "redirecting" status. On replay, the segment events show exactly which text came from which context.
- **Stop-all:** append `stop_all` (seq S). For each active message, abort and append `message_aborted {reason: user_stop}`. Any delta that arrives from the LLM after the abort is discarded in the actor, because the message state is aborted. This is what makes "stop" defended rather than racy.
- Test: replay the same log twice through `buildPrompt` and the client reducer and assert identical output. Snapshot the prompt each agent was given as a debug-only artifact (not shown in the UI).

### Gaps
- I found no source covering the specific "continue the same answer after a mid-stream steer" pattern (assistant prefill or continuation) across providers. Prefill support differs by model and provider and needs checking against the chosen LLM API.

---

## 3. Transport: SSE vs WebSockets vs HTTP streaming; resumable streams; reload mid-stream

### Takeaway
Use **one SSE stream per conversation per tab** (GET `/api/conv/:id/events?after=<seq>`), carrying every agent's events multiplexed and tagged with `id: <seq>`. Send all commands (send, steer, stop, set instruction) as plain POSTs. Reload means: fetch a snapshot at seq S, then subscribe with `after=S`. The client dedupes by seq. This is the Linear cursor pattern applied over SSE, and it does not need Redis or the AI SDK resumable-stream package, which is built for per-request streams on serverless.

### Cited Findings
- SSE: the `id` field sets the EventSource's last-event-ID. `retry` sets the reconnection delay in ms. The browser reconnects automatically by default, and `close()` stops it. Comment lines (`:`) keep the connection alive. — [MDN: Using server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- SSE connection limits: on HTTP/1.1, 6 connections per browser per domain, shared across all tabs ("Won't fix" in Chrome and Firefox). On HTTP/2 the limit is negotiated, default 100 streams. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- Native EventSource uses GET and accepts no custom headers or body, so use query params or cookies, or a fetch-based SSE client, for auth or a cursor. (MDN shows only the `withCredentials` option; GET-only behavior is per the WHATWG spec.) — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- OpenAI, Anthropic and Google all chose SSE for streaming APIs. SSE works through standard HTTP proxies, CDNs and LBs. The common production failure is proxy buffering (nginx: `proxy_buffering off; X-Accel-Buffering: no`). Cloudflare kills a connection after 100 s with no data, so send a heartbeat comment every ~30 s. Use SSE for tokens and a separate POST for control signals (cancel, approve). — [tianpan.co (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection); [Hivenet](https://www.hivenet.com/post/llm-streaming-sse-websockets) (vendor blog)
- Same source: the agent process should write events to a server-side ordered buffer "regardless of whether anyone is listening". Use a dedicated stream ID, replay from Last-Event-ID, and on remount check whether there is an active stream (return 204 if none). Full page navigation clears EventSource state, so the client must persist or derive its cursor. For backpressure, honor `res.write()` returning false and await `drain`. With WebSockets, watch `bufferedAmount` (~64 KB threshold). — [tianpan.co (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection)
- AI SDK resumable streams: generation runs on the server independently of the client connection. A POST handler uses `consumeSseStream` to `createNewResumableStream` into **Redis** and stores `activeStreamId` in the DB. A GET `/api/chat/[id]/stream` calls `resumeExistingStream`, or returns 204 if there is no active stream. `useChat({ resume: true })` hits GET on mount. **Under resume, client `stop()` only disconnects and generation keeps running.** Real stop needs a dedicated stop endpoint that persists the partial message, cancels the model call, and clears `activeStreamId` only if it still matches. Do not auto-reconnect after a stop. Streams expire in Redis. — [AI SDK: Chatbot resume streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)
- `resumable-stream` is "designed for use in serverless environments without sticky load balancing". The first caller for a streamId becomes the producer and always completes the stream, even if the reader disconnects. Later callers publish a request over Redis pub/sub, and the producer replays buffered chunks, then streams live. The common case costs one `INCR` and one `SUBSCRIBE` per stream. `resumeAt` comes from a query param. — [vercel/resumable-stream README](https://github.com/vercel/resumable-stream)
- Vercel Functions support WebSockets in **public beta** on Fluid Compute. A connection pins to the instance that accepted it, and reconnects can land elsewhere. In-memory state reaches only same-instance sockets (two chat-room clients can miss each other), so shared state needs Redis. Every connection closes at max duration. — [Vercel KB: WebSockets on Vercel Functions](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)

### Inferences
- **Why SSE + POST over WebSockets here:** the server-to-client traffic is high-volume and one-way (tokens), and client-to-server traffic is rare, discrete commands that want request/response semantics (status codes, idempotency, "did my steer land?" acknowledged with the assigned seq). One SSE stream multiplexes all agents (each event carries `message_id`/`agent_id`), so concurrency does not need multiple connections and the 6-connection HTTP/1.1 limit only matters with many tabs. SSE's built-in `Last-Event-ID` resume maps 1:1 to the seq cursor. WebSockets are fine too, but you hand-roll reconnect, cursor, and heartbeats, and you lose HTTP semantics on commands.
- **Do not use one HTTP stream per agent response (the AI SDK `useChat` default)** for a multi-agent room. N concurrent streams per user turn, agent-initiated replies (which have no client request to ride on), and stop/steer semantics all fight that model. The AI SDK's own docs say stop under resume needs a separate endpoint anyway.
- **Reload mid-stream recipe:**
  1. `GET /api/conv/:id/snapshot` returns `{ messages[] (ordered by start seq, each with text so far and status), instructions[], lastSeq: S }`, built from the DB, plus the in-memory tail of unflushed deltas, inside the actor (synchronously, so it is a consistent cut).
  2. `new EventSource('/api/conv/:id/events?after=' + S)`. The server replays persisted events with seq > S, then streams live. The browser re-sends `Last-Event-ID` on auto-reconnect, and the server prefers it over `after`.
  3. The client reducer ignores any event with `seq <= lastApplied`, which makes it idempotent and safe against duplicate replays.
  Result: partial text appears immediately and keeps streaming live, with no gap and no double text. The server-side generation never depended on the client connection.
- **Delta seqs vs coalescing:** if every token gets a seq, the log balloons (thousands of rows per answer). Coalesce in the actor: buffer per message and flush one `token_delta` event every ~50–100 ms or ~N chars. Each flush gets a seq and is the unit of persistence and replay. The live SSE can still push those flushes. Clients see 10–20 updates per second, which looks smooth. An alternative: keep live per-token pushes unsequenced (`seq` of the last flush plus a char offset) and sequence only flushes. That is more complex, so skip it in 24 h.
- Heartbeat with `: ping\n\n` every 15–25 s and set `retry: 1000`. Set `X-Accel-Buffering: no` and `Cache-Control: no-cache`.

### Gaps
- I did not verify any primary benchmark for "Chrome allows 100 concurrent SSE streams over one H2 connection" beyond MDN's "default 100" statement.
- The AI SDK docs page did not specify the Redis TTL default.

---

## 4. Persistence choices and deployment (SQLite/Postgres/Redis; Vercel vs a long-running server); coalescing deltas

### Takeaway
For 24 hours: **SQLite in WAL mode on one long-running Node server (Fly.io, Railway or Render) with a persistent volume.** The per-conversation actor lives in memory and the event log is in SQLite. Vercel works against this design: 300 s default/800 s max function duration, WebSocket instance pinning (beta), and no shared in-memory state. You would need Redis plus Postgres plus resumable-stream to recover the same guarantees.

### Cited Findings
- SQLite WAL: concurrent readers with one writer. `synchronous=NORMAL` skips the per-commit fsync, so commits may roll back after a power loss or hard reset but the database is not corrupted. WAL **does not work over network filesystems**, because all processes must share host memory. Auto-checkpoint runs at 1000 pages. Checkpoint starvation can grow the WAL without bound. A rare WAL-reset corruption bug affected 3.7.0–3.51.2 and is fixed in 3.51.3+ (backports 3.44.6, 3.50.7), so use a current SQLite. — [SQLite WAL](https://www.sqlite.org/wal.html)
- Fly.io: SQLite on a volume survives restarts and deploys but "you are effectively limited to a single machine". Volumes start at 1 GB and auto-grow. Litestream to Tigris is offered for backups. Fly staff say vanilla SQLite on volumes is fine if you accept single-node risk, and LiteFS is for multi-node. — [Fly docs: Prisma + SQLite](https://fly.io/docs/js/prisma/sqlite/); [Fly community thread](https://community.fly.io/t/so-its-not-possible-to-use-sqlite-on-fly-without-litefs/12306); [Fly community: LiteFS vs volumes](https://community.fly.io/t/is-litefs-a-direct-replacement-for-multiple-volumes/19592)
- Vercel function duration (Fluid compute, docs updated 2026-08-24): Hobby 300 s default and max. Pro and Enterprise 300 s default, 800 s max, 1800 s extended (beta). Functions are terminated at max duration. Over HTTP/1.1 idle connections may be closed, so stream heartbeats. — [Vercel: Configuring max duration](https://vercel.com/docs/functions/configuring-functions/duration)
- Vercel WebSockets (beta): per-instance pinning, in-memory state not shared, use Redis for rooms and pub/sub. — [Vercel KB](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- Convex's "persistent text streaming" pattern sends tokens over a direct HTTP stream to the originating client and writes accumulated text to the DB only at delimiters (for example sentence ends), with `isComplete: false` snapshots, plus a final `isComplete: true`. Other clients and reloads see chunkier updates through reactive queries. The tradeoff: much less DB bandwidth, but two channels plus client overlay reconciliation. — [Convex Stack: AI chat with HTTP streaming](https://stack.convex.dev/ai-chat-with-http-streaming)
- Durable Objects: SQLite storage per object, 1 GB now and 10 GB at GA per the docs page. WebSocket Hibernation avoids billing while idle, but in-memory state resets on hibernation. — [Cloudflare DO docs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Suggested three-tier pattern for resumable agent streams: a KV map `task_id -> active_stream_id` with pending/ongoing/complete, a stream buffer (e.g. Redis Streams), and an SSE relay. — [tianpan.co (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection) (secondary)

### Inferences
- **Option matrix for this build:**
  - *SQLite + better-sqlite3 (+ Drizzle optional) on Fly, Railway or Render, single instance:* the fewest moving parts and synchronous writes, which keeps seq assignment trivially atomic. File-based, so the evaluator's data survives deploys if a volume is attached. Risk: single node and no HA. That is acceptable, so state it as a deliberate scope cut. **Recommended.**
  - *Postgres (Neon or Supabase) + long-running server:* also fine. Assign seq inside the actor, or with `UPDATE conversations SET last_seq = last_seq + 1 RETURNING last_seq` in the same transaction as the insert. Adds async and network latency on every flush. Choose it only if the host lacks volumes.
  - *Redis Streams:* `XADD` IDs are monotonic, and `XREAD` from an ID gives resume for free. You still need durable storage, and it adds a service. Overkill here.
  - *In-memory + JSON file:* tempting, but crash or redeploy semantics are poor. SQLite costs nothing extra.
  - *Vercel serverless:* you need an external DB + Redis + resumable-stream, a separate stop endpoint, and a cross-instance "actor" (Redis lock or Postgres advisory lock per conversation). Multi-agent orchestration that outlives any single request (agents replying to each other) has no natural home. Vercel Workflows or Queues could host it, but that is a lot to learn in 24 h. Not recommended.
  - *Cloudflare Durable Objects:* architecturally ideal (actor + SQLite + WebSockets per room). But it means a Workers runtime, a different LLM-SDK runtime, and deployment learning. A good choice only if already fluent.
  - *Convex:* reactive DB with built-in ordering by insertion (`_creationTime`), plus the persistent-text-streaming component. Fast to build, but steering and abort of in-flight actions and strict seq semantics need custom work. A reasonable option if the builder knows Convex well.
- **Token persistence:** persist coalesced deltas (every ~100 ms or ~sentence) as sequenced events. On `message_completed` also write the final full text into a `messages` projection table, so the snapshot does not need to fold thousands of deltas. Optionally compact old deltas after completion. Do **not** write one row per token.
- Pragmas: `journal_mode=WAL`, `synchronous=NORMAL` (accept losing the last few hundred ms on power loss; or `FULL` if you want to claim durability), `busy_timeout=5000`. Run one process only, so there is a single writer.

### Gaps
- I did not verify current (Nov 2026) Railway or Render volume pricing or behavior specifically. Assume similar single-instance-plus-volume semantics but check.
- I did not verify better-sqlite3's current version or Node 24 compatibility from a primary source in this session.

---

## 5. Backend runtime for orchestrating many concurrent streams with cancellation

### Takeaway
Node.js (Hono or Fastify; or Bun) with a per-conversation actor object is the most direct fit. Single-threaded JS gives you the serialization point for free, AbortController is the standard cancellation primitive across the Anthropic, OpenAI and AI SDK clients, and SSE is trivial to serve. Python FastAPI + asyncio is equally capable (`asyncio.Task.cancel()`, an asyncio.Lock or queue per conversation) if the builder is faster in Python.

### Cited Findings
- Anthropic TS SDK: `MessageStream.abort()` aborts in-flight network requests. `stream.controller` exposes the AbortController. Request options accept a `signal`. Aborting throws `APIUserAbortError`, so treat it as an expected cancellation. You can also `break` out of a `for await` loop. — [anthropic-sdk-typescript helpers.md](https://github.com/anthropics/anthropic-sdk-typescript/blob/HEAD/helpers.md); [MessageStream source 0.33.1](https://app.unpkg.com/@anthropic-ai/sdk@0.33.1/files/src/lib/MessageStream.ts)
- Forward the server-side abort signal into the LLM call (`abortSignal`), and on abort persist partial results and release resources. — [tianpan.co (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection)
- In Node, `res.write()` returning false signals backpressure, so await `drain`. — [tianpan.co (2026)](https://tianpan.co/blog/2026-04-10-streaming-real-time-agent-uis-sse-backpressure-reconnection)
- Durable Objects show the actor pattern explicitly: single-threaded, cooperatively multitasked, one instance per name. — [Cloudflare DO docs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- Vercel Fluid compute can run multiple invocations per instance, but connection pinning and per-instance memory mean no shared actor state. — [Vercel KB](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections); [Vercel duration docs](https://vercel.com/docs/functions/configuring-functions/duration)

### Inferences
- **Actor shape (Node):**
  ```ts
  class ConversationActor {
    lastSeq: number; subscribers: Set<SSEClient>;
    active: Map<messageId, {agentId, abort: AbortController, segment: number, buf: string, flushTimer}>;
    append(evt) { const seq = ++this.lastSeq; insertStmt.run(...); /* sync */ this.broadcast({seq, ...evt}); return seq; }
    onUserMessage / onSteer / onStopAll / onAgentToken / onAgentDone  // all call append; no await between read-state and append
  }
  ```
  LLM token callbacks call `actor.onAgentToken(messageId, segment, text)`. The actor drops tokens whose `(messageId, segment)` is no longer active. This makes late tokens after a steer or stop harmless: a *defended* guarantee, not a hoped-for one.
- **Swappable LLM by config:** put a thin `streamChat({model, system, messages, signal})` adapter over the Vercel AI SDK `streamText` (provider chosen from an env var), or over LiteLLM in Python. The AI SDK `abortSignal` option gives uniform cancellation across providers.
- **Python alternative:** FastAPI + `sse-starlette`, one `asyncio.Lock` per conversation (or a single consumer task reading an `asyncio.Queue` of commands, which is the cleanest actor), and `task.cancel()` for aborts. Keep `seq` assignment and the DB write together under the lock. With sync sqlite3 that's fine inside the lock; with aiosqlite keep both inside the critical section.
- Bun is viable (fast, built-in SQLite `bun:sqlite`), but ecosystem edge cases in a 24 h window are a risk. Node 22/24 is the safer default.

### Gaps
- I did not fetch Python-side primary docs (sse-starlette, asyncio cancellation semantics) or AI SDK `streamText` abort docs in this session. The claims above are standard practice but not cited here.

---

## 6. Frontend rendering: concurrent streaming bubbles, stable order, no layout jump, optimistic sends, idempotency

### Takeaway
The client is a pure reducer over the server event stream, keyed by `message_id`. Order is by `start_seq`, which never changes once assigned. Optimistic user messages carry a client-generated UUID (`client_msg_id`) that the server stores under a unique constraint and echoes back, so retries are idempotent and the optimistic bubble reconciles in place. Batch token rendering per animation frame.

### Cited Findings
- Linear: the server broadcasts the delta to the originating client too, and the client treats the server delta as the source of truth for local state. That is the pattern for reconciling optimistic writes. — [reverse-linear-sync-engine](https://github.com/Aslam97/reverse-linear-sync-engine) (secondary)
- Convex: the originating client renders streamed text as an optimistic overlay on top of reactive DB results, dropping the overlay when the DB message is complete. Other clients render DB state only. — [Convex Stack](https://stack.convex.dev/ai-chat-with-http-streaming)
- AI SDK: after a user stop, avoid automatic reconnects until the user sends again. Clear `activeStreamId` only if it still matches, to avoid resuming stale streams. — [AI SDK resume streams](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)

### Inferences
- **State:** `{ lastSeq, order: messageId[] (sorted by startSeq), byId: {id → {agentId, text, status, startSeq}}, pendingUser: {clientMsgId → text} }`. Apply events strictly in seq order. If an event arrives with seq > lastSeq+1 (a gap), refetch with `after=lastSeq`, which is cheap insurance.
- **Optimistic send:** render the user bubble immediately at the bottom with `pending` styling (subtle only, with no "sending…" mechanism exposed). POST `{client_msg_id, text}`. The server does `INSERT ... ON CONFLICT(client_msg_id) DO NOTHING` and returns the assigned seq. When the `user_message` event arrives with the same `client_msg_id`, replace the optimistic entry and place it at its seq. Because seq order and send order agree for a single user (a single writer appends in arrival order), the bubble does not visibly move unless an agent's `message_started` landed in between, which is rare and still correct.
- **Rapid interrupts / double-click stop:** stop and steer POSTs also carry an idempotency key. The server treats `stop_all` with no active messages as a no-op.
- **Rendering performance:** accumulate incoming delta text in a ref and flush to React state once per `requestAnimationFrame`. Memoize bubbles by id so only streaming bubbles re-render. Render markdown incrementally, or plain text while streaming and full markdown on complete.
- **Layout jump:** with start-seq ordering, bubbles never reorder. Growth in streaming bubbles above the viewport shifts content, so use "stick to bottom only if the user is already at the bottom" logic, plus CSS `overflow-anchor`. Several bubbles growing at once is expected in a group chat, and fixed slots make it readable.
- **Typing presence:** an agent that is "thinking" before its first token can show a typing indicator. Emit `message_started` only when the agent commits to speaking (after any silent "should I speak?" decision), so silent agents never create empty bubbles.

### Gaps
- No primary source was fetched on React streaming-render performance (rAF batching, `overflow-anchor` behavior across browsers). This is standard practice, not cited.
- I did not survey open-source multi-agent chat UIs (AutoGen Studio, LangGraph agent-chat-ui, etc.) for their state handling in this session, because of the tool-call budget. My understanding is that most run agents sequentially (round-robin or speaker selection) rather than truly concurrently, but that is unverified.

---

## 7. Concrete recommendation for a 24 h build

### Takeaway
Use a **single long-running Node 22/24 server (Hono or Fastify) on Fly.io or Railway with a volume. Run SQLite in WAL mode via better-sqlite3, with one in-memory `ConversationActor` per conversation as the sole writer and assigner of gap-free `seq`. Persist coalesced deltas as sequenced events. Serve one SSE stream per tab with `id: seq` and `?after=` / `Last-Event-ID` resume, send commands as POSTs with idempotency keys, and use AbortController plus segment IDs for steer and stop.** On the frontend, a React (Vite or Next.js static) reducer over events, ordered by start seq. Avoid Vercel serverless for the backend.

### Cited Findings
- Server-assigned sortable IDs, not timestamps, are the proven ordering primitive. — [Discord](https://discord.com/blog/how-discord-stores-billions-of-messages)
- Cursor-based delta resume (`lastSyncId`) is the proven reconnect primitive. — [reverse-linear-sync-engine](https://github.com/Aslam97/reverse-linear-sync-engine)
- SSE natively supports `id` and auto-reconnect. — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
- A single-writer actor per room is the Durable Objects model. — [Cloudflare](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- SQLite WAL gives one writer, snapshot readers, and local-disk-only operation. — [SQLite](https://www.sqlite.org/wal.html)
- Fly: SQLite plus a volume works on a single machine. — [Fly docs](https://fly.io/docs/js/prisma/sqlite/)
- Vercel: 300–800 s caps, and WebSocket state is per instance. — [Vercel duration](https://vercel.com/docs/functions/configuring-functions/duration); [Vercel WS KB](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- AI SDK resumable streams need Redis, and stop needs a separate endpoint. — [AI SDK](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams); [resumable-stream](https://github.com/vercel/resumable-stream)

### Inferences
**API surface:**
- `GET /api/conv/:id/snapshot` returns `{messages, instructions, lastSeq}`
- `GET /api/conv/:id/events?after=S` (SSE; `id: seq`; heartbeat 20 s; `retry: 1000`)
- `POST /api/conv/:id/messages {client_msg_id, text}` returns `{seq}`. The server parses @mentions, which may become a `steer` if the target agent is active, plus `instruction_set` if the orchestrator classifies the text as standing.
- `POST /api/conv/:id/stop {client_req_id}`
- (Steering can live entirely inside `messages`: the person just types "@Ava shorter please". The orchestrator routes it as a steer when Ava is mid-stream, which keeps "no visible mechanism".)

**Tables:** `conversations(id, last_seq)`, `events(conversation_id, seq, type, message_id, agent_id, payload_json, created_at, PRIMARY KEY(conversation_id, seq))`, `messages(id, conversation_id, start_seq, agent_id|'user', text, status, client_msg_id UNIQUE)` as a projection updated in the same transaction, and `instructions(id, conversation_id, scope, text, active, set_seq)`.

**Invariants to state and test** (README and tests, "ordering defended, not hoped for"):
1. `seq` is strictly increasing and gap-free per conversation. Only the actor assigns it, synchronously.
2. Display order = `start_seq` order. Neither completion order nor network arrival order affects it.
3. After `message_aborted` or a new segment, no token from the old (message, segment) is ever appended. Enforce this in the actor, not the client.
4. `snapshot(S) + events(>S)` = live state, so reload is idempotent. Property test: generate random interleavings of sends, steers, stops and fake-LLM token callbacks with random delays. Assert that (a) the replayed client state equals live client state, and (b) no deltas follow an abort.
5. An agent's prompt = `f(events ≤ cutoff, private context, instructions active at cutoff)`. Unit-test it with fixtures.
6. Standing instructions are a fold over `instruction_set`/`instruction_revoked` and survive restart (test: kill the server, restart, check the snapshot).

**Fake LLM for tests:** a deterministic token generator with injectable delays, so concurrency and race tests run in CI without API calls.

**Deliberate scope cuts to declare:** single node / single process (no horizontal scale, but the actor pattern maps to Durable Objects or Redis locks later), one conversation per URL, no auth (or a simple shared secret), and coalesced deltas (~100 ms granularity on replay).

### Gaps
- I did not benchmark SSE fan-out or SQLite write throughput for, say, 5 agents × 20 flushes per second. By reasoning, about 100 small inserts per second is far below SQLite's capacity, but that is not measured.
- Not verified: whether Fly.io or Railway proxies buffer SSE by default in Nov 2026. Test this after deploy (send `X-Accel-Buffering: no` and heartbeats regardless).
