---
name: cpp-concurrency-review-focused
description: Deep concurrency review of a small C++ scope - one diff with a few changes, one class, or a handful of named functions. You build the concurrency map yourself, then spawn one subagent per function with the Agent tool; each enumerates the interleaving points of its function and models what other threads can do at each one. You verify the findings and cross-check lock order and caller assumptions yourself. Use for thread-safety / race / deadlock / lifetime review when the scope is roughly ten non-trivial functions or fewer. For a whole module or directory use cpp-concurrency-review-wide (a Workflow with many agents) instead.
---

# Focused C++ concurrency review (hand-launched agents)

Same method as `cpp-concurrency-review-wide`, without the Workflow: you are the orchestrator.
The value comes from giving each function an agent that does nothing else, so do not replace the
subagents with your own reading of the functions, however small the scope looks.

Subagents work and report in English; you write the final report in the user's language.

## 1. Scope and units

Resolve what to review:

- **Diff** - the diff the user named, else uncommitted changes, else the current branch against its
  base. Note the base ref; the agents need it. Units are the functions the diff touches, plus the
  dependent functions described below.
- **Class** - its member functions that read or write shared state, take or release a lock, use a
  condition variable, start/join/detach a thread, post work elsewhere, or take part in lifetime
  (constructor that publishes `this`, destructor, stop/close/cancel, callback registration).
- **Named functions** - exactly those.

A lambda whose body runs later or on another thread is its own unit, separate from the function
that creates it. Skip functions that touch only locals and thread-confined state, and say which you
skipped.

### Dependent functions (diff review)

An unchanged function becomes a unit when the diff changes something it depends on. Look for two
things:

- **Changed protection**: a lock removed or narrowed, a member no longer guarded, a lifetime or
  ownership change, a call moved to another thread.
- **Changed contract**: for every changed function whose observable behaviour changed - what it
  returns, the moment a result flips (true to false, null to non-null), whether it blocks, whether
  it may throw, which thread it may be called from - find every place where a decision is made on
  its result or on that behaviour. Each such consumer is a unit. These units tend to hold the most
  substantial scenarios, so do not economise on them.

A consumer may be reviewed as a **pair unit**: the consuming function together with the changed
function its decision rests on. The agent analyses the consumer and treats the source as the thing
that can change under it. Use a pair when the consumer is not understandable without the source.

### Trivial and full units

Sort the units into two tiers:

- **Trivial** - a body of about five lines or fewer with at most two interleaving points: a
  one-line accessor, a thread-id comparison, a move constructor that is one `exchange`. Never
  trivial, whatever the length: destructors, stop/close/cancel, anything that drops and re-takes a
  lock or waits on a condition variable, a lambda that runs on another thread, and any function
  whose contract the diff changed.
- **Full** - everything else.

Each full unit gets its own agent. Trivial units go together to one agent (two if there are more
than about eight), which runs the same procedure on each.

Only full units count towards the limit. If more than about 10 full units remain, stop and tell the
user the count: either they narrow the scope, or they run `cpp-concurrency-review-wide`. Do not
silently review a subset.

If no unit remains - nothing in the scope touches shared state - say so and stop; do not launch
agents for the sake of it.

## 2. Build the concurrency map yourself

Read the class or the changed files plus whatever creates their threads, calls into them and owns
their objects. Write the map compactly:

- **Threads** - every execution context that can run this code (created threads, pools, executors,
  strands, event loops, timers, library callbacks, main) with entry points as file:line.
- **Locks** - canonical id (`Class::m_member`), declaration, kind, what it guards, per-instance or not.
- **Shared state** - each item, the lock guarding it (or "none" / "atomic" / "immutable after init"
  / "confined to <thread>"), and which threads touch it.
- **Lifetimes** - who owns each cross-thread object, where it is destroyed, what stops a thread or
  queued task from using it afterwards.
- **Conventions** - single-threaded executors, "public methods lock m_mutex", annotations,
  documented lock order.
- **Toolchain** - the include directory of the standard library the project builds with, if you
  can find it cheaply (compile_commands.json, the build configuration, the compiler's own search
  path). Agents use it to check what `std::latch`, `std::atomic<std::shared_ptr>`, `std::jthread`
  and the like really do instead of searching the disk for the headers. Write "unknown" otherwise.

Keep it factual. Do not start hunting for bugs here.

Create a review directory outside the repository - in the session's scratchpad directory if there
is one, otherwise in the system temporary directory - and write the map there as
`concurrency-map.md`. Every agent reads that one file; do not paste the map into the prompts. Agent
reports go into the same directory.

## 3. Launch the agents

