# Lumen group chat

A web app where one person talks to three LLM teammates (Maya, Theo, Priya) in a single group conversation. The agents stream at the same time, can be steered by name while they are mid-answer (`@Theo one sentence`), can be stopped, and can be given standing instructions ("from now on, answer in French") that survive a reload. Each agent holds private facts the others lack, so some questions only get a good answer when two or more of them pool what they know.

Live demo: (link added after deploy)

## Try it

```bash
./run.sh          # real models; needs OPENAI_API_KEY in .env
./run.sh --fake   # scripted fake models, no key needed
```

Then open http://localhost:8080. Requires Node 22+. `run.sh` installs dependencies, copies `.env.example` to `.env` if missing, builds, and starts the server. Fake mode is deterministic and canned: good for checking streaming, steering and stop, not for judging answer quality.

## The cast and the scenario

Lumen is a fictional startup. Each persona has a distinct voice and a private notes file that only that agent sees. Other agents see only a one-line public card (a domain, no facts).

| Agent | Role | Knows about |
| --- | --- | --- |
| Maya | Engineering lead | delivery timelines, technical scope |
| Theo | Head of Sales | customers, deals, renewals |
| Priya | Finance lead | runway, budget, spending |

The facts are split on purpose (a hidden-profile setup), so a good answer needs agents to ask and tell each other. Demo questions that need combined knowledge:

- "Will we keep Northwind?"
- "Is a hiring freeze coming?"
- "What should we do this week?"

Steering and persistence demos:

- Ask something broad, then send `@Theo one sentence` while he is streaming. Only Theo's bubble changes; Maya and Priya keep going.
- Send `everyone stop` (or press Stop) mid-answer.
- Send `from now on, answer in French`, ask another question, then reload. The instruction is still in force.
- Reload in the middle of a stream. The conversation comes back in the same order and the live bubbles resume.

## Model

Tested on 2026-11-03 with OpenAI `gpt-5.6-luna` for the agents, the speak/no-speak gate and the steer classifier, and `gpt-6-sol` as the eval judge. Models are plain `provider:model` strings in the environment, resolved by the Vercel AI SDK registry, so swapping needs no code change:

```
MODEL_AGENT=openai:gpt-5.6-luna      MODEL_AGENT_MAYA=anthropic:<model>
MODEL_GATE=openai:gpt-5.6-luna       MODEL_AGENT_THEO=google:<model>
MODEL_CLASSIFIER=openai:gpt-5.6-luna MODEL_AGENT_PRIYA=compat:<model>
MODEL_JUDGE=openai:gpt-6-sol
```

`openai:`, `anthropic:`, `google:` and `compat:` (any OpenAI-compatible endpoint via `OPENAI_COMPAT_BASE_URL`) are registered. Only OpenAI was exercised against real models; the other providers are wired but untested here.

Why `gpt-5.6-luna`: a latency spike (`npm run spike`, 5 runs per row, details in [docs/notes/model-spike.md](docs/notes/model-spike.md)) measured time to first token because the chat feels broken above roughly 700 ms. Median TTFT at the lowest reasoning level was about 590 ms for `gpt-5.6-luna`, versus about 720 to 1050 ms for `gpt-6-luna` across two runs. `gpt-6-luna` is a one-line env swap. Variance between runs was large, so treat these as indicative, not a benchmark.

## How it works

Full design, diagrams and the event table are in [docs/architecture.md](docs/architecture.md). Research behind the choices: [reports/Multi agent group chat steering.md](reports/Multi%20agent%20group%20chat%20steering.md). In short:

- **One ordered log.** One in-memory actor per conversation is the only writer. It assigns a gapless `seq`, persists to SQLite, then notifies subscribers. Browser and server both fold the same log with the same reducer, and bubbles order by the `seq` of their start event, so reload gives the same order by construction.
- **Who speaks.** Each agent runs its own bid gate against its private notes ("do I have something new to add?"). A dedup step clusters near-identical gists and keeps one. `@mentions` force a reply. The gate also picks reply effort, which was a stretch goal and is the least-tested part.
- **Agents answering agents.** Replies come in waves, bounded by a hop budget (3) and a per-turn message budget (7), so exchanges end without a model deciding to stop.
- **Steering.** A steer aborts the target's stream and restarts it with the steer as the final user turn, either continuing the partial text or replacing it. A regex fast path finds `@names`; an LLM classifier decides intent and scope. The client freezes the targeted bubble immediately, so it feels instant while the server decides. A steer within 2 s of a finished message reopens it.
- **Standing instructions** are log rows (`instruction_set` / `instruction_revoked`), so they replay on reload like everything else.
- **Fail-soft.** Gate, dedup and classifier calls have timeouts and fallbacks rather than blocking the chat.

## Guarantees and how they are tested

Invariants the system aims to hold regardless of timing:

