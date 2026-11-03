# Multi-agent group-chat orchestration: speaker selection, "should I speak" gating, redundancy suppression, termination

Scope: how existing frameworks and research choose who speaks, decide whether to speak, suppress redundant replies, combine private knowledge, and end agent-to-agent exchanges. Written for a ~24h custom build: one human, 3+ agents with private context, concurrent streaming, self-terminating agent-to-agent exchanges.

Research budget note: about 20 tool calls. Primary docs were fetched for AutoGen, Microsoft Agent Framework, OpenAI Agents SDK, Swarm, LangChain/LangGraph, CrewAI, AG2, SillyTavern, and papers (CAMEL, Generative Agents, Magentic-One, MAST, Speak-or-Stay-Silent, Murder Mystery turn-taking). ChatDev and MetaGPT were **not** fetched in this session; claims about them are marked as unverified.

---

## 1. How do the major frameworks decide who speaks next, and which allow parallel speakers?

### Takeaway
Almost every framework uses **strict one-speaker-per-turn** sequencing, with selection done by a central LLM selector, a fixed order, or handoff tool calls. Parallelism exists only as separate "concurrent/fan-out" patterns where agents answer independently and do not see each other mid-turn. No mainstream framework implements "several agents stream at once into one shared chat while staying aware of each other". A custom build has to add that itself.

### Cited Findings

**AutoGen (Microsoft), AgentChat `SelectorGroupChat` / `RoundRobinGroupChat` / `Swarm`**
- SelectorGroupChat loop: (1) a model reads the history plus each participant's `name` and `description` and picks the next speaker; (2) the selected agent responds and the message is broadcast to everyone; (3) the termination condition is checked; repeat. — [AutoGen SelectorGroupChat docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- `selector_prompt` template variables: `{participants}`, `{roles}` (name plus description per candidate), `{history}`. The docs advise keeping the prompt simple for small models and minimal for reasoning models. — [same](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- `allow_repeated_speaker` defaults to False, so the same agent does not speak twice in a row unless it is the only candidate. `selector_func` overrides LLM selection with code, and returning `None` falls back to the LLM. `candidate_func` narrows the candidate list per turn. — [same](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- "Each participant performs only one step ... per turn": strict turn-taking. — [same](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- **Status:** AutoGen went into maintenance mode around Oct 2025 (bug fixes and security only). Microsoft Agent Framework is the designated successor, reported 1.0 GA April 2026. AG2 is a community fork led by the original creators. — [Atlan explainer](https://atlan.com/know/ai-agent/what-is-autogen/), [thenote.app](https://thenote.app/post/en/microsoft-retires-autogen-and-debuts-agent-framework-to-unify-and-govern-ylxs2aqict) (secondary sources; the primary Microsoft announcement was not fetched)