Fill `analyst-prompt.md` (in this skill's directory) once per agent and launch all of them in a
**single message** with the Agent tool, so they run in parallel:

- `subagent_type`: `general-purpose`
- `effort`: `high` - this skill asks for it; the agents must not hurry.
- `model`: leave unset unless the user asked for a specific one.
- `description`: `Analyze <function name>`

**Questions to probe.** If something caught your eye while building the map, pass it to the unit's
agent in the "Questions to probe" slot of the template - as open questions ("what happens if
pre_run throws after the worker thread has started?", "who joins the thread when the object is
moved from?"), never as statements ("the join is unprotected"). A question sends the agent deeper;
a statement comes back confirmed whether or not it is true. Leave the slot out when you have
nothing specific.

### While they run

Agents at high effort take several minutes each. As completion notifications arrive:

- Tell the user briefly how many agents are back and how many are still running.
- Start step 4 on each result as it arrives: checking a ledger and verifying a finding against the
  code is your job and does not need the other agents.
- Do not analyse a unit whose agent has not returned, and do not give the final report before all
  agents are back.

If an agent fails or returns nothing usable, relaunch it once; if it fails again, list the unit as
not analysed.

## 4. Check what came back

Each agent writes its full report (with the ledger) to a file in the review directory and replies
with a short version: map corrections, findings, contract notes, assumptions, lock edges, pointers
and the ledger counts. The reports are claims, not facts: an agent can misread the code as
confidently as it reads it.

1. **Map corrections first.** Collect the corrections from all agents and check each against the
   code. Apply the ones that hold to `concurrency-map.md`. Then re-read every finding, from any
   agent, that relies on the corrected item: a trace built on a path the correction shows to be
   unreachable is refuted, and a correction that removes a protection may turn a "safe" verdict
   into a question for you to answer.
2. **Ledger completeness.** Open the agent's report file and the function side by side: does every
   shared-state access, lock operation, call under a lock, condition-variable operation and early
   exit have a row? If points are missing or the scenarios are one generic sentence repeated, send
   the agent back with SendMessage, naming the missing lines. One retry per agent.
3. **Group by root cause.** Several agents usually report one defect from different sides: the
   constructor, the move constructor, the worker lambda and the stop function all see the same
   unprotected join. Group the findings by root cause before verifying. Assign each group to the
   **owner unit** - the function where the fix belongs - and keep the others as corroboration and
   as additional traces. One group is one finding in the report.
4. **Verify each group as a skeptic.** Read the code at every step of the trace. Try to refute:
   a lock both sides hold (including one taken by a caller), both sides confined to the same thread
   or strand, a happens-before edge (thread started after the write, joined before the read, task
   posted after the state was set, call_once), the object kept alive after all, a benign intended
   relaxation. Mark the finding confirmed, refuted (name the mechanism, file:line) or uncertain
   (name the fact that would settle it). For a critical finding you cannot settle yourself, spawn
   one more agent whose only task is to refute it.
5. **Origin (diff review).** For each confirmed finding check the agent's "Origin" line against the
   base version of the code yourself: introduced by the change, pre-existing, or made worse by it.
6. **Assumptions.** For every assumption marked "not checked", look at the call sites yourself. A
   violated assumption is a finding; write its trace starting from the violating call site.
7. **Lock order.** Collect the lock edges of all agents and look for cycles, including a self-edge
   on a non-recursive mutex and the same member taken on two objects in opposite orders. For each
   cycle check whether the edges can run on different threads without a common outer lock.
8. **Pointers.** A pointer to a function that is not among the units: read it. If the suspicion
   looks real, either launch one more analyst for it (at most three follow-ups) or report it as
   not analysed.
9. **Contract notes.** These are mismatches between what a comment, a name or the documentation
   promises and what the code does, with no incorrect execution in the current code. Check that
   each mismatch is real. If you can show a caller that relies on the promise and goes wrong, it is
   a finding, not a note.

## 5. Report

In the user's language, in this order:

1. Confirmed findings, most severe first, one per root cause: location (the owner unit), kind, the
   interleaving as numbered steps (thread - file:line - what happens), consequence, fix direction,
   and which other units showed the same defect. For a diff review, each one says whether the
   change introduced it, made it worse, or it was already there.
2. Lock-order cycles that survived.
3. Uncertain items - findings and "unsure" ledger rows - each with the fact that would settle it.
4. Contract and documentation mismatches, as a separate short list. Keep them out of the findings:
   they are not races, and mixed in they bury the ones that are.
5. Coverage: units analysed (with the number of ledger points), which were reviewed as a trivial
   batch, functions skipped and why, follow-ups not done, anything the agents could not read.
6. One line on how many findings you refuted and why, and which map corrections you applied.

Give the path of the review directory so the user can open the full ledgers.

Nothing is built or run; a ThreadSanitizer run remains the way to confirm a data race for certain.