1. `seq` is gapless and increasing; clients see exactly the log.
2. `fold(log)` equals the live view; snapshot plus catch-up equals the view; a fresh actor over the same DB reaches the same view.
3. Every segment closes exactly once; no token arrives after its segment is closed, superseded or stopped; offsets match current text length.
4. Every user message gets exactly one `steer_resolved`.
5. Hop and message budgets hold; when idle, nothing is streaming.
6. Restart only appends `message_aborted(server_restart)` for dangling streams.
7. Private notes never appear in another agent's prompt (unit test over the prompt builder, using per-persona canary strings).

Test layers, by what each can honestly claim:

| Layer | Where | What it covers |
| --- | --- | --- |
| Unit | `tests/unit` | reducer, `@target` parsing, prompt isolation, dedup, LLM helpers, client state |
| Integration | `tests/integration` | actor, gate, turns, generation, steering, classifier, HTTP and SSE, all against a scripted fake LLM so races are reproducible |
| Property | `tests/property` | fast-check over random interleavings of sends, steers, stops, reloads, token arrival and 75 ms flush timers, with fake timers so a flush lands on either side of any steer |
| E2E | `tests/e2e` | Playwright against the built server in fake mode: streaming, steer, stop, reload |
| Evals | `evals/` | real-model behaviour, reported as pass rates over k runs |

```bash
npm test          # unit + integration + property (vitest)
npm run test:e2e  # Playwright, starts the server with fake models
npm run eval      # real models, needs OPENAI_API_KEY; -- --case <name>, -- --k <n>
npm run typecheck
```

Ordering, steering, stop and persistence are tested deterministically. What the models say is not, and is only measured by evals.

## Evals

`npm run eval` runs real-model cases (hidden-profile questions, steer compliance, French standing instruction across reload, notes leaking, impersonation, redundancy on small talk). Each run is a fresh in-process conversation on a temp DB, judged by `MODEL_JUDGE`. Full table and representative failures: [docs/notes/eval-results.md](docs/notes/eval-results.md). Transcripts go to `evals/runs/` (gitignored).

<!-- evals:summary -->
Results pending final run
<!-- /evals:summary -->

These are pass rates over a small k, not guarantees. A case that passes 2 of 3 times is reported as such.

## Deliberate scope cuts

- Single node, single process. State lives in one actor per conversation; scaling out would need sticky routing or a Durable-Object-style actor host.
- One conversation per URL, one human, no multi-user rooms, no auth. Whoever has the URL has the chat.
- Streaming is flushed in roughly 75 ms batches, so replay and reconnect have that granularity, not per token.
- No load or soak testing.
- E2E runs on Chromium only.
- LLM behaviours (attribution, steer compliance, redundancy) are measured, not guaranteed.
- Plain-text bubbles: no streaming markdown rendering.
- Three fixed personas; no UI to define agents.

## Known gaps and limitations

- **Persona drift** in long conversations: voices blur as context grows. Not measured beyond short evals.
- **Conformity.** When agents read each other they tend to agree and echo, which can hide a persona's own view. The gate and dedup reduce but do not remove this.
- **Steer compliance is probably not 100%.** A compliance judge checks the steered text and can trigger one redo; the `steer-one-sentence` eval is the most direct measure and is the weakest case in the latest results. Still-open failures are visible in the eval file.
- **Judge shares a provider with the agents** (only an OpenAI key was available), so it can share their blind spots. A different-provider judge is one env var away but unrun.
- **Small-talk handling is a heuristic.** Greetings and thanks get short or no replies through gate prompts and dedup, not a principled model; the redundancy evals show it is imperfect.
- **Classifier misreads** are possible; on failure it falls back to treating the message as a plain steer to the regex targets.
- **Client/server clock skew** can affect time-based decisions such as the 2 s reopen window. The client also reports how much text it had rendered with each steer to soften this; it is not eliminated.
- **Hidden-profile answers are not guaranteed to pool.** Agents sometimes state their own fact without connecting it to a teammate's.
- Effort selection by the gate is untuned.
- Non-OpenAI providers are registered but untested.

## Deploy

Fly.io. `fly.toml` and `Dockerfile` are included: one shared-cpu machine, a volume mounted at `/data` for SQLite (`DB_PATH=/data/chat.db`), auto-stop off (actors are in memory), and `GET /api/health` as the health check.

```bash
fly apps create lumen-group-chat
fly volumes create chat_data --size 1 --region sjc
fly secrets set OPENAI_API_KEY=sk-...
fly deploy
```

Live demo: (link added after deploy)

## Repo map

| Path | What |
| --- | --- |
| `src/shared/` | event types, the reducer used on both sides, `@mention` parsing |
| `src/server/` | actor, SQLite, Hono routes; `orchestrator/` (turns, gate, dedup, generation), `steering/`, `agents/` (personas, prompts), `llm/` (registry, fake provider) |
| `src/web/` | React client: conversation state, bubbles, composer |
| `tests/` | `unit`, `integration`, `property`, `e2e` |
| `evals/` | real-model eval cases and runner |
| `docs/architecture.md` | diagrams, event log, invariants |
| `docs/notes/` | model spike, eval results |
| `reports/` | the design research |
| `scripts/` | `spike-ttft.ts` latency probe |
