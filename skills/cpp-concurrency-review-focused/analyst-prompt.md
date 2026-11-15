# Analyst prompt template

Fill every `{{...}}` and send everything below the `---` line as the prompt of one subagent. Do not
shorten the procedure; the level of detail is the point.

- One agent = one full unit. For the batch of trivial units, repeat the block from "Your function"
  to "Questions to probe" once per function and change the first sentence to "of EACH of these C++
  functions, one after another"; the agent writes one ledger per function into one report file.
- For a pair unit, name the consumer as the function and add the line "Its decision rests on:
  {{changed function, file:lines}} - analyse the consumer; treat this function as the thing that
  can change under it."
- Delete the DIFF REVIEW lines when the review is not of a diff, and the "Questions to probe" line
  when you have none. Write the questions as questions, never as statements.
- Give file paths the subagent can open as they are (absolute, or relative to the working
  directory).

---

You are doing a deep concurrency analysis of ONE C++ function. Nobody is waiting; thoroughness is
the entire point. A reviewer looking at a whole class at once misses bugs because it cannot afford
this level of detail - you can. Work and write in English.

Your function: {{qualified name}}
Location: {{file}}:{{first line}}-{{last line}}
Runs on: {{threads from the map that can execute it}}
Why it was selected: {{reason}}
{{DIFF REVIEW: What changed in it: <the hunk or a precise description>. Analyse the function as it
is NOW, but pay particular attention to what the change added, removed or reordered.}}
{{DIFF REVIEW: Base version: <ref>. `git show <ref>:<path>` shows the code before the change; you
need it to say whether a finding was introduced by the change.}}
{{Questions to probe (starting points, not conclusions - answer them from the code, and do not stop
at them): <open questions>}}

Concurrency map: read {{path to concurrency-map.md}} in full before anything else. It was built
once for the whole scope and every analyst works from the same file. Treat it as a strong hint, not
as ground truth: when the code contradicts it, the code wins, and you report the contradiction
under "Map corrections".

Write your full report to: {{review directory}}/{{nn}}-{{short unit name}}.md

FOCUS RULE: you may and should read any surrounding code - callers, callees, every other function
that touches the same data or locks, the code that creates and destroys the object. But you build
scenarios ONLY about this function: what happens to the data and locks IT works with while other
parts of the program run. If you notice a problem that lives entirely in another function, do not
analyse it - record it under "Pointers" in one line and move on.

## Procedure

Step 1 - Entry state. Find the call sites. Which threads can enter this function? Can two threads
be in it at once, on the same object? Which locks are already held on entry? What keeps `*this` and
every pointer / reference / iterator / string_view / span argument alive until the function returns?

Step 2 - Enumerate interleaving points. Go through the function line by line and list EVERY point
of these kinds, in source order (this list is the ledger; a missing point is a failure of the review):

- read of shared state; write of shared state; a check whose result is used later (check-then-act)
- lock acquired; lock released - including scope exit, manual unlock, and condition_variable wait
  (which releases and re-acquires)
- call made while holding a lock: callbacks, virtual calls, std::function, signals/slots,
  user-supplied functors, anything that may block (join, future.get, I/O, another lock)
- use of a pointer, reference, iterator, view or `this` that was obtained earlier and could have
  been invalidated since
- a task / lambda handed to another thread: what it captures, by value or by reference, and whether
  the captures outlive it
- thread start, join, detach; condition variable wait and notify; atomic operations (compound
  sequences, memory order, ABA)
- one-time initialisation, lazily created state, static locals, publication of `this` from a
  constructor
- destruction, stop, close, cancel, unregister
- every early return and every statement that can throw while a lock is held or an invariant is
  temporarily broken

Step 3 - Model each point. For every point, pause execution of your function exactly there and ask
what the rest of the program can do meanwhile. Answer the questions that apply, concretely, naming
the other function and its file:line:

- Q1 Another thread runs a writer of the same data right before this point, or between this point
  and the previous one. Is the result still correct?
- Q2 A second thread executes this same function on the same object and is at any other point of it.
- Q3 The object, pointee or container element used here is destroyed, moved from, erased or
  reallocated right now. Who prevents that? Now flip it: model the run where it has ALREADY been
  freed, and the run where it has NOT YET been created/initialised.
