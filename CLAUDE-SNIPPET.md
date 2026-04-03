# Token Coach — Add this to your CLAUDE.md

Copy the section below into your project's `CLAUDE.md` file to enable smart model routing.

---

## Token Coach — Smart Model Routing

Token Coach automatically classifies every prompt and recommends the cheapest model that can handle it. It injects routing guidance via Claude Code hooks.

**How it works:**
- Every prompt you send is classified (search, edit, debug, plan, etc.)
- A model recommendation is injected as context (haiku, sonnet, or opus)
- Every subagent dispatch is logged with justification
- Dashboard at http://localhost:6099 shows all routing decisions

**Your responsibilities as Claude:**
- When Token Coach recommends **haiku**: dispatch to `Agent(model: "haiku")`
- When Token Coach recommends **sonnet**: dispatch to `Agent(model: "sonnet")`  
- When Token Coach recommends **opus**: handle directly
- Always respect the `[TOKEN COACH]` context injected into prompts
- If you override a recommendation, state why in your response

**Model routing rules:**

| Task Type | Model | Examples |
|-----------|-------|---------|
| Search, explore, read | haiku | find files, grep, check status, simple questions |
| Small edits, review, plan | sonnet | fix typo, update config, code review, rename |
| Multi-file, debug, architecture | opus | refactor system, trace bug, design API |

**Parallel dispatch:** Independent subtasks = parallel subagents at the cheapest viable tier.