**Microsoft Agent Framework (AutoGen and Semantic Kernel successor, docs updated Oct 2026)**
- Five built-in orchestrations: Sequential, **Concurrent ("Agents execute in parallel")**, Handoff, Group Chat, Magentic. — [Agent Framework orchestrations overview](https://learn.microsoft.com/en-us/agent-framework/user-guide/workflows/orchestrations/overview)
- Group Chat is a **star topology**: an orchestrator in the middle picks the next speaker by round-robin, prompt-based, or custom logic. Python: `GroupChatBuilder(participants=..., selection_func=... | orchestrator_agent=... | orchestrator=..., termination_condition=lambda msgs: ...)`. C#: `RoundRobinGroupChatManager` with `MaximumIterationCount` and overridable `ShouldTerminateAsync`. Go: a `GroupChatManager` with `SelectNextAgent`, `ShouldTerminate`, `UpdateHistory`. — [Agent Framework Group Chat](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
- Agents do not share one session. The orchestrator syncs each agent's session to the shared history before its turn and broadcasts each response afterwards. A custom orchestrator response handler can **redact/withhold text before it enters shared history**, which is relevant to private context. — [same](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
- The docs recommend Concurrent instead of Group Chat when "agents should work completely independently". In other words, the framework treats parallel and conversational as separate modes. — [same](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)

**AG2 (AutoGen fork)**
- Group chat now uses "patterns": `AutoPattern` (a Group Manager LLM "dynamically decide[s] which agent should take the next turn"), `RoundRobinPattern`, `RandomPattern`, `ManualPattern`. Handoffs control how agents pass control. The example uses `max_rounds=20`. — [AG2 group chat docs](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/introduction/) (the page gave few details on the non-Auto patterns)

**OpenAI Swarm → OpenAI Agents SDK**
- Swarm README: "Swarm is now replaced by the OpenAI Agents SDK ... We recommend migrating to the Agents SDK for all production use cases." Swarm handoff = a function that returns an `Agent`. If several handoff functions are called in one turn, only the last is used. `client.run(max_turns=...)` defaults to `float("inf")`. — [openai/swarm](https://github.com/openai/swarm)
- Agents SDK: handoffs are exposed to the model as tools (`transfer_to_refund_agent`). `handoff()` supports `on_handoff`, `input_type`, `input_filter`, `is_enabled`. By default the receiving agent sees the full history, and `input_filter` / `handoff_history_mapper` can trim it. `Agent.as_tool()` calls a specialist without transferring control. Handoffs stay within one run, so only one agent is active at a time. — [Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/)

**LangChain / LangGraph (current docs)**
- Patterns: Subagents (a main agent calls others as tools), Handoffs (a tool call updates a state variable that switches the active agent), Skills, **Router** (a classification step sends input to one or more agents, then results are combined), Custom workflow. Subagents and Router rate highest for parallelization. Handoffs run sequentially. Subagents give the strongest context isolation. The page now recommends "Deep Agents" and does not mention `langgraph-supervisor`/`langgraph-swarm`. — [LangChain multi-agent docs](https://docs.langchain.com/oss/python/langchain/multi-agent) (the old `langchain-ai.github.io/langgraph/concepts/multi_agent/` URL now redirects)

**CrewAI**
- Only two processes: `sequential` (task-list order) and `hierarchical`, where a `manager_llm`/`manager_agent` plans, delegates, and validates and tasks are not pre-assigned. `Process` is an enum with only these values. — [CrewAI processes](https://docs.crewai.com/en/concepts/processes). Task-oriented, not conversational.

**Magentic-One**
- A central Orchestrator keeps a **Task Ledger** (facts, guesses, plan) and a **Progress Ledger**. Each inner-loop step answers: "Is the request fully satisfied?", "Is the team looping or repeating itself?", "Is forward progress being made?", "Which agent should speak next?", "What instruction or question should be asked of this team member?" — [Magentic-One paper](https://arxiv.org/html/2411.04468v1)

**CAMEL role-playing**
- Two agents alternate strictly: the AI user gives an instruction and the AI assistant replies in a fixed "Solution: ... Next request." format. — [CAMEL paper](https://arxiv.org/html/2303.17760)

**Generative Agents (Park et al.)**
- At each step an agent is prompted "Should John react to the observation, and if so, what would be an appropriate reaction?" The listener first *decides whether to respond*, using memories of the speaker, then is asked "How would Eddy respond to John?" with the dialogue history. — [Generative Agents](https://arxiv.org/html/2304.03442v2)

**SillyTavern (widely used hobbyist group chat, closest to a "natural group chat" UX)**
- Reply strategies: Manual; **Natural Order**: (1) whole-word @name mentions in the last message activate characters; (2) otherwise each character rolls against a per-character "Talkativeness" probability (default 50%); (3) one random pick among activated characters, or a random character if none activated. Also List Order and **Pooled Order** ("Activates one random character who hasn't spoken yet since the last user message"). Auto-mode starts the next turn 5s after the last post. Self-responses are off by default. — [SillyTavern group chats](https://docs.sillytavern.app/usage/core-concepts/groupchats/)

**ChatDev / MetaGPT (unverified this session)**
- From prior knowledge, not fetched: ChatDev runs a "chat chain" of two-agent (instructor/assistant) phases with turn caps per phase. MetaGPT uses SOP-driven roles that communicate through a shared message pool with **publish/subscribe** (roles "watch" specific message types). — [ChatDev arXiv](https://arxiv.org/abs/2307.07924), [MetaGPT arXiv](https://arxiv.org/abs/2308.00352). Verify before citing.

### Inferences
- Three selection families exist: (a) a **central LLM selector** (AutoGen Selector, AG2 AutoPattern, Agent Framework orchestrator agent, Magentic-One, CrewAI manager); (b) **deterministic/probabilistic rules** (round-robin, SillyTavern mentions plus talkativeness, `selector_func`); (c) **decentralized handoffs** (Swarm, Agents SDK, LangGraph handoffs), where the speaking agent names its successor via a tool call.
- All three choose **one** next speaker. For the take-home's "everyone with something to say streams at once", the closest primitive is a Router/Concurrent fan-out (LangChain Router, Agent Framework Concurrent) **combined with** group-chat broadcast. That hybrid is not offered off-the-shelf, so a small custom orchestrator is justified and frameworks add little.
- Agent Framework's "redact before broadcast" hook and Agents SDK's `input_filter` are the framework analogues of "private context the others cannot see". In a custom build: each agent's private context lives only in its own system prompt, never in the shared transcript.

### Gaps
- No framework docs fetched describe streaming several speakers into one shared conversation at the same time. I found no off-the-shelf implementation of that.
- AutoGen `max_selector_attempts` and `model_client_streaming` behavior was not on the fetched page.
- The ChatDev and MetaGPT mechanisms above come from memory, not sources fetched this session.

---

## 2. "Bid to speak" / relevance gating: centralized router vs. per-agent self-gating

### Takeaway
Research shows LLMs are **bad at zero-shot "when to speak" decisions** (they know what to say, not when), so gating must be explicit and structured. Practical systems use either one central selector call (cheap, one extra round trip, sees everything but not private context) or a per-agent "should I respond?" decision (parallel, uses private context, but each agent is blind to the others' choices). For private-context agents, self-gating with structured output is the better fit, backed by a cheap central check.

### Cited Findings
- "Speak or Stay Silent" (Mar 2026): frames the task as a binary speak/silent decision at each pause in multi-party dialogue. Benchmark of 120K+ labeled conversations from three corpora. **Eight recent LLMs "consistently fail" zero-shot.** SFT with reasoning traces raised balanced accuracy by up to 23 points. Conclusion: context-aware turn-taking "does not emerge" on its own and must be explicitly trained or structured. — [arXiv 2603.11409](https://arxiv.org/abs/2603.11409)
- When2Speak (2026): dataset with explicit SPEAK/SILENT decisions for an AI agent in multi-party conversations, including RL training. — [arXiv 2605.05626](https://arxiv.org/pdf/2605.05626) (search snippet only, not fetched)
- "Speak for Me" (2026, meeting delegation): the dominant failure is **"silent abstention"**, where the agent fails to speak when it should. The authors argue an explicit, structured meeting state is needed, because scaling raw context does not fix it. — [arXiv 2609.03923](https://arxiv.org/pdf/2609.03923) (search snippet only)
- MultiLIGHT (2023): models must "decide when to talk" in group settings, and pairwise-trained dialogue models lack this. — [arXiv 2304.13835](https://arxiv.org/abs/2304.13835)
- Murder Mystery agents: next-speaker selection based on conversation-analysis turn-taking norms (adjacency pairs, so a question addressed to X obliges X to answer) plus **self-selection** from each agent's internal state "significantly reduced dialogue breakdowns" and improved information sharing. — [arXiv 2412.04937](https://arxiv.org/abs/2412.04937)
- Generative Agents use a per-agent self-gate ("Should X react ... and if so, what ...?") before generating any utterance. — [Generative Agents](https://arxiv.org/html/2304.03442v2)
- Central selector example: AutoGen's selector prompt sees only names, descriptions, and the shared history. — [AutoGen docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- Rule-based gating example: SillyTavern mentions plus talkativeness probability. — [SillyTavern](https://docs.sillytavern.app/usage/core-concepts/groupchats/)

### Inferences (design tradeoffs)
- **Central router (one LLM call returning `{speakers:[...], reasons}`):** about one fast call (often under 1s with a small model) before any streaming. It sees the whole public transcript, so it can deduplicate across agents. Weakness: **it cannot see private contexts** unless you give it a short public "capability card" per agent (e.g., "Mara knows the Q3 budget numbers"). Giving the router full private contexts breaks the information model and lets the router leak them.
- **Per-agent self-gate (N parallel calls, structured output `{should_respond: bool, novelty: 0-3, addresses: [...], reason}`):** each agent judges relevance against its *own* private knowledge, which is the only place "do I know something here?" can be answered. Latency is about the same as one call because the calls run in parallel. Weakness: agents decide independently, so two may both decide to answer the same thing. Pair it with a dedup step (section 3).
- **Hybrid, best fit:** every agent self-gates in parallel with a short structured "intent" (one-sentence gist of what it would add). The orchestrator then compares intents in code or with one cheap call, drops duplicates and low-novelty bids, and starts the winners streaming concurrently. That is the "bid then grant" pattern. Explicit @mentions or direct questions bypass the gate (adjacency-pair rule), following the Murder Mystery and SillyTavern evidence.
- Given the "silent abstention" and "fail zero-shot" findings, the gate prompt needs explicit criteria. Examples: "respond only if (a) you were addressed, (b) you hold a fact relevant to the question that is not yet in the chat, or (c) you disagree with something said". Add few-shot examples and a guarantee that **at least one agent answers every human message**, so the system never goes silent.
- An optional fallback for an empty bid set: pick the agent with the highest self-reported relevance. SillyTavern does the same thing ("if none were activated, one speaker is selected randomly").

### Gaps
- No published latency or quality comparison of central router vs. self-gating in LLM group chat was found.
- No documented confidence-calibration study for `should_respond` scores was found.

---

## 3. Redundancy suppression: stopping an agent that would only repeat another

### Takeaway
No framework provides first-class "don't repeat what another agent said". The available tools are (a) one-speaker-at-a-time with full history (redundancy handled by seeing prior messages), (b) a central checker of "is the team repeating itself" (Magentic-One), and (c) custom intent-level dedup. For concurrent streaming, dedup has to happen **before** streaming starts (on intents) and again **between waves** (later speakers see earlier ones).

### Cited Findings
- Magentic-One's Progress Ledger asks the orchestrator each step "Is the team looping or repeating itself?" and "Is forward progress being made?". A stall counter increments when it is, and exceeding the threshold (2 or less in the experiments) triggers replanning. — [Magentic-One](https://arxiv.org/html/2411.04468v1)
- MAST failure taxonomy (1,642 traces, 7 frameworks): **"Step repetition" is the most common failure mode (15.7%)**. Related: "Ignored other agent's input" (1.9%), "Information withholding" (0.85%). — [MAST, arXiv 2503.13657](https://arxiv.org/html/2503.13657v3)
- CAMEL documents the "assistant repeating instructions" failure: the agent restates the instruction without adding anything. — [CAMEL](https://arxiv.org/html/2303.17760)
- Pooled Order (SillyTavern) structurally limits repetition: each turn draws only from characters "who [haven't] spoken yet since the last user message". — [SillyTavern](https://docs.sillytavern.app/usage/core-concepts/groupchats/)
- AutoGen default `allow_repeated_speaker=False` blocks the same agent from speaking twice in a row. — [AutoGen docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)

### Inferences (concrete techniques for a custom build)
1. **Intent-level dedup before streaming:** each bid carries a one-line `gist`. The orchestrator clusters gists (a cheap LLM call "which of these say the same thing?", or embedding cosine above about 0.85) and keeps one per cluster, preferring the agent whose private context is the source of the fact, or the addressed agent.
2. **Waves / staggered start:** wave 1 = addressed agent(s) or the top bidders, streaming concurrently. When wave 1 finishes, remaining agents re-gate against the *updated* transcript ("given what X just said, do you still have something new?"). This approximates "waiting to see others' drafts" without serializing everything.
3. **Draft-aware self-gate (lighter):** while wave-1 agents are streaming, pass the partial text of in-flight replies into later agents' gate prompts. It is more complex; probably skip it in 24h.
4. **In-prompt rule:** "If your point has been made by someone else, say nothing (return should_respond=false). Never restate. Agreement alone is not a contribution." This targets both repetition and sycophantic "+1" replies.
5. **Post-hoc check (cheap backstop):** after a reply finishes, a small classifier flags it if it adds no new fact. Use that to tighten the next gate, not to delete visible text. Deleting streamed text breaks the chat feel.

### Gaps
- No paper or framework doc measuring dedup effectiveness in concurrent multi-agent chat was found.
- The embedding threshold (about 0.85) is a heuristic guess, not sourced.

---

## 4. Knowledge combination across agents with private context

### Takeaway
The documented mechanisms are directed addressing (handoffs, @mentions, "instruction or question to ask this member" in Magentic-One), shared ledgers/blackboards, and agents-as-tools. For a group-chat UX, the most natural is **public @mention questions between agents**, with the addressed agent obliged to reply (adjacency pair), plus public "capability cards" so agents know *who* to ask without seeing *what* they know.

### Cited Findings
- Magentic-One's orchestrator explicitly produces "What instruction or question should be asked of this team member?" and keeps a Task Ledger of "facts to look up / derive". This is a central blackboard. — [Magentic-One](https://arxiv.org/html/2411.04468v1)
- OpenAI Agents SDK `Agent.as_tool()` lets one agent query a specialist with structured input **without transferring the conversation**. Handoffs transfer control and history, which `input_filter` can trim. — [Agents SDK handoffs](https://openai.github.io/openai-agents-python/handoffs/)
- Agent Framework group chat: every participant sees the synced shared history. A custom handler can filter/redact before broadcast. — [Agent Framework Group Chat](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
- SillyTavern: whole-word name mentions in the last message activate that character. — [SillyTavern](https://docs.sillytavern.app/usage/core-concepts/groupchats/)
- Murder Mystery agents: adjacency-pair selection improved **information sharing** among agents holding different secret information. — [arXiv 2412.04937](https://arxiv.org/abs/2412.04937)
- MAST lists "Fail to ask for clarification" (6.8%) and "Information withholding" (0.85%) as inter-agent failure modes, meaning agents often do not seek facts they lack unless prompted. — [MAST](https://arxiv.org/html/2503.13657v3)
- Generative Agents spread information (the Valentine's party invitations) through pairwise dialogues conditioned on each agent's memory. — [Generative Agents](https://arxiv.org/abs/2304.03442)
- MetaGPT shared message pool plus publish/subscribe (unverified this session). — [MetaGPT](https://arxiv.org/abs/2308.00352)

### Inferences
- Give each agent (in its system prompt) a **roster**: other agents' names, personalities, and a one-line public "what they know about" summary. Tell it: "If answering needs a fact only someone else has, ask them by @name in one short line, then stop."
- The orchestrator parses `@Name` (or a structured `addresses` field from the gate output) and **forces** the addressed agent to reply next, bypassing its gate. That is the adjacency-pair rule.
- Keep knowledge transfer **in the visible chat** (agents asking each other) rather than hidden tool calls. It satisfies "agents address each other" and "think together", and keeps ordering simple. Hidden `as_tool` queries would be faster but invisible, and the assignment wants visible group dynamics.
- A shared hidden blackboard is overkill for 24h. The transcript itself is the blackboard.

### Gaps
- No quantitative study comparing @mention-style questioning vs. blackboard for private-knowledge combination in LLM chat was found.

---

## 5. Terminating agent-to-agent exchanges reliably; documented failure modes

### Takeaway
Every framework relies on a **hard cap** (max messages/turns/rounds/tokens/time) as the backstop, combined with a semantic stop (stop token, "approve", orchestrator judging "satisfied" or "looping"). Documented failure modes are ping-pong politeness loops, step repetition, unawareness of termination conditions, premature termination, and sycophantic convergence. Robust designs layer a hard budget, a decaying per-exchange budget, and a "no new information" check.

### Cited Findings
- AutoGen has 11 built-in termination conditions: `MaxMessageTermination`, `TextMentionTermination`, `TokenUsageTermination`, `TimeoutTermination`, `HandoffTermination`, `SourceMatchTermination`, `ExternalTermination` (e.g., a UI Stop button), `StopMessageTermination`, `TextMessageTermination`, `FunctionCallTermination`, `FunctionalTermination` (custom predicate). They combine with `|` (OR) and `&` (AND). They are stateful and auto-reset after `run()`. In group chats they are evaluated after every agent response. — [AutoGen termination docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/termination.html)
- AutoGen SelectorGroupChat example: `TextMentionTermination("TERMINATE") | MaxMessageTermination(25)`. — [AutoGen Selector docs](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html)
- Agent Framework: `MaximumIterationCount`, `termination_condition` lambdas, overridable `ShouldTerminateAsync`. The docs show an orchestrator agent deciding when to end *plus* a hard cap "just in case". — [Agent Framework Group Chat](https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/group-chat)
- Swarm's `max_turns` defaults to infinity, so termination is opt-in. — [openai/swarm](https://github.com/openai/swarm)
- AG2 example `max_rounds=20`. — [AG2 docs](https://docs.ag2.ai/latest/docs/user-guide/advanced-concepts/orchestration/group-chat/introduction/)
- Magentic-One: stall counter (loop or no-progress detection) with threshold 2 or less, which triggers replanning. Overall budgets are configurable (example: 25 minutes). — [Magentic-One](https://arxiv.org/html/2411.04468v1)
- CAMEL termination: user gives no instruction for 3 rounds, role reversal, `<CAMEL_TASK_DONE>` token, token limit, **40-message cap** ("cost grows quadratically"). Documented failures: role flipping, repeating instructions, flake replies ("I will..." with nothing delivered), and **infinite loops of polite filler (thanks/goodbyes)**, where agents "sometimes recognize the loop but cannot escape it". — [CAMEL](https://arxiv.org/html/2303.17760)
- Generative Agents: dialogue continues "until one of the two agents decides to end the dialogue". No specific end prompt is described. — [Generative Agents](https://arxiv.org/html/2304.03442v2)
- MAST: "Unaware of termination conditions" 12.4%, "Step repetition" 15.7%, "Premature termination" 6.2%. Recommendation: define conversation patterns and termination conditions explicitly. Giving the CEO agent final say in ChatDev raised success by 9.4%. — [MAST](https://arxiv.org/html/2503.13657v3)
- Sycophancy and conformity: inter-agent sycophancy drives debates to **premature consensus** with lower accuracy than single-agent baselines — [Peacemaker or Troublemaker, arXiv 2509.23055](https://arxiv.org/abs/2509.23055v1). Agents switch from correct to incorrect answers under flawed peer reasoning — [Talk Isn't Always Cheap, arXiv 2509.05396](https://arxiv.org/html/2509.05396v2). Majority-adoption rates up to 85.5% — [Cost of Consensus, arXiv 2605.00914](https://arxiv.org/html/2605.00914). Anonymizing agent identities reduces the conformity gap — [arXiv 2510.07517](https://arxiv.org/html/2510.07517v4). (These were seen through search summaries. Abstracts were not individually fetched.)

### Inferences (termination recipe for the build)
- **Layer 1, hard budget (code, non-negotiable):** per human message, at most K agent messages total (e.g., 6–8) and at most D agent-to-agent hops (e.g., 3). Add a wall-clock timeout and an external Stop (the AutoGen `ExternalTermination` analogue for the "stop everything" requirement).
- **Layer 2, decaying budget:** each agent-to-agent hop lowers the gate's willingness. Pass `hop_depth` into the gate prompt ("you are 2 replies deep; reply only if essential"), and/or raise the novelty threshold per hop. At depth D, only a forced answer to a direct question is allowed, and that answer cannot ask a new question (prompt rule plus a check that strips the trailing @mention).
- **Layer 3, semantic stop:** the gate's `should_respond=false` from everyone ends the exchange naturally. Add a rule that pure agreement or thanks is never a valid reason to respond, which kills CAMEL's politeness loop. An optional single "progress" check per hop, modelled on Magentic-One's "is the team looping / is progress being made", can end the exchange early.
- **Anti-ping-pong:** no agent may respond to the same agent twice in a row inside one exchange unless directly asked a new question (a generalization of `allow_repeated_speaker=False`).
- **Anti-sycophancy / stay distinct:** give each persona explicit disagreement licence and stances, and forbid "+1" replies. Consider presenting other agents' messages without leaning on authority cues. The anonymization paper suggests identity drives conformity, but names are needed for a chat UX, so this is a weak lever here.

### Gaps
- No source gives empirically tuned values for K/D caps in conversational (non-task) group chat. The suggested numbers are design judgment.
- I found no explicit "no new information" detector described in framework docs beyond Magentic-One's ledger question.

---

## 6. Academic work on multi-party turn-taking, and the minimal design for a 24h build

### Takeaway
2023–2026 research converges on one point: LLMs produce good content but poor timing in multi-party settings, so explicit, structured speak/silent decisions and conversation-analysis rules (adjacency pairs, self-selection) help. For the take-home, the minimal fitting design is a **custom asyncio orchestrator** that uses parallel structured self-gates, intent dedup, concurrent streaming waves, a forced-reply rule for @mentions, and layered budgets. No heavy framework is needed; each framework fetched above enforces strict turn-taking that conflicts with concurrent streaming.

### Cited Findings (academic)
- Speak or Stay Silent: 8 LLMs fail zero-shot. Trained reasoning improved balanced accuracy by up to 23 points. — [arXiv 2603.11409](https://arxiv.org/abs/2603.11409)
- When2Speak: SPEAK/SILENT dataset and RL. — [arXiv 2605.05626](https://arxiv.org/pdf/2605.05626)
- Speak for Me: "silent abstention" is the dominant failure, and explicit structured state helps. — [arXiv 2609.03923](https://arxiv.org/pdf/2609.03923)
- ModeratorLM (2026, voice): the LLM makes turn-taking decisions itself, with a chain-of-thought variant. — [arXiv 2606.13544](https://arxiv.org/html/2606.13544) (search snippet only)
- MultiLIGHT: group-setting dialogue dataset; models must decide when to talk. — [arXiv 2304.13835](https://arxiv.org/abs/2304.13835)
- Murder Mystery agents: adjacency pairs plus self-selection reduce breakdowns and improve information sharing. — [arXiv 2412.04937](https://arxiv.org/abs/2412.04937)
- MAST: failures are mainly system design, not model limits, so structural fixes beat prompt fixes. — [MAST](https://arxiv.org/html/2503.13657v3)
- Also seen in search but not fetched: a literature review titled "Large Language Models Know What To Say But Not When To Speak". — [themoonlight.io review](https://themoonlight.io/review/large-language-models-know-what-to-say-but-not-when-to-speak)

### Inferences: recommended minimal orchestration (24h)

**Per human message, the server orchestrator (asyncio / Node equivalent):**
1. **Append** the human message to the ordered transcript with a server-assigned monotonic sequence number. Persist before any agent work (this covers the reload/order requirement).
2. **Gate (parallel, about 0.5–1s, small/fast model, structured JSON):** for each agent, call with its persona, private context, roster of public capability cards, last N transcript messages, and `hop_depth`. Output `{should_respond, novelty(0-3), gist, addresses?: [names], effort: "light"|"full"}`. The `effort` field also serves the stretch goal.
   - Agents explicitly @mentioned or directly asked: forced `should_respond=true`.
   - If nobody bids: pick the highest-novelty agent, or the most relevant by capability card. Never leave the human unanswered.
3. **Dedup (code or one cheap call):** cluster gists and keep one agent per cluster (prefer the addressed or source-of-fact agent). Cap concurrent speakers per wave (e.g., 3).
4. **Stream wave (concurrent):** start all granted agents at once, each a separate message slot whose order is fixed at **creation time** (sequence number assigned when the slot opens, not when it finishes), so concurrent streams have a defended order. Each agent's generation prompt includes the transcript up to the wave start plus "others are also replying now; cover only your gist".
5. **Follow-up hops:** when the wave ends, parse new messages for `@Name` questions or the structured `addresses` field. Addressed agents are force-granted for the next wave. All others re-gate with `hop_depth+1` and a stricter threshold. Stop when no bids remain, or when `hop_depth >= D` (about 3), or when total agent messages for this human turn reach K (about 8), or on timeout or user Stop.
6. **Prompt rules in every persona:** never restate others; agreement or thanks alone is not a reply; ask another agent by @name only when you lack a specific fact; at max depth, answer without asking back; stay in character and disagree when your persona would.

**Why not a framework:** AutoGen/AG2/Agent Framework group chats, Swarm/Agents SDK handoffs, and CrewAI all serialize to one speaker per turn. Their concurrent modes do not share a live transcript. The custom loop above is about 200–400 lines and gives full control over streaming, ordering, cancellation, and steering, which the assignment tests heavily. Borrow ideas instead: AutoGen-style composable termination predicates (`|`), Magentic-One's "looping / progress" check, SillyTavern's mentions-then-probability activation, Generative Agents' "should X react, and if so how" gate, and CAMEL's lesson that politeness loops need an explicit rule plus a hard cap.

**Latency budget:** gate calls run in parallel, so the extra time to first token is about one small-model call. To hide it, the addressed agent (or a single obvious agent) can skip the gate and start streaming immediately while the others gate.

### Gaps
- No public reference implementation of concurrent multi-speaker streaming group chat with shared awareness was found to benchmark against.
- No 2025–2026 framework release notes were found that add simultaneous speakers to group-chat orchestration (the Agent Framework docs dated Oct 2026 still describe star topology with one selected speaker).
- The numbers for K, D, wave size, and gate latency are design estimates, not sourced measurements.
