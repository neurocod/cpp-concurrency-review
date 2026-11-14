---
name: cpp-concurrency-review-large
description: Deep concurrency review of C++ code that gives every relevant function its own subagent. Each agent enumerates the interleaving points of one function and models, line by line, what other threads can do at that moment (data freed / not yet freed, lock dropped and re-taken, notify before wait, shutdown in progress). Findings must be concrete interleaving traces and are checked by skeptic agents; lock-order cycles and caller-side assumptions are cross-checked across functions. Use when the user asks for a thorough multithreading / thread-safety / race / deadlock / lifetime review of a C++ class, module or directory, or says an ordinary review was too shallow. Not for a small diff, a single class or a handful of functions - it runs many agents; use cpp-concurrency-review-small for those.
---

# C++ concurrency review, one function per agent

## Why it is built this way

An agent reviewing a whole class or module does not have the context budget, or the patience, to
model detailed interleavings for every line. A human finds more because they sit on one function
and ask, for each line, "what is the rest of the program doing right now?". This skill reproduces
that:

1. **Map** - one agent builds a shared concurrency map (threads, locks and what they guard, shared
   state, object lifetimes, project conventions) and selects the functions worth a deep look.
   Asynchronously executed lambdas are separate units.
2. **Analyze** - one agent per function. It may read any surrounding code, but builds scenarios
   only for its own function. It must fill a ledger: every interleaving point of the function, each
   with explicit scenarios and a verdict. The ledger is what stops the agent from finishing early.
3. **Verify** - each finding (a concrete interleaving trace) goes to a skeptic agent that tries to
   refute it from the code.
4. **Cross-check** - what no single function can see: unchecked caller assumptions are checked at
   the call sites, lock-acquisition edges from all functions are combined into a graph and its
   cycles are examined, and functions that analysts flagged but nobody analysed get a follow-up
   round.

## How to run

Invoking this skill is the user's opt-in to multi-agent orchestration. Make **one** `Workflow`
call; do not hand-spawn the agents and do not shrink the fan-out on your own judgment.

1. Resolve the scope from the user's request: a file, a class, a directory, or an explicit list of
   functions. If the request names none, use the files changed on the current branch; if there are
   none either, ask.
2. Call `Workflow` with `scriptPath` set to `workflow.js` in this skill's directory and `args`:

   | arg | default | meaning |
   |---|---|---|
   | `scope` | `"."` | Path(s) or description of what to review. Required in practice. |
   | `focus` | none | Array of function names the user asked about; always analysed first. |
   | `notes` | none | Anything the user said about the threading model, known problem areas, conventions. |
   | `maxFunctions` | 40 | Cap on analysed functions (highest priority first). Dropped ones are logged and returned. |
   | `maxFollowups` | 10 | Cap on the follow-up round. `0` disables it. |
   | `votes` | 1 | Skeptics per finding. Use 3 when the user wants high confidence. |
   | `effort` | `"high"` | Reasoning effort of analysis agents. |
   | `verifyEffort` | = `effort` | Reasoning effort of verifiers and cross-checks. |
   | `model` | inherit | Model override for all agents. Set only if the user asks. |

   Cost is roughly one agent per function, plus one per finding, plus one per function with
   unchecked assumptions. Tell the user the function count once the map is logged if it is large.
3. Wait for the completion notification. Do not review the code yourself in the meantime.

## Report

The workflow returns `confirmed`, `uncertain`, `refuted`, `lock_cycles`, `assumptions`, `coverage`,
`failed_units`, `not_analysed`, `map`. Write the report in the user's language:

1. **Confirmed findings**, most severe first. For each: location, kind, the interleaving as numbered
   steps (thread - file:line - what happens), the consequence, the fix direction. Use the verifier's
   `corrected_trace` when present. Before reporting, open each cited file:line and check the code is
   what the trace says; drop or downgrade anything that does not match and say so.
2. **Lock-order cycles** whose verdict is confirmed or uncertain, with the edges.
3. **Uncertain** - findings and `unsure` ledger rows that depend on something the agents could not
   establish. Say what fact would settle each; these are the items a human should look at.
4. **Violated or unclear caller assumptions** that did not become findings.
5. **Coverage** - functions analysed (with number of points and scenarios), functions that failed,
   functions not analysed because of the caps, and what the map agent did not read. Never present a
   capped run as complete.
6. One line on refuted findings: how many, and the commonest reason.

Do not pad the report with the map or the full ledger; offer them if the user wants the detail.

## Limits

- The split is by function, so bugs that need three or more functions to be seen together are
  covered only through assumptions, lock edges and the follow-up round.
- The map is built by one agent. For a scope too large for one context, run the skill per
  subsystem.
- Analysis is static reading only. Nothing is built or run; a ThreadSanitizer run remains the way to
  confirm a data race for certain.
