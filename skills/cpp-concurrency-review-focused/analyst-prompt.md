# Analyst prompt template

Fill every `{{...}}` and send the result as the prompt of one subagent. One subagent = one function.
Do not shorten the procedure; the level of detail is the point.

---

You are doing a deep concurrency analysis of ONE C++ function. Nobody is waiting; thoroughness is
the entire point. A reviewer looking at the whole class has already been tried and misses bugs
because it cannot afford this level of detail - you can.

Your function: {{qualified name}}
Location: {{file}}:{{first line}}-{{last line}}
Runs on: {{threads from the map that can execute it}}
Why it was selected: {{reason}}
{{DIFF MODE ONLY: What changed in it: <the hunk or a precise description>. Analyse the function as
it is NOW, but pay particular attention to what the change added, removed or reordered.}}

FOCUS RULE: you may and should read any surrounding code - callers, callees, every other function
that touches the same data or locks, the code that creates and destroys the object. But you build
scenarios ONLY about this function: what happens to the data and locks IT works with while other
parts of the program run. If you notice a problem that lives entirely in another function, do not
analyse it - record it under "Pointers" in one line and move on.

Concurrency map (built once for the whole scope; a strong hint - say so if you find it wrong):

{{the concurrency map, verbatim}}

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

Step 4 - Findings. Every "bug" verdict becomes a finding with a concrete interleaving trace. If you
cannot write the trace, it is "unsure", not a finding. Before reporting, try to refute it yourself:
a common lock, thread confinement (both sides run on the same single-threaded executor), a
happens-before edge from thread start/join or task posting, immutability after initialisation.

## Ground rules

- Read-only. Do not modify, build or run anything.
- Every claim must come from code you actually read; cite file:line. Never guess what a function
  does - open it.
- Use the lock ids from the concurrency map exactly.

## Return exactly these sections

```
## Entry state
calling threads / concurrent entry on the same object? / locks held on entry / what keeps things alive

## Ledger
| line | code | kind | locks held | scenario (which Q, what the other thread does) | outcome | verdict |
(every point from Step 2; several rows per point when several questions apply)

## Findings
### <title>  [kind] [severity: critical|high|medium|low] [confidence: high|medium|low]
Location: file:line
Trace:
1. <thread> - file:line - <action and resulting state>
2. ...
Why possible: <locks each side holds, why there is no happens-before>
Consequence: ...
Fix direction: ...
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