- Q4 The lock was dropped and re-taken earlier in the function (or was never held across a check
  and its use). Is everything that was read before still true here?
- Q5 Which locks are held here? If another lock is acquired, directly or inside a callee, record a
  lock edge. If foreign code is called under the lock, can it call back into this object or block?
- Q6 The function leaves at this point by exception or early return. Is the lock released, the
  invariant restored, the waiter notified?
- Q7 Shutdown / stop / destructor is in progress on another thread at this moment.

Vary the scenario per line: "data already freed here, not yet freed there", "notify arrives before
the wait", "the other thread is one line earlier". One generic answer for the whole function is not
acceptable. Give each scenario a verdict: **safe** (state the mechanism that makes it safe - which
lock, which happens-before edge), **bug**, or **unsure**.

When a verdict depends on what a standard-library facility guarantees (std::latch, std::jthread,
std::atomic<std::shared_ptr>, condition_variable, call_once), check it rather than recall it. If
the map gives the toolchain's include directory, read the header there; do not search the disk for
it.

Step 4 - Findings. Every "bug" verdict becomes a finding with a concrete interleaving trace. If you
cannot write the trace, it is "unsure", not a finding. Before reporting, try to refute it yourself:
a common lock, thread confinement (both sides run on the same single-threaded executor), a
happens-before edge from thread start/join or task posting, immutability after initialisation.

A mismatch between what a comment, a name or the documentation promises and what the code does is
NOT a finding unless you can write a trace in which the current code goes wrong because of it.
Without such a trace it goes under "Contract notes".

In a diff review, decide for each finding where it came from: read the base version and say whether
the same trace was possible before the change.

Step 5 - Contracts. Report:

- Assumptions: everything this function relies on from callers and environment ("caller holds X",
  "object outlives the call", "only called from thread T", "never called after stop()"). Write
  "checked: yes" only if you inspected every call site.
- Lock edges: every "holding X, acquire Y", following callees until they stop taking locks. Note
  when X and Y can be the same member on two different objects.
- Pointers: suspicions about other functions.
- Map corrections: every place where the map is wrong or incomplete in a way that matters - a path
  it lists that cannot happen, a thread or lock it misses, state it calls guarded that is not.
- Not examined: callees or call sites you could not read.

## Ground rules

- Do not modify, build or run the project. The only file you write is your report. Read-only git
  commands (`git show`, `git diff`, `git log`) are fine.
- Every claim must come from code you actually read; cite file:line. Never guess what a function
  does - open it.
- Use the lock ids from the concurrency map exactly. For a lock that is not in the map use
  `<Class>::<member>`.

## Output

Write the FULL report to the report file, with all of these sections:

```
## Entry state
calling threads / concurrent entry on the same object? / locks held on entry / what keeps things alive

## Ledger
| line | code | kind | locks held | scenario (which Q, what the other thread does) | outcome | verdict |
(every point from Step 2; several rows per point when several questions apply)

## Map corrections
- <map item> - <what the code shows instead> - evidence file:line
(or "None")

## Findings
### <title>  [kind] [severity: critical|high|medium|low] [confidence: high|medium|low]
Location: file:line
Trace:
1. <thread> - file:line - <action and resulting state>
2. ...
Why possible: <locks each side holds, why there is no happens-before>
Consequence: ...
Fix direction: ...
Origin: introduced by the change | made worse by the change | pre-existing | not determined - <what the base version does>   (diff review only)
(or "None")

## Contract notes
- file:line - promised: <what the comment / name / documentation says> - actual: <what the code does> - who could be misled
(or "None")

## Assumptions
- [lock-held|lifetime|thread-confinement|ordering|no-reentrancy] <statement> - checked at every call site: yes/no - evidence

## Lock edges
- holding <X>, acquires <Y> at file:line (direct | via <call chain>) - same object or possibly two objects

## Pointers
- file:line <function> - <one-line suspicion about OTHER code>

## Not examined
<callees or call sites you could not read>
```

Then REPLY with a short version only - the orchestrator opens the file when it needs the ledger:

```
Report: <path of the file you wrote>
Ledger: <N> points, <M> scenarios - <a> safe, <b> bug, <c> unsure
Unsure rows: <line - one-line reason, for each>

(then these sections copied in full from the report)
## Map corrections
## Findings
## Contract notes
## Assumptions
## Lock edges
## Pointers
## Not examined
```
