# emanate-takehome

## Evals

`npm run eval` runs the real-model evals in `evals/` (each run is a fresh in-process conversation on a temp DB); `-- --case <name>` runs one case and `-- --k <n>` sets the runs per case (default 3). Results go to `docs/notes/eval-results.md`, transcripts to `evals/runs/` (gitignored).

The judge (`MODEL_JUDGE`, default `openai:gpt-6-sol`) shares a provider with the agents, because only an OpenAI key is available, so it may share their blind spots.
