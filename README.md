# cpp-concurrency-review

Two [Claude Code](https://claude.com/claude-code) skills that review C++ code for concurrency bugs
by giving **every function its own agent**.

> **Status: experimental.** The skills have not been evaluated against ground truth yet. There are
> no recall or precision numbers, and no comparison with a single-agent review. Treat the output as
> leads to check, not as a verdict.

## Why

An agent asked to review a whole class or module for thread safety reads everything and reports
what stands out. A careful human does something different: they sit on one function and ask, line
by line, *what is the rest of the program doing right now?* - "here the data is already freed, there
it is not yet", "the notify arrives before the wait", "the lock was dropped two lines ago, is the
check still true?". A whole-module agent has neither the context budget nor the patience for that
level of detail.

These skills reproduce the human procedure:

1. **Map.** Build one shared concurrency map of the scope: threads, locks and what they guard,
   shared state, object lifetimes, project conventions. Agents treat it as a hint and report where
   the code contradicts it; those corrections are applied before findings are accepted.
2. **Analyze.** One agent per function. It may read any surrounding code, but it builds scenarios
   only for its own function. It must fill a **ledger**: every interleaving point of the function
   (shared reads and writes, lock operations, calls made under a lock, condition-variable
   operations, captured lambdas, early exits), each with explicit scenarios and a verdict of
   *safe*, *bug* or *unsure*. The ledger is what stops an agent from finishing early.
3. **Verify.** A finding is only accepted as a concrete interleaving trace (thread - file:line -
   action, step by step), and a skeptic then tries to refute it from the code: a common lock,
   thread confinement, a happens-before edge, an object that is kept alive after all.
4. **Cross-check.** What no single function can show: assumptions each function makes about its
   callers are checked at the call sites, and the lock-acquisition edges reported by all functions
   are combined into a graph and searched for cycles.

## The two skills

| | `cpp-concurrency-review-focused` | `cpp-concurrency-review-wide` |
|---|---|---|
| Scope | one diff, one class, or a few named functions (about 10 non-trivial ones at most; trivial ones share one agent) | a module or directory (40 functions by default) |
| Diff review | yes: changed functions plus unchanged ones that depend on a changed contract; each finding says whether the change introduced it | no |
| Orchestration | the main agent launches subagents itself | a `Workflow` script |
| Concurrency map | built by the main agent, written to a file that every agent reads | built by a dedicated agent, passed in each prompt |
| Full ledgers | one report file per agent in a review directory | in the workflow result |
| Verification | the main agent acts as the skeptic | one or more skeptic agents per finding |
| Caller assumptions | checked by the main agent | one agent per function that left any unchecked |
| Lock order | checked by the main agent | graph cycles found by the script, each checked by an agent |
| Needs | subagents (the Agent tool) | the Workflow tool |

The per-function procedure is the same in both. Start with the focused one.

## Install

Copy the skill directories from `skills/` into a Claude Code skills directory - `~/.claude/skills/`
for all your projects, or `<project>/.claude/skills/` for one project:

```bash
git clone https://github.com/neurocod/cpp-concurrency-review.git
cp -r cpp-concurrency-review/skills/* ~/.claude/skills/
```

## Use

Ask in plain words, or invoke a skill by name:

```
/cpp-concurrency-review-focused review the uncommitted changes
/cpp-concurrency-review-focused class ConnectionPool in src/net/ConnectionPool.cpp
/cpp-concurrency-review-wide src/scheduler - worker threads are created in Scheduler::start
```

Telling it what you know about the threading model (which threads exist, which executor is
single-threaded, the documented lock order) makes the map better and the false positives fewer.

The report lists confirmed findings with their interleavings (one per root cause, however many
functions reported it), surviving lock-order cycles, the uncertain items together with the fact
that would settle each, mismatches between documentation and code as a separate list, and the
coverage: which functions were analysed, which were skipped and why. Agents work in English; the
report is written in your language.

### Options of the wide skill

Passed as `args` to the workflow; say them in the request ("use 3 skeptics per finding").

| Option | Default | Meaning |
|---|---|---|
| `scope` | `.` | Paths or a description of what to review |
| `focus` | none | Functions that must be analysed; they go first and the cap does not cut them |
| `notes` | none | What you know about the threading model |
| `maxFunctions` | 40 | Cap on analysed functions; the ones dropped are listed in the result |
| `maxFollowups` | 10 | Cap on functions that analysts flagged outside the selection; `0` disables |
| `votes` | 1 | Skeptics per finding; a finding is confirmed or refuted by a strict majority, anything else is uncertain |
| `effort` | `high` | Reasoning effort of the map and analysis agents |
| `verifyEffort` | = `effort` | Reasoning effort of verifiers and cross-checks |
| `mapEffort` | = `effort` | Reasoning effort of the map agent alone |
| `model` | inherited | Model for all agents |

## Cost

This is deliberately expensive. The wide skill runs roughly one agent per function, plus `votes`
per finding, plus one per function whose caller assumptions were not checked, plus one per
lock-order cycle. The focused skill runs one agent per function and a few follow-ups at most. Use
them where a concurrency bug is costly, not on every change.

## Limits

- **Static reading only.** Nothing is built or run. A ThreadSanitizer run remains the way to
  confirm a data race for certain.
- **The split is by function.** A bug that only shows when three or more functions are seen
  together is covered only through caller assumptions, lock edges and follow-ups.
- **The ledger is self-reported.** Nothing parses the code to check that an agent listed every
  interleaving point, so an agent can still under-enumerate.
- **One map.** In the wide skill the map is built by a single agent; for a scope too large for one
  context, run it per subsystem.
- **Lock-cycle detection depends on naming.** It works only as far as agents use the lock ids from
  the map consistently.
- **One follow-up round.** What the follow-up analysts flag in turn is not analysed.
- **Relaxed memory orders.** Reasoning about weak memory orderings is hard to do by reading alone;
  treat `memory_order` findings with extra suspicion.

## Related work

The ledger and the split by location rather than by bug class follow the design of the `c-review`
plugin in [trailofbits/skills](https://github.com/trailofbits/skills), which partitions C/C++ code
into small units for security review and checks coverage against a parse.
