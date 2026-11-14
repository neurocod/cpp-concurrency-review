---
name: cpp-concurrency-review-small
description: Lightweight deep concurrency review of a small C++ scope - one diff with a few changes, one class, or a handful of named functions. You build the concurrency map yourself, then spawn one subagent per function with the Agent tool; each enumerates the interleaving points of its function and models what other threads can do at each one. You verify the findings and cross-check lock order and caller assumptions yourself. Use for thread-safety / race / deadlock / lifetime review when the scope is roughly ten functions or fewer. For a whole module or directory use cpp-concurrency-review-large (a Workflow with many agents) instead.
---

# Focused C++ concurrency review (hand-launched agents)

Same method as `cpp-concurrency-review-large`, without the Workflow: you are the orchestrator.
The value comes from giving each function an agent that does nothing else, so do not replace the
subagents with your own reading of the functions, however small the scope looks.

## 1. Scope and units

Resolve what to review:

- **Diff** - the diff the user named, else uncommitted changes, else the current branch against its
  base. Units are the functions the diff touches. Add an unchanged function only when the diff
  changes something it depends on: a lock removed or narrowed, a member no longer guarded, a
  lifetime or ownership change, a call moved to another thread, a changed locking contract.
- **Class** - its member functions that read or write shared state, take or release a lock, use a
  condition variable, start/join/detach a thread, post work elsewhere, or take part in lifetime
  (constructor that publishes `this`, destructor, stop/close/cancel, callback registration).
- **Named functions** - exactly those.

A lambda whose body runs later or on another thread is its own unit, separate from the function
that creates it. Skip functions that touch only locals and thread-confined state, and say which you
skipped.

If more than about 10 units remain, stop and tell the user the count: either they narrow the scope,
or they run `cpp-concurrency-review-large`. Do not silently review a subset.

## 2. Build the concurrency map yourself

Read the class or the changed files plus whatever creates their threads, calls into them and owns
their objects. Write the map down compactly; every subagent receives it verbatim:

- **Threads** - every execution context that can run this code (created threads, pools, executors,
  strands, event loops, timers, library callbacks, main) with entry points as file:line.
- **Locks** - canonical id (`Class::m_member`), declaration, kind, what it guards, per-instance or not.
- **Shared state** - each item, the lock guarding it (or "none" / "atomic" / "immutable after init"
  / "confined to <thread>"), and which threads touch it.
- **Lifetimes** - who owns each cross-thread object, where it is destroyed, what stops a thread or
  queued task from using it afterwards.
- **Conventions** - single-threaded executors, "public methods lock m_mutex", annotations,
  documented lock order.

Keep it factual. Do not start hunting for bugs here; if something catches your eye, note it and let
the function's agent confirm or refute it.

## 3. Launch one agent per unit

Fill `analyst-prompt.md` (in this skill's directory) once per unit and launch all of them in a
**single message** with the Agent tool, so they run in parallel:

- `subagent_type`: `general-purpose`
- `effort`: `high` - this skill asks for it; the agents must not hurry.
- `model`: leave unset unless the user asked for a specific one.
- `description`: `Analyze <function name>`

Then wait for every completion notification. Do not analyse the units yourself meanwhile, and do
not report anything before all agents are back.

## 4. Check what came back

For each agent's result:

1. **Ledger completeness.** Open the function and compare: does every shared-state access, lock
   operation, call under a lock, condition-variable operation and early exit have a row? If points
   are missing or the scenarios are one generic sentence repeated, send the agent back with
   SendMessage, naming the missing lines. One retry per agent.
2. **Verify each finding as a skeptic.** Read the code at every step of the trace. Try to refute:
   a lock both sides hold (including one taken by a caller), both sides confined to the same thread
   or strand, a happens-before edge (thread started after the write, joined before the read, task
   posted after the state was set, call_once), the object kept alive after all, a benign intended
   relaxation. Mark the finding confirmed, refuted (name the mechanism, file:line) or uncertain
   (name the fact that would settle it). For a critical finding you cannot settle yourself, spawn
   one more agent whose only task is to refute it.
3. **Assumptions.** For every assumption marked "not checked", look at the call sites yourself. A
   violated assumption is a finding; write its trace starting from the violating call site.
4. **Lock order.** Collect the lock edges of all agents and look for cycles, including a self-edge
   on a non-recursive mutex and the same member taken on two objects in opposite orders. For each
   cycle check whether the edges can run on different threads without a common outer lock.
5. **Pointers.** A pointer to a function that is not among the units: read it. If the suspicion
   looks real, either launch one more analyst for it (at most three follow-ups) or report it as
   not analysed.

## 5. Report

In the user's language, in this order:

1. Confirmed findings, most severe first: location, kind, the interleaving as numbered steps
   (thread - file:line - what happens), consequence, fix direction.
2. Lock-order cycles that survived.
3. Uncertain items - findings and "unsure" ledger rows - each with the fact that would settle it.
4. Coverage: units analysed (with the number of ledger points), functions skipped and why,
   follow-ups not done, anything the agents could not read.
5. One line on how many findings you refuted and why.

For a diff review, say for each confirmed finding whether the change introduced it or it was
already there.

Nothing is built or run; a ThreadSanitizer run remains the way to confirm a data race for certain.
