---
name: cpp-concurrency-review-wide
description: Deep concurrency review of a C++ module or directory that gives every relevant function its own subagent, run as a Workflow. Each agent enumerates the interleaving points of one function and models, line by line, what other threads can do at that moment (data freed / not yet freed, lock dropped and re-taken, notify before wait, shutdown in progress). Findings must be concrete interleaving traces and are checked by skeptic agents; lock-order cycles and caller-side assumptions are cross-checked across functions. Use when the user asks for a thorough multithreading / thread-safety / race / deadlock / lifetime review of a C++ module, directory or several classes, or says an ordinary review was too shallow. Not for a small diff, a single class or a handful of functions (about ten or fewer) - it runs many agents; use cpp-concurrency-review-focused for those.
---

# C++ concurrency review, one function per agent

## Why it is built this way

An agent reviewing a whole class or module does not have the context budget, or the patience, to
model detailed interleavings for every line. A human finds more because they sit on one function
and ask, for each line, "what is the rest of the program doing right now?". This skill reproduces
that:

1. **Map** - one agent builds a shared concurrency map (threads, locks and what they guard, shared
   state, object lifetimes, project conventions, where the standard-library headers are) and
   selects the functions worth a deep look.
   Asynchronously executed lambdas are separate units.
2. **Analyze** - one agent per function. It may read any surrounding code, but builds scenarios
   only for its own function. It must fill a ledger: every interleaving point of the function, each
   with explicit scenarios and a verdict. The ledger is what stops the agent from finishing early.
3. **Verify** - each finding (a concrete interleaving trace) goes to a skeptic agent that tries to
   refute it from the code. Unchecked caller assumptions of the function are checked at its call
   sites at the same time, and a violated one becomes a finding that is verified the same way.
4. **Cross-check** - what no single function can see: lock-acquisition edges from all functions
   are combined into a graph and its cycles are examined, and functions that analysts flagged but
   nobody analysed get one follow-up round.

## How to run

Invoking this skill is the user's opt-in to multi-agent orchestration. Make **one** `Workflow`
call; do not hand-spawn the agents and do not shrink the fan-out on your own judgment.

1. Resolve the scope from the user's request: files, classes, a directory, or an explicit list of
   functions. If the request names none, use the files changed on the current branch; if there are
   none either, ask. If the scope is plainly a handful of functions, say that
   `cpp-concurrency-review-focused` does the same for less and use it unless the user insists.
2. Call `Workflow` with `scriptPath` set to the absolute path of `workflow.js` in this skill's
   directory, and `args` as a JSON object (not a JSON-encoded string):

   | arg | default | meaning |
   |---|---|---|
   | `scope` | `"."` | Path(s) or description of what to review. Required in practice. |
   | `focus` | none | Array of function names the user asked about; analysed first, never cut by the cap. |
   | `notes` | none | Anything the user said about the threading model, known problem areas, conventions. |
   | `maxFunctions` | 40 | Cap on analysed functions (highest priority first). Dropped ones are logged and returned. |
   | `maxFollowups` | 10 | Cap on the follow-up round. `0` disables it. |
   | `votes` | 1 | Skeptics per finding. Use 3 when the user wants high confidence; an even number produces ties, which count as uncertain. |
   | `effort` | `"high"` | Reasoning effort of the map and analysis agents. |
   | `verifyEffort` | = `effort` | Reasoning effort of verifiers and cross-checks. |
   | `mapEffort` | = `effort` | Reasoning effort of the map agent alone. |
   | `model` | inherit | Model override for all agents. Set only if the user asks. |

   Before the call, tell the user in one line what it can cost: up to `maxFunctions` +
   `maxFollowups` analysis agents, plus `votes` agents per finding, plus one per function with
   unchecked assumptions, plus one per lock-order cycle. The real function count is known only
   after the map agent returns, and you do not see it until the run ends.
3. Wait for the completion notification. Tell the user the run takes a while (agents at high
   effort work for several minutes each) and that `/workflows` shows live progress. Do not review
   the code yourself in the meantime.

## Report

The workflow returns `scope`, `map`, `confirmed`, `uncertain`, `refuted`, `lock_cycles`,
`lock_cycles_truncated`, `contract_notes`, `map_corrections`, `assumptions`, `coverage`,
`failed_units`, `not_analysed`, `lock_edges`. If it returns `error` instead, nothing was analysed:
report that and the reason, and do not fall back to reviewing the code yourself without saying so.

The agents write in English; write the report in the user's language. Before writing it:

- **Apply the map corrections.** `map_corrections` lists where analysts found the map wrong. Each
  verifier saw only the corrections of its own analyst, so check the corrections against the code
  and then re-read every confirmed finding and lock cycle that relies on a corrected item: a trace
  built on a path a correction shows to be unreachable is refuted.
- **Group by root cause.** Several functions usually report one defect from different sides (the
  constructor, the move constructor, the worker lambda and the stop function all see the same
  unprotected join). Group the findings by root cause, assign each group to the owner function -
  the one where the fix belongs - and treat the rest as corroboration. One group is one finding.

Then, in this order:

1. **Confirmed findings**, most severe first, one per root cause. For each: location, kind, the
   interleaving as numbered steps (thread - file:line - what happens), the consequence, the fix
   direction, and which other functions showed the same defect. Use the verifier's
   `corrected_trace` and severity when present. Before reporting, open each cited file:line and
   check the code is what the trace says; drop or downgrade anything that does not match and say
   so.
2. **Lock-order cycles** whose verdict is `confirmed`, `uncertain` or `unverified`, with the edges.
   Say so if `lock_cycles_truncated` is true.
3. **Uncertain** - findings in `uncertain` (including split votes and findings whose verifier did
   not return) and `unsure` ledger rows from `coverage`. Say what fact would settle each; these are
   the items a human should look at.
4. **Violated or unclear caller assumptions** that did not become findings, and functions whose
   assumption check failed.
5. **Contract and documentation mismatches** from `contract_notes`, as a separate short list: a
   comment, name or document promises one thing and the code does another, with no incorrect
   execution shown. They are not verified by skeptics; check each is real before listing it. Keep
   them out of the findings - mixed in, they bury the real races.
6. **Coverage** - functions analysed (with number of points and scenarios), `failed_units`,
   `not_analysed` with the cap that cut each, and what the map agent did not read
   (`map.not_covered`). Point out a function whose ledger has very few points for its length: the
   ledger is self-reported and that is how under-enumeration shows. Never present a capped or
   partly failed run as complete.
7. One line on refuted findings: how many, and the commonest reason; and which map corrections you
   accepted.

Do not pad the report with the map or the full ledger; offer them if the user wants the detail.

## Limits

- The split is by function, so bugs that need three or more functions to be seen together are
  covered only through assumptions, lock edges and the follow-up round.
- The map is built by one agent. For a scope too large for one context, run the skill per
  subsystem.
- Lock-order cycles are found by comparing lock ids as text, so they are found only as far as the
  agents spell the ids as the map does. `lock_edges` holds the raw edges if a cycle looks missed.
- The follow-up round runs once; what the follow-up analysts flag in turn is not analysed.
- Analysis is static reading only. Nothing is built or run; a ThreadSanitizer run remains the way to
  confirm a data race for certain.
