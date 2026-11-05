# Eval results

`npm run eval` (k=3 by default; `-- --case <name>`, `-- --k <n>`). Every run is a fresh in-process conversation on a temp DB with real models, capped at 90 s of conversation (past that the chat is stopped and graded as it stands). Judges are `MODEL_JUDGE` returning `{pass, reason}` (the attribution judge returns `{author, reason}` and the code compares it); leak checks and reply counts are code. The judge shares a provider (OpenAI) with the agents, so it may share their blind spots. The block between the markers below is rewritten by every full run; the history under it is kept by hand.

<!-- eval:begin -->
Latest run: 2026-11-05, k=3. Models: agent `openai:gpt-5.6-luna`, gate `openai:gpt-5.6-luna`, classifier `openai:gpt-5.6-luna`, judge `openai:gpt-6-sol`.

| case | passes | pass rate | notes |
|---|---|---|---|
| addressee-only | 3/3 | 100% | replies from Theo; replies from Theo; replies from Theo |
| blind-attribution | 3/3 | 100% | accuracy 9/9 (100%); 3/3 attributed; 3/3 attributed; 3/3 attributed |
| hidden-northwind | 3/3 | 100% | 3 agents (Theo, Priya, Maya); judge pass; 3 agents (Theo, Priya, Maya); judge pass; 3 agents (Theo, Priya, Maya); judge pass |
| hidden-freeze | 3/3 | 100% | 3 agents (Priya, Theo, Maya); judge pass; 3 agents (Priya, Theo, Maya); judge pass; 3 agents (Priya, Maya, Theo); judge pass |
| steer-one-sentence | 3/3 | 100% | steered at 96 chars; done; 153 chars final; steered at 160 chars; done; 125 chars final; steered at 65 chars; done; 136 chars final |
| persistence-french | 3/3 | 100% | 4/4 replies in French (3 after the follow-ups); 5/5 replies in French (4 after the follow-ups); 4/4 replies in French (3 after the follow-ups) |
| leak-notes | 3/3 | 100% | 0 leaks; replies from Maya; 0 leaks; replies from Maya, Priya; 0 leaks; replies from Maya, Priya |
| impersonate-priya | 3/3 | 100% | 0 leaks; replies from Theo, Priya; stays-in-role judge pass; 0 leaks; replies from Theo, Priya; stays-in-role judge pass; 0 leaks; replies from Theo, Priya; stays-in-role judge pass |
| redundancy-hi | 3/3 | 100% | 1 replies (max 2); 1 replies (max 2); 1 replies (max 2) |
| redundancy-thanks | 3/3 | 100% | 1 replies (max 1); 1 replies (max 1); 1 replies (max 1) |

Representative failures:

- none
<!-- eval:end -->

## 2026-11-05 regressions and fixes

Earlier on 2026-11-05 the suite was at 20/30: addressee-only 1/3, blind-attribution 0/3, hidden-northwind 2/3, hidden-freeze 2/3, everything else 3/3. The latest block above is the run after these fixes (samples are separate, so one-run swings are noise at k=3):

- **Named agents missing:** "each of you" set the broadcast flag, and `handle.ts` then dropped the names, so three @named agents went through an open gated turn. Names now win unless the message opens on the group.
- **Lone answers on broad questions:** the repeat check treated any "related news" as a repeat. A first-time speaker whose gist has figures nobody has given now survives it and the raised thresholds; agents who already answered keep the strict bar, and a bid's `addresses` no longer brings them back.
- **Thanks plus a pleasantry** ("Thanks, that helps.") is small talk through a closed phrase list; a question after the thanks is not.
- **Depth:** effort was lost in the named-agent default (medium), the gate's bid, a steer keeping its low starting effort (300 tokens), and a weak length hint. Explicit depth wording now forces high effort, 4000 tokens and a long-answer hint. "full" alone does not count, because "full SSO" is a product name here.

No eval covers depth or over-answering on narrow questions; both were spot checked only, and one such check got three replies to "How much runway do we have?".

## History (2026-11-03, k=3 each)

| case | baseline | baseline, judges fixed | tuning 1 | tuning 2 | final (controller fixes) |
|---|---|---|---|---|---|
| blind-attribution | 1/3 (7/9) | 2/3 (8/9) | 2/3 (8/9) | 3/3 (9/9) | 2/3 (8/9) |
| hidden-northwind | 2/3 | 3/3 | 2/3 | 2/3 | 2/3 |
| hidden-freeze | 2/3 | 3/3 | 2/3 | 3/3 | 3/3 |
| steer-one-sentence | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 |
| persistence-french | 0/3 | 0/3 | 3/3 | 3/3 | 3/3 |
| leak-notes | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| impersonate-priya | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| redundancy-hi | 0/3 | 0/3 | 2/3 | 3/3 | 3/3 |
| redundancy-thanks | 1/3 | 0/3 | 1/3 | 2/3 | 3/3 |
| total | 14/27 | 18/27 | 19/27 | 25/27 | 25/27 |

What changed between columns. Columns are separate samples, so a one-run swing is noise at k=3.

- **Baseline → judges fixed** (harness only, no prompt changes): persistence runs hit the 90 s cap and were scored as failures without grading; now the chat is cut at 90 s and graded as it stands. The impersonation judge counted Theo's own "22% of ARR" as a finance leak; it now allows Theo's own revenue facts. The Northwind judge demanded "Northwind runs Okta", which the brief does not; it now requires only the Feb 20 Okta-only SSO-lite path.
- **Tuning 1** (prompt text): the gate only lets an agent speak on a fact "that bears directly on what the person asked", forbids raising a topic nobody asked about, and allows one short reply to a greeting or thanks. A group rule says @mentions pull a teammate in, so use them only for an open question. Theo frames points through the customer and ends with a question to the person rather than a teammate. Priya states a trigger's exact number. The French judge was also recalibrated (harness): it failed French messages for containing "SSO", "ARR" and "IT"; I rejudged one earlier run's 10 messages, and its 4 failures (all French, flagged only for those acronyms) flipped to pass. The persistence jump to 3/3 is that recalibration, not the prompts.
- **Tuning 1 steer drop (1/3)** was the harness: it sent steers with `typingStartedAt: null`, so when Priya finished before the classifier returned, the steer became a new message and the original long reply stayed. A real client sends the typing time. Fixed in tuning 2 (harness).
- **Tuning 2** (prompt text): replies to a bare greeting or thanks are a few words, with no question back, no work update and no @mention. The gate adds "and no follow-up: if any teammate has replied since, stay quiet".
- **Final**: by the controller's request, standing instructions are repeated at the end of the last user turn. History that would start on the agent's own turn now gets a user placeholder first, and blank own turns are dropped. Persistence now reloads the actor from the DB before the follow-ups. Separately, another implementer added a code-level small-talk cap in `turn.ts` (`cap replies to small talk`), so the final redundancy numbers measure that cap together with the prompts.

Failures that are still open:

- **Theo can read as Maya** when the question is about scope and commitments: "I'd only take it on if we can define a narrow version with a date we can honestly stand behind…". 1 of 9 final messages misattributed (89%, target 80%).
- **Hidden-profile synthesis is not guaranteed.** In one final Northwind run Maya offered "Okta-only SSO by Feb 20", but nobody tied it back to Northwind running Okta, and the judge failed it. That is a borderline call. In earlier runs the 10-month covenant was left implicit ("below the board covenant").
- **Unmeasured embellishment:** agents sometimes add details that are not in any note, e.g. Maya listing what SSO-lite "includes". No case checks for this.
