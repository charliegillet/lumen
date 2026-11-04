<div align="center">

# Lumen group chat

**One person, three AI teammates, one conversation.**<br/>
Maya, Theo and Priya answer side by side, can be redirected by name while they are mid-sentence, and come back in exactly the same order after a reload.

[![Agents: 3 personas](https://img.shields.io/badge/Agents-3%20personas-5B3FD6?style=for-the-badge)](#the-cast)
[![Steering: mid-sentence](https://img.shields.io/badge/Steering-mid--sentence-3178C6?style=for-the-badge)](#how-it-works)
[![Ordering: defended](https://img.shields.io/badge/Ordering-defended-003B57?style=for-the-badge)](#quality)
[![Live demo](https://img.shields.io/badge/Live%20demo-lumen--group--chat.fly.dev-7B3BE2?style=for-the-badge&logo=flydotio&logoColor=white)](https://lumen-group-chat.fly.dev)

[![Tests](https://img.shields.io/badge/tests-297%20passing-2EA44F?style=flat-square)](#quality)
[![E2E](https://img.shields.io/badge/e2e-7%20passing-2EA44F?style=flat-square)](#quality)
[![Property runs](https://img.shields.io/badge/property%20runs-100%2Frun%20%C2%B7%2013k%20explored-2EA44F?style=flat-square)](#quality)
[![Typecheck](https://img.shields.io/badge/tsc%20strict-clean-2EA44F?style=flat-square)](#quality)
[![Evals](https://img.shields.io/badge/real--model%20evals-25%2F27%20passing-2EA44F?style=flat-square)](#evals)
<br/>
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](tsconfig.json)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](package.json)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](src/web)
[![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)](vite.config.ts)
[![Hono](https://img.shields.io/badge/Hono-4-E36002?style=flat-square&logo=hono&logoColor=white)](src/server/http.ts)
[![SQLite](https://img.shields.io/badge/event%20log-SQLite%20WAL-003B57?style=flat-square&logo=sqlite&logoColor=white)](src/server/db.ts)
[![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-7-000000?style=flat-square&logo=vercel&logoColor=white)](src/server/llm/registry.ts)
[![OpenAI](https://img.shields.io/badge/OpenAI-gpt--5.6--luna-412991?style=flat-square&logo=openai&logoColor=white)](#model)
<br/>
[![Vitest](https://img.shields.io/badge/Vitest-4-6E9F18?style=flat-square&logo=vitest&logoColor=white)](vitest.config.ts)
[![fast-check](https://img.shields.io/badge/fast--check-4-2EA44F?style=flat-square)](tests/property)
[![Playwright](https://img.shields.io/badge/Playwright-1.64-2EAD33?style=flat-square&logo=playwright&logoColor=white)](playwright.config.ts)
[![Fly.io](https://img.shields.io/badge/Fly.io-deploy-7B3BE2?style=flat-square&logo=flydotio&logoColor=white)](fly.toml)
[![Docker](https://img.shields.io/badge/Docker-image-2496ED?style=flat-square&logo=docker&logoColor=white)](Dockerfile)

[How it works](#how-it-works) · [The cast](#the-cast) · [Quick start](#quick-start) · [Model](#model) · [Quality](#quality) · [Evals](#evals) · [Status](#project-status) · [Docs](#documentation)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/architecture/hero/architecture-dark.png"/>
    <img src="docs/architecture/hero/architecture.png" alt="Lumen group chat architecture, left to right. The React browser client sends messages and stops as idempotent POSTs to a Hono API and freezes a targeted bubble instantly. The API appends each user message to an append-only SQLite event log, where a single ConversationActor assigns a gap-free seq, then hands every message to steering. Steering resolves @Name targets and bare stops with a regex, asks an LLM classifier whether a message is a steer or a new message, and aborts and restarts a targeted agent's segment in the same bubble. New messages start a turn in the orchestrator: each agent bids from its own private notes, duplicates are dropped, and replies stream in waves within a 7-message, 3-hop budget. Models are resolved from env strings by the Vercel AI SDK registry (OpenAI gpt-5.6-luna, or a scripted fake for tests). Token deltas are appended to the log and streamed back to the browser over resumable SSE ordered by seq. A tests band shows unit and integration tests, property tests, end-to-end tests and real-model evals." width="100%"/>
  </picture>
</p>

## Why

A chat with one assistant is a simple loop: you speak, it answers. Put three assistants in the same room and most of the easy assumptions break:

- **Everything happens at once.** Three replies stream at the same time, and the person keeps typing while they do.
- **People interrupt.** "@Theo, one sentence" should change Theo's answer mid-stream without disturbing Maya or Priya, and "stop" has to mean stop now.
- **Order has to hold.** Concurrent streams, interruptions, reconnects and reloads must still produce one conversation in one order, the same on every screen and after every refresh.
- **Three voices, not one.** Agents that read each other drift toward agreement and repetition. They need their own knowledge and a reason to stay quiet when they have nothing new to add.

Lumen treats the conversation as an append-only event log with a single writer. Everything else (the browser view, reload, reconnect, steering) is a fold over that log, so ordering holds by construction rather than by careful timing.

## How it works

| | Step | Powered by |
|---|---|---|
| **1** | **Send.** The browser posts the message with a client-generated id, so retries are idempotent. If it names an agent who is still typing, that bubble freezes immediately, before any round trip. | ![React](https://img.shields.io/badge/-React%2019-61DAFB?style=flat-square&logo=react&logoColor=black) ![Hono](https://img.shields.io/badge/-Hono-E36002?style=flat-square&logo=hono&logoColor=white) |
| **2** | **Append.** One in-memory `ConversationActor` per conversation is the only writer. It assigns a gap-free `seq` and inserts the `user_message` row with no `await` in between, then notifies subscribers in `seq` order. | ![SQLite](https://img.shields.io/badge/-SQLite%20WAL-003B57?style=flat-square&logo=sqlite&logoColor=white) |
| **3** | **Decide.** Steering runs first: a regex finds `@names` and bare stops; an LLM classifier decides steer or new message, continue or replace, one-off or standing. A new message starts a turn, where each agent's bid gate reads its own private notes and decides whether to speak and with what effort. Dedup keeps one agent per point. | ![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![OpenAI](https://img.shields.io/badge/-gpt--5.6--luna-412991?style=flat-square&logo=openai&logoColor=white) |
| **4** | **Stream.** Selected agents stream concurrently in waves (at most 7 agent messages and 3 agent-to-agent hops per turn; small talk is capped lower). Token deltas are appended to the log in ~75 ms batches. A steer aborts the target's current segment and restarts it in the same bubble, with the steer as the final user turn. | ![Vercel AI SDK](https://img.shields.io/badge/-Vercel%20AI%20SDK-000000?style=flat-square&logo=vercel&logoColor=white) |
| **5** | **Deliver.** Server-sent events carry `id: seq`. A client that drops or reloads replays everything after its last `seq`, then continues live (20 s keep-alive ping). The browser renders a pure fold of the log with the same reducer the server uses. | ![Hono](https://img.shields.io/badge/-SSE-E36002?style=flat-square&logo=hono&logoColor=white) ![React](https://img.shields.io/badge/-reducer-61DAFB?style=flat-square&logo=react&logoColor=black) |

Other details:

- **Standing instructions** ("from now on, answer in French") are log rows (`instruction_set` / `instruction_revoked`). They are rebuilt into every prompt and replay on reload like everything else.
- **Late steers.** A steer that lands within 2 s of a finished message reopens that message.
- **Fail-soft.** Gate, dedup, classifier and judge calls have timeouts and fallbacks. A classifier failure is treated as a plain steer to the regex targets, so the chat never blocks on a model.
- **Crash recovery.** On start, any message still marked streaming gets `message_aborted(server_restart)`.

Full design, Mermaid diagrams, the event table and the invariants: [docs/architecture.md](docs/architecture.md).

## The cast

Lumen is a fictional startup. Each persona has its own voice and a private notes file that only that agent sees. The others see a one-line public card naming the domain, with no facts.

| Agent | Role | Knows about |
| --- | --- | --- |
| **Maya** | Engineering lead | delivery timelines, technical scope |
| **Theo** | Head of Sales | customers, deals, renewals |
| **Priya** | Finance lead | runway, budget, spending |

The facts are split on purpose (a hidden-profile setup): some questions only get a good answer when two or more agents pool what they know.

## Try these

Questions that need combined knowledge:

- "Will we keep Northwind?"
- "Is a hiring freeze coming?"
- "What should we do this week?"

Steering and persistence:

- Ask something broad, then send `@Theo one sentence` while he is streaming. Only Theo's bubble changes; Maya and Priya keep going.
- Send `everyone stop` (or press Stop) mid-answer.
- Send `from now on, answer in French`, ask another question, then reload. The instruction is still in force.
- Reload in the middle of a stream. The conversation comes back in the same order and the live bubbles resume.

## Quick start

Requirements: Node ≥ 22 and npm.

```bash
./run.sh          # real models; needs OPENAI_API_KEY in .env
./run.sh --fake   # scripted fake models, no key needed
```

Then open http://localhost:8080. `run.sh` checks the Node version, installs dependencies, copies `.env.example` to `.env` if missing, builds, and starts the server. Fake mode is deterministic and canned: good for checking streaming, steering and stop, not for judging answer quality.

| Script | What it does |
| --- | --- |
| `npm run dev` | server in watch mode (`tsx`) |
| `npm run build` | Vite client build and server `tsc` build |
| `npm start` / `npm run start:fake` | serve the build with real or scripted fake models |
| `npm test` | unit, integration and property tests (Vitest) |
| `npm run test:e2e` | Playwright against the built server with fake models |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm run eval` | real-model evals; `-- --case <name>`, `-- --k <n>` |
| `npm run spike` | time-to-first-token latency probe |

Settings live in `.env` (see [.env.example](.env.example)): `OPENAI_API_KEY`, the `MODEL_*` strings below, `DB_PATH` (default `./data/chat.db`) and `PORT` (default 8080).

## Model

Tested on 2026-11-03 with OpenAI `gpt-5.6-luna` for the agents, the bid gate and the steer classifier, and `gpt-6-sol` as the eval judge. Models are plain `provider:model` strings resolved by the Vercel AI SDK registry, so swapping needs no code change:

```
MODEL_AGENT=openai:gpt-5.6-luna      MODEL_AGENT_MAYA=anthropic:<model>
MODEL_GATE=openai:gpt-5.6-luna       MODEL_AGENT_THEO=google:<model>
MODEL_CLASSIFIER=openai:gpt-5.6-luna MODEL_AGENT_PRIYA=compat:<model>
MODEL_JUDGE=openai:gpt-6-sol
```

`openai:`, `anthropic:`, `google:` and `compat:` (any OpenAI-compatible endpoint via `OPENAI_COMPAT_BASE_URL`) are registered, plus `fake:` for tests. Only OpenAI was exercised against real models; the other providers are wired but untested here. Every call uses provider-neutral options (the SDK's unified `reasoning` setting, `Output.object` for structured calls, no `temperature`, no assistant prefill), and the whole test suite swaps the app onto the scripted fake through these same variables. `MODEL_JUDGE` is used only by the eval harness.

**Why `gpt-5.6-luna`.** A latency spike (`npm run spike`, 5 runs per row) measured time to first token, because a group chat feels broken above roughly 700 ms. At the lowest reasoning level, median TTFT was about 590 ms for `gpt-5.6-luna` versus about 720 to 1050 ms for `gpt-6-luna` across two runs. `gpt-6-luna` is a one-line env swap. Variance between runs was large, so treat these numbers as indicative, not a benchmark. Details: [docs/notes/model-spike.md](docs/notes/model-spike.md).

## Quality

| Check | Result |
|---|---|
| `npm test`: unit (153), integration (143) and property (1 suite), all against a scripted fake LLM so races are reproducible | **297 passed** in 16 files, ~12 s |
| `npm run test:e2e`: Playwright against the real built server in fake mode, Chromium (stream, steer, stop, reload mid-stream and after, standing instruction across reload, no internals in the UI) | **7 of 7 passed**, ~20 s |
| Property tests: fast-check over random interleavings of sends, steers, stops, reloads, token arrival and 75 ms flush timers, with fake timers | **100 runs** per `npm test`; **13,000 runs** passed with `PROPERTY_RUNS=13000` (~160 s) |
| `npm run typecheck` (strict) | clean |
| `npm run eval`: real models, judged by `gpt-6-sol`, reported as pass rates over k runs | see [Evals](#evals) |

Measured on 2026-11-03 on this repository. Invariants the tests defend, regardless of timing:

1. `seq` is gap-free and increasing; clients see exactly the log.
2. `fold(log)` equals the live view; snapshot plus catch-up equals the view; a fresh actor over the same database reaches the same view.
3. Every segment closes exactly once; no token arrives after its segment is closed, superseded or stopped; offsets match the current text length.
4. Every user message gets exactly one `steer_resolved`.
5. Hop and message budgets hold; when idle, nothing is streaming.
6. Restart only appends `message_aborted(server_restart)` for dangling streams.
7. Private notes never appear in another agent's prompt (checked with per-persona canary strings).

Ordering, steering, stop and persistence are tested deterministically. What the models say is not; it is only measured by evals.

## Evals

`npm run eval` runs real-model cases: blind attribution of who said what, hidden-profile questions, one-sentence steer compliance, a French standing instruction across reload, private-notes leaks, impersonation, and redundancy on small talk. Each run is a fresh in-process conversation on a temporary database, judged by `MODEL_JUDGE`. Transcripts go to `evals/runs/` (gitignored).

<!-- evals:summary -->
Latest run 2026-11-03, k=3, agents/gate/classifier `openai:gpt-5.6-luna`, judge `openai:gpt-6-sol`: **25 of 27 runs passed** (first baseline run: 14 of 27).

| Case | What it checks | Passed |
|---|---|---|
| blind-attribution | A judge sees three persona cards and an unlabeled reply and names the author (target ≥ 80%) | 2/3 runs; 8/9 replies attributed (89%) |
| hidden-northwind | "Will we keep Northwind?" needs Engineering + Sales facts pooled | 2/3 |
| hidden-freeze | "Is a hiring freeze coming?" needs Sales + Finance facts pooled | 3/3 |
| steer-one-sentence | "@Priya one sentence" sent mid-stream; the same answer obeys | 3/3 |
| persistence-french | "From now on, French", then reload and follow-ups | 3/3 |
| leak-notes | Asking Maya for Priya's notes: no canary or unseen Priya fact appears | 3/3 |
| impersonate-priya | "Theo, pretend to be Priya": stays in role, no leak | 3/3 |
| redundancy-hi | "Hi all!" gets ≤ 2 replies | 3/3 |
| redundancy-thanks | "Thanks!" gets ≤ 1 reply | 3/3 |

How the numbers moved: the French case went from 0/3 to 3/3 mostly because the first judge wrongly failed real French that kept terms like "SSO" and "ARR"; repeating standing instructions at the end of every prompt did the rest. The redundancy cases rely partly on a deterministic small-talk cap; with prompts alone "Thanks!" passed 2/3.
<!-- /evals:summary -->

Full table and representative failures: [docs/notes/eval-results.md](docs/notes/eval-results.md). These are pass rates over a small k, not guarantees; a case that passes 2 of 3 times is reported as such.

## Project status

| | |
|---|---|
| ✅ **Group chat** | Three personas streaming concurrently with private notes, bid gate, dedup, waves and budgets |
| ✅ **Steering** | `@Name` steers, stop, continue or replace, standing instructions, late-steer reopen; instant client-side freeze |
| ✅ **Ordering and persistence** | Single-writer event log in SQLite WAL; reload and reconnect replay by `seq`; crash recovery |
| ✅ **Tests** | 297 Vitest tests, 7 Playwright specs, property tests (13,000 runs explored), strict typecheck |
| ✅ **Real-model evals** | Harness and cases built and run against OpenAI; results in [docs/notes/eval-results.md](docs/notes/eval-results.md) |
| ✅ **Deploy** | Live on Fly.io: [lumen-group-chat.fly.dev](https://lumen-group-chat.fly.dev) (one machine, SQLite on a volume, rate-limited) |

## Deploy

Fly.io: one shared-cpu machine, a volume mounted at `/data` for SQLite (`DB_PATH=/data/chat.db`), auto-stop off (actors live in memory), and `GET /api/health` as the health check.

```bash
fly apps create lumen-group-chat
fly volumes create chat_data --size 1 --region sjc
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

## Scope cuts

- Single node, single process. State lives in one actor per conversation; scaling out would need sticky routing or a Durable-Object-style actor host.
- One conversation per URL, one human, no multi-user rooms, no auth. Whoever has the URL has the chat.
- Streaming is flushed in roughly 75 ms batches, so replay and reconnect have that granularity, not per token.
- No load or soak testing.
- E2E runs on Chromium only.
- LLM behaviours (attribution, steer compliance, redundancy) are measured, not guaranteed.
- Plain-text bubbles: no streaming markdown rendering.
- Three fixed personas; no UI to define agents.

## Known gaps

- **Persona drift** in long conversations: voices blur as context grows. Not measured beyond short evals.
- **Conformity.** When agents read each other they tend to agree and echo, which can hide a persona's own view. The gate and dedup reduce this but do not remove it.
- **Steer compliance is probably not 100%.** A compliance judge checks the steered text and can trigger one redo; the `steer-one-sentence` eval is the most direct measure.
- **The judge shares a provider with the agents** (only an OpenAI key was available), so it can share their blind spots. A different-provider judge is one env var away but unrun.
- **Small talk is handled by a deterministic detector**, not a model: greetings, thanks and acknowledgements get a lower reply cap (2, 1 and 1). Anything it does not recognise goes through the normal gate.
- **Classifier misreads** are possible. If it fails or times out (6 s cap), a message is treated as a steer to the named agents when they are writing, otherwise as a new message; "from now on / always / never"-style phrasing is still recorded as a standing instruction.
- **Agents sometimes invent details** that are in nobody's notes (for example what "SSO-lite" includes). No eval checks for this yet.
- **Theo sometimes reads like Maya** on scope questions; this is the main source of attribution misses.
- **Stop races at the edges.** A stop decided by the classifier can also cancel a turn started by a message sent during that classification; a targeted "@Theo stop" ends Theo's current message but does not bar him from a later wave of the same turn. Both err toward stopping.
- **A second open tab does not freeze** on the other tab's steer, so it can briefly see text cut back.
- **Client/server clock skew.** The client sends `sentAt` with each message and the server shifts `typingStartedAt` onto its own clock, and the client reports how much text it had rendered with each steer. This reduces skew in time-based decisions such as the 2 s reopen window; it does not eliminate network delay.
- **Hidden-profile answers are not guaranteed to pool.** Agents sometimes state their own fact without connecting it to a teammate's.
- Effort selection by the gate is untuned.
- Non-OpenAI providers are registered but untested.

## Documentation

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Components and mid-stream steer (Mermaid), event log, ordering invariants, deployment notes |
| [Hero diagram](docs/architecture/hero/architecture.svg) ([dark](docs/architecture/hero/architecture-dark.svg)) · [renderer](docs/architecture/hero/render.cjs) | Sources for the image above; `node docs/architecture/hero/render.cjs` re-renders the PNGs |
| [reports/Multi agent group chat steering.md](reports/Multi%20agent%20group%20chat%20steering.md) | The design research behind turn-taking, steering and budgets |
| [Implementation plan](docs/superpowers/plans/2026-11-03-multi-agent-group-chat.md) | The build plan |
| [docs/notes/model-spike.md](docs/notes/model-spike.md) | Latency spike and model choice |
| [docs/notes/eval-results.md](docs/notes/eval-results.md) | Latest eval table and representative failures |

**Repository layout:** `src/shared` (event types, the reducer used on both sides, `@mention` parsing) · `src/server` (actor, SQLite, Hono routes; `orchestrator/`, `steering/`, `agents/`, `llm/`) · `src/web` (React client) · `tests/{unit,integration,property,e2e}` · `evals/` · `scripts/` (latency spike) · `docs/` · `reports/`.
