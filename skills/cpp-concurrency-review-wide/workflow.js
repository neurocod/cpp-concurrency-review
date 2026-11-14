export const meta = {
  name: 'cpp-concurrency-review-large',
  description: 'C++ concurrency review: build a shared concurrency map, deep-analyse one function per agent, verify each finding, cross-check lock order and caller assumptions',
  whenToUse: 'Thorough concurrency review of a C++ class, module or directory where a whole-module single-agent review is too shallow',
  phases: [
    { title: 'Map', detail: 'one agent inventories threads, locks, shared state, lifetimes and picks the functions to analyse' },
    { title: 'Analyze', detail: 'one agent per function: interleaving-point ledger and scenarios' },
    { title: 'Verify', detail: 'skeptic agents try to refute each finding' },
    { title: 'Cross-check', detail: 'lock-order cycles, caller assumptions, follow-up functions' },
  ],
}

// ---------------------------------------------------------------- arguments

const A = typeof args === 'string' ? { scope: args } : (args || {})
const SCOPE = A.scope || '.'
const FOCUS = Array.isArray(A.focus) ? A.focus : (A.focus ? [A.focus] : [])
const NOTES = A.notes || ''
const MAX_FUNCTIONS = A.maxFunctions || 40
const MAX_FOLLOWUPS = A.maxFollowups === undefined ? 10 : A.maxFollowups
const VOTES = A.votes || 1
const ANALYZE_EFFORT = A.effort || 'high'
const VERIFY_EFFORT = A.verifyEffort || A.effort || 'high'
const MODEL = A.model

function opts(base, effort) {
  const o = Object.assign({}, base)
  if (effort) o.effort = effort
  if (MODEL) o.model = MODEL
  return o
}

// ------------------------------------------------------------------ schemas

const STR = { type: 'string' }
const INT = { type: 'integer' }
const STR_LIST = { type: 'array', items: STR }

const UNIT = {
  type: 'object',
  properties: {
    id: STR,
    file: STR,
    name: { type: 'string', description: 'Qualified function name; for an asynchronously executed lambda: "Enclosing::function lambda@<line>"' },
    line_start: INT,
    line_end: INT,
    priority: { type: 'integer', description: '1 = highest risk, 3 = lowest' },
    runs_on: { type: 'string', description: 'Thread ids from the map that can execute this unit' },
    why: STR,
  },
  required: ['id', 'file', 'name', 'line_start', 'line_end', 'priority', 'runs_on', 'why'],
}

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: STR,
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, description: STR, entry_points: STR_LIST },
        required: ['id', 'description', 'entry_points'],
      },
    },
    locks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Canonical id, e.g. "Session::m_mutex"' },
          declaration: { type: 'string', description: 'file:line' },
          kind: { type: 'string', description: 'std::mutex, recursive, shared_mutex, spinlock, custom, ...' },
          guards: STR,
          per_instance: { type: 'boolean', description: 'false for static/global locks' },
        },
        required: ['id', 'declaration', 'kind', 'guards', 'per_instance'],
      },
    },
    shared_state: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: STR, declaration: STR, guarded_by: STR, accessed_from: STR, notes: STR },
        required: ['id', 'declaration', 'guarded_by', 'accessed_from'],
      },
    },
    lifetimes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { object: STR, owner: STR, destroyed_where: STR, notes: STR },
        required: ['object', 'owner', 'destroyed_where'],
      },
    },
    conventions: { type: 'string', description: 'Project idioms that matter: executors/strands, event loops, thread-safety annotations, lock wrappers, documented locking rules' },
    units: { type: 'array', items: UNIT },
    not_covered: STR,
  },
  required: ['summary', 'threads', 'locks', 'shared_state', 'lifetimes', 'conventions', 'units', 'not_covered'],
}

const FINDING = {
  type: 'object',
  properties: {
    title: STR,
    kind: {
      type: 'string',
      enum: ['data-race', 'atomicity-violation', 'order-violation', 'deadlock', 'lock-order', 'use-after-free', 'lifetime',
        'iterator-invalidation', 'lost-wakeup', 'condition-variable', 'double-checked-locking', 'atomics-misuse',
        'reentrancy', 'shutdown-race', 'initialization-race', 'exception-path', 'other'],
    },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    file: STR,
    line: INT,
    trace: {
      type: 'array',
      description: 'The concrete interleaving, in execution order',
      items: {
        type: 'object',
        properties: {
          thread: STR,
          location: { type: 'string', description: 'file:line' },
          action: { type: 'string', description: 'What this thread does at this step and the resulting state' },
        },
        required: ['thread', 'location', 'action'],
      },
    },
    why_possible: { type: 'string', description: 'Why both threads can be at these points at once: locks each holds, absence of happens-before' },
    consequence: STR,
    fix_hint: STR,
  },
  required: ['title', 'kind', 'severity', 'confidence', 'file', 'line', 'trace', 'why_possible', 'consequence'],
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    entry_state: {
      type: 'object',
      properties: {
        calling_threads: STR,
        locks_held_on_entry: STR_LIST,
        lifetime_guarantees: { type: 'string', description: 'What keeps *this and every pointer/reference argument alive for the whole call' },
      },
      required: ['calling_threads', 'locks_held_on_entry', 'lifetime_guarantees'],
    },
    points: {
      type: 'array',
      description: 'The interleaving-point ledger: EVERY point in the function, in source order',
      items: {
        type: 'object',
        properties: {
          line: INT,
          code: STR,
          kind: STR,
          locks_held: STR_LIST,
          scenarios: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: {
                question: STR,
                outcome: STR,
                verdict: { type: 'string', enum: ['safe', 'bug', 'unsure'] },
              },
              required: ['question', 'outcome', 'verdict'],
            },
          },
        },
        required: ['line', 'code', 'kind', 'locks_held', 'scenarios'],
      },
    },
    findings: { type: 'array', items: FINDING },
    assumptions: {
      type: 'array',
      description: 'Everything this function needs from its callers/environment to be correct',
      items: {
        type: 'object',
        properties: {
          statement: STR,
          kind: { type: 'string', enum: ['lock-held', 'lifetime', 'thread-confinement', 'ordering', 'no-reentrancy', 'other'] },
          checked: { type: 'boolean', description: 'true only if you checked EVERY call site yourself' },
          evidence: STR,
        },
        required: ['statement', 'kind', 'checked', 'evidence'],
      },
    },
    lock_edges: {
      type: 'array',
      description: 'Each "while holding X, acquires Y", including acquisitions inside callees',
      items: {
        type: 'object',
        properties: {
          held: STR,
          acquired: STR,
          line: INT,
          via: { type: 'string', description: '"direct" or the call chain that reaches the acquisition' },
          instances: { type: 'string', description: 'same object, or possibly different objects of the same class' },
        },
        required: ['held', 'acquired', 'line', 'via'],
      },
    },
    pointers: {
      type: 'array',
      description: 'Suspicions about OTHER functions, noticed while reading around',
      items: {
        type: 'object',
        properties: { file: STR, function: STR, line: INT, suspicion: STR },
        required: ['file', 'function', 'line', 'suspicion'],
      },
    },
    not_examined: STR,
  },
  required: ['entry_state', 'points', 'findings', 'assumptions', 'lock_edges', 'pointers', 'not_examined'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    reasoning: STR,
    corrected_trace: { type: 'string', description: 'If the bug is real but the trace was imprecise, the corrected interleaving; else empty' },
    severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
  },
  required: ['verdict', 'reasoning', 'severity'],
}

const ASSUMPTION_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          statement: STR,
          holds: { type: 'string', enum: ['yes', 'no', 'unclear'] },
          evidence: { type: 'string', description: 'Call sites checked, as file:line' },
        },
        required: ['statement', 'holds', 'evidence'],
      },
    },
    violations: { type: 'array', items: FINDING },
  },
  required: ['results', 'violations'],
}

// ------------------------------------------------------------------ prompts

const RULES = `Ground rules:
- Read-only. Do not modify, build or run anything.
- Every claim must come from code you actually read; cite file:line. Never guess what a function does - open it.
- Lock ids: use the ids from the concurrency map exactly. For a lock that is not in the map use "<Class>::<member>" or "<file>:<line> <name>".`

function mapPrompt() {
  return `You are preparing a C++ concurrency review. Your job is NOT to find bugs yet: it is to build the shared concurrency map that other agents will rely on, and to choose which functions deserve a dedicated deep analysis.

Scope to review: ${SCOPE}
${FOCUS.length ? `The user asked specifically for these functions (they must all appear in "units", priority 1): ${FOCUS.join(', ')}` : ''}
${NOTES ? `Notes from the user: ${NOTES}` : ''}

Read the code in scope, plus whatever outside it creates threads for it, calls into it, or owns its objects.

Produce:
1. threads - every execution context that can run code in scope: explicitly created threads, thread pools / executors / strands, event loops, timers, OS or library callbacks, signal handlers, the main thread. Give each a short id and its entry points (file:line).
2. locks - every mutex / shared_mutex / spinlock / custom lock: canonical id, declaration, kind, what it is meant to guard (from comments, annotations such as GUARDED_BY, or observed usage), and whether it is per-instance.
3. shared_state - every piece of state reachable from more than one thread: members, globals, statics, captured variables, objects passed between threads. For each: the lock that guards it ("none", "atomic", "immutable after init", "confined to <thread>") and which threads touch it.
4. lifetimes - for each object used across threads: who owns it, where it is destroyed, and what stops a thread or queued task from using it afterwards (join, shared_ptr, weak_ptr, cancellation token, nothing).
5. conventions - project idioms an analyst must know (single-threaded executors, "all public methods lock m_mutex", lock wrappers, annotations, documented locking order).
6. units - the functions to analyse in depth, one unit per function. Include a function when it reads or writes shared state, acquires/releases a lock, waits on or notifies a condition variable, starts/joins/detaches a thread, posts work to another thread, or takes part in object lifetime (constructors that publish "this", destructors, stop/close/shutdown/cancel, callback (un)registration). A lambda whose body runs later or on another thread is its OWN unit, separate from the function that creates it. Skip functions that touch only locals and confined state. Order by priority: 1 = most likely to hide a bug (lifetime and shutdown paths, check-then-act, multiple locks, condition variables, lock dropped and re-taken, callbacks invoked under a lock), 3 = simple fully-locked accessors.
7. not_covered - what you did not read.

Keep the map factual and compact: other agents receive it verbatim.

${RULES}`
}

function analyzePrompt(u, mapText) {
  return `You are doing a deep concurrency analysis of ONE C++ function. Nobody is waiting; thoroughness is the entire point. A reviewer looking at the whole module has already been tried and misses bugs because it cannot afford this level of detail - you can.

Your function: ${u.name}
Location: ${u.file}:${u.line_start}-${u.line_end}
Runs on: ${u.runs_on}
Why it was selected: ${u.why}
${u.suspicion ? `Another analyst flagged it: ${u.suspicion}` : ''}

FOCUS RULE: you may and should read any surrounding code - callers, callees, every other function that touches the same data or locks, the code that creates and destroys the object. But you build scenarios ONLY about this function: what happens to the data and locks IT works with while other parts of the program run. If you notice a problem that lives entirely in another function, do not analyse it - record it under "pointers" in one line and move on.

Concurrency map (built once for the whole scope; treat as a strong hint, and say so in "not_examined" if you find it wrong):
${mapText}

Procedure

Step 1 - Entry state. Find the call sites. Which threads can enter this function? Can two threads be in it at once, on the same object? Which locks are already held on entry? What keeps *this and every pointer / reference / iterator / string_view / span argument alive until the function returns?

Step 2 - Enumerate interleaving points. Go through the function line by line and list EVERY point of these kinds, in source order (this list is the ledger; a missing point is a failure of the review):
  - read of shared state; write of shared state; a check whose result is used later (check-then-act)
  - lock acquired; lock released - including scope exit, manual unlock, and condition_variable wait (which releases and re-acquires)
  - call made while holding a lock: callbacks, virtual calls, std::function, signals/slots, user-supplied functors, anything that may block (join, future.get, I/O, another lock)
  - use of a pointer, reference, iterator, view or "this" that was obtained earlier and could have been invalidated since
  - a task / lambda handed to another thread: what it captures, by value or by reference, and whether the captures outlive it
  - thread start, join, detach; condition variable wait and notify; atomic operations (compound sequences, memory order, ABA)
  - one-time initialisation, lazily created state, static locals, publication of "this" from a constructor
  - destruction, stop, close, cancel, unregister
  - every early return and every statement that can throw while a lock is held or an invariant is temporarily broken

Step 3 - Model each point. For every point, pause execution of your function exactly there and ask what the rest of the program can do meanwhile. Answer at least the questions that apply, concretely, naming the other function and its file:line:
  Q1 Another thread runs a writer of the same data right before this point, or between this point and the previous one. Is the result still correct?
  Q2 A second thread executes this same function on the same object and is at any other point of it.
  Q3 The object, pointee or container element used here is destroyed, moved from, erased or reallocated right now. Who prevents that? Now flip it: model the run where it has ALREADY been freed, and the run where it has NOT YET been created/initialised.
  Q4 The lock was dropped and re-taken earlier in the function (or was never held across a check and its use). Is everything that was read before still true here?
  Q5 Which locks are held here? If another lock is acquired, directly or inside a callee, record a lock edge. If foreign code is called under the lock, can it call back into this object or block?
  Q6 The function leaves at this point by exception or early return. Is the lock released, the invariant restored, the waiter notified?
  Q7 Shutdown / stop / destructor is in progress on another thread at this moment.
  Vary the scenario per line: "data already freed here, not yet freed there", "notify arrives before the wait", "the other thread is one line earlier". One generic answer for the whole function is not acceptable.
  Give each scenario a verdict: safe (state the mechanism that makes it safe - which lock, which happens-before edge), bug, or unsure.

Step 4 - Findings. Every "bug" verdict becomes a finding with a concrete interleaving trace: ordered steps of the form thread / file:line / action and resulting state, ending in the incorrect outcome. If you cannot write the trace, it is "unsure", not a finding. Before reporting, try to refute it yourself: a common lock, thread confinement (both sides run on the same single-threaded executor), a happens-before edge from thread start/join or task posting, immutability after initialisation.

Step 5 - Contracts. Report:
  - assumptions: everything this function relies on from callers and environment ("caller holds X", "object outlives the call", "only called from thread T", "never called after stop()"). Mark checked=true only if you inspected every call site.
  - lock_edges: every "holding X, acquire Y", following callees until they stop taking locks. Note when X and Y can be the same member on two different objects.
  - pointers: suspicions about other functions.
  - not_examined: callees or call sites you could not read.

${RULES}`
}

function verifyPrompt(f, context, mapText) {
  return `A concurrency analyst claims the following bug in C++ code. Your job is to try to REFUTE it by reading the code yourself. Do not trust the analyst's description of what the code does.

${context}

Claim:
${JSON.stringify(f, null, 2)}

Concurrency map of the scope (a hint, not ground truth):
${mapText}

Check, by reading the code at every location in the trace and around it:
1. Does each step of the trace match what the code really does at that file:line?
2. Can the two threads really be at those points at the same time? Look for: a lock held by both sides (including one taken by a caller); thread confinement - both sides running on the same thread, strand or single-threaded event loop; a happens-before edge (thread created after the write, joined before the read, task posted after the state was set, std::call_once, atomics with adequate ordering); the object not yet being visible to other threads, or no longer reachable.
3. For lifetime claims: is the object in fact kept alive (shared_ptr capture, join in destructor, cancellation that waits for in-flight callbacks)?
4. Is the outcome actually incorrect, or a benign and intended relaxation (document why)?

Verdicts:
- confirmed: you followed the interleaving in the code and found nothing that prevents it. If the bug is real but the trace was inaccurate, give corrected_trace.
- refuted: name the exact mechanism (file:line) that makes the interleaving impossible or harmless.
- uncertain: it depends on code you could not find or on a runtime fact you cannot establish; say which.
Set severity from the real consequence: critical = memory corruption, use-after-free or deadlock on a common path; high = same on a rare path, or data corruption; medium = wrong result or lost update with limited effect; low = theoretical or cosmetic.

${RULES}`
}

function assumptionPrompt(u, list, mapText) {
  return `A deep analysis of the C++ function ${u.name} (${u.file}:${u.line_start}-${u.line_end}) concluded that it is correct ONLY IF its callers and environment satisfy these assumptions, which were not checked:

${list.map((a, i) => `${i + 1}. [${a.kind}] ${a.statement}${a.evidence ? ` (analyst's note: ${a.evidence})` : ''}`).join('\n')}

Concurrency map of the scope (a hint, not ground truth):
${mapText}

Find EVERY call site of the function (direct calls, calls through pointers / std::function / virtual dispatch / signal connections, and places that post it as a task). For each assumption decide whether it holds at all of them. For an assumption that is violated somewhere, produce a finding with a concrete interleaving trace that starts at the violating call site. Report "unclear" rather than guessing when a call site cannot be resolved.

${RULES}`
}

function cyclePrompt(cycle, edges, mapText) {
  return `Per-function analyses of a C++ scope reported lock-acquisition edges ("while holding X, acquires Y"). Combined, they form this cycle, which is a potential deadlock:

${cycle.concat([cycle[0]]).join('  ->  ')}

Edges that make up the cycle:
${edges.map(e => `- holding ${e.held}, acquires ${e.acquired} at ${e.file}:${e.line} in ${e.unit} (via: ${e.via}${e.instances ? `; instances: ${e.instances}` : ''})`).join('\n')}

Concurrency map of the scope (a hint, not ground truth):
${mapText}

Read the code at every edge and try to REFUTE the deadlock. It is not a deadlock if: the edges can only run on the same thread; a common outer ("gate") lock serialises them; the locks are always different objects that are themselves ordered (for example by address, or std::scoped_lock / std::lock acquires them together); one acquisition is a try_lock with back-off; the lock is recursive and it is a self-edge on the same thread and object; or one of the edges does not really exist. A self-edge on a non-recursive mutex is a real self-deadlock if the same object is involved, and a real two-object deadlock if two threads can take the same member on objects A and B in opposite orders.

If it survives, describe the interleaving in corrected_trace: which thread holds which lock at which file:line while waiting for which.

${RULES}`
}

// ------------------------------------------------------------------ helpers

function unitKey(file, name) {
  return `${String(file).replace(/\\/g, '/').toLowerCase()}::${String(name).trim()}`
}

function tally(votes) {
  const v = votes.filter(Boolean)
  if (!v.length) return { verdict: 'unverified', reasoning: 'verifier did not return', severity: null, votes: [] }
  const n = k => v.filter(x => x.verdict === k).length
  let verdict = 'uncertain'
  if (n('confirmed') * 2 > v.length) verdict = 'confirmed'
  else if (n('refuted') * 2 >= v.length) verdict = 'refuted'
  const pick = v.find(x => x.verdict === verdict) || v[0]
  return {
    verdict,
    reasoning: pick.reasoning,
    corrected_trace: pick.corrected_trace || '',
    severity: pick.severity,
    votes: v.map(x => x.verdict),
  }
}

async function verifyFinding(f, context, mapText, label) {
  const votes = await parallel(Array.from({ length: VOTES }, (_, i) => () =>
    agent(verifyPrompt(f, context, mapText),
      opts({ label: `verify:${label}${VOTES > 1 ? `#${i + 1}` : ''}`, phase: 'Verify', schema: VERDICT_SCHEMA }, VERIFY_EFFORT))))
  return Object.assign({}, f, { verification: tally(votes) })
}

function reviewUnits(units, mapText) {
  return pipeline(
    units,
    u => agent(analyzePrompt(u, mapText),
      opts({ label: `analyze:${u.name}`, phase: 'Analyze', schema: ANALYSIS_SCHEMA }, ANALYZE_EFFORT)),
    async (a, u) => {
      if (!a) return { unit: u, failed: true }
      const context = `The claim came from a dedicated analysis of ${u.name} at ${u.file}:${u.line_start}-${u.line_end}.`
      const findings = await parallel((a.findings || []).map(f => () => verifyFinding(f, context, mapText, `${u.name}:${f.line}`)))
      return { unit: u, analysis: a, findings: findings.filter(Boolean) }
    },
  )
}

function findCycles(edges, maxLen, maxCycles) {
  const adj = new Map()
  for (const e of edges) {
    if (!adj.has(e.held)) adj.set(e.held, new Set())
    adj.get(e.held).add(e.acquired)
  }
  const out = []
  let truncated = false
  const dfs = (start, node, path) => {
    for (const next of adj.get(node) || []) {
      if (out.length >= maxCycles) { truncated = true; return }
      if (next === start) out.push(path.slice())
      else if (next > start && !path.includes(next) && path.length < maxLen) dfs(start, next, path.concat([next]))
    }
  }
  for (const n of Array.from(adj.keys()).sort()) dfs(n, n, [n])
  return { cycles: out, truncated }
}

// --------------------------------------------------------------------- main

phase('Map')
const map = await agent(mapPrompt(), opts({ label: 'concurrency-map', phase: 'Map', schema: MAP_SCHEMA }, A.mapEffort))
if (!map) return { error: 'The mapping agent did not return a result; nothing was analysed.' }

const mapForPrompts = Object.assign({}, map)
delete mapForPrompts.units
const mapText = JSON.stringify(mapForPrompts, null, 1)

const ranked = (map.units || []).slice().sort((a, b) => a.priority - b.priority)
const units = ranked.slice(0, MAX_FUNCTIONS)
const dropped = ranked.slice(MAX_FUNCTIONS)
log(`Map: ${map.threads.length} threads, ${map.locks.length} locks, ${map.shared_state.length} shared objects, ${ranked.length} candidate functions`)
if (dropped.length) log(`maxFunctions=${MAX_FUNCTIONS}: NOT analysing ${dropped.length} lower-priority functions: ${dropped.map(u => u.name).join(', ')}`)
if (!units.length) return { map, error: 'The mapping agent selected no functions: no shared state or locks found in scope.' }

phase('Analyze')
let results = (await reviewUnits(units, mapText)).filter(Boolean)

// Follow-up round: functions that analysts flagged but nobody analysed.
phase('Cross-check')
const analysed = new Set(units.map(u => unitKey(u.file, u.name)))
const followups = new Map()
for (const r of results) {
  for (const p of (r.analysis && r.analysis.pointers) || []) {
    const k = unitKey(p.file, p.function)
    if (analysed.has(k)) continue
    if (followups.has(k)) { followups.get(k).suspicion += ` | ${p.suspicion}`; continue }
    followups.set(k, {
      id: `followup-${followups.size + 1}`, file: p.file, name: p.function,
      line_start: p.line, line_end: p.line, priority: 1,
      runs_on: 'unknown - determine from call sites',
      why: `flagged while analysing ${r.unit.name}`,
      suspicion: p.suspicion,
    })
  }
}
const followupUnits = Array.from(followups.values())
const followupRun = followupUnits.slice(0, MAX_FOLLOWUPS)
const followupDropped = followupUnits.slice(MAX_FOLLOWUPS)
if (followupDropped.length) log(`maxFollowups=${MAX_FOLLOWUPS}: NOT analysing ${followupDropped.length} flagged functions: ${followupDropped.map(u => u.name).join(', ')}`)
if (followupRun.length) {
  log(`Follow-up round: ${followupRun.length} functions flagged by analysts`)
  results = results.concat((await reviewUnits(followupRun, mapText)).filter(Boolean))
}

const done = results.filter(r => !r.failed)

// Caller assumptions that the analyst did not check: one agent per function.
const assumptionJobs = done
  .map(r => ({ unit: r.unit, list: (r.analysis.assumptions || []).filter(a => !a.checked) }))
  .filter(j => j.list.length)
const assumptionResults = await pipeline(
  assumptionJobs,
  j => agent(assumptionPrompt(j.unit, j.list, mapText),
    opts({ label: `assumptions:${j.unit.name}`, phase: 'Cross-check', schema: ASSUMPTION_CHECK_SCHEMA }, VERIFY_EFFORT)),
  async (res, j) => {
    if (!res) return { unit: j.unit, failed: true, results: [], findings: [] }
    const context = `The claim came from checking the caller-side assumptions of ${j.unit.name} at ${j.unit.file}:${j.unit.line_start}-${j.unit.line_end}.`
    const findings = await parallel((res.violations || []).map(f => () => verifyFinding(f, context, mapText, `assumption:${j.unit.name}:${f.line}`)))
    return { unit: j.unit, results: res.results, findings: findings.filter(Boolean) }
  },
)

// Lock-order graph across all functions.
const edges = []
for (const r of done) {
  for (const e of r.analysis.lock_edges || []) {
    edges.push({
      held: String(e.held).trim(), acquired: String(e.acquired).trim(), line: e.line,
      via: e.via, instances: e.instances || '', unit: r.unit.name, file: r.unit.file,
    })
  }
}
const { cycles, truncated } = findCycles(edges, 4, 20)
if (truncated) log('Lock graph: more than 20 cycles found, only the first 20 are checked')
const lockCycles = (await parallel(cycles.map(c => () => {
  const ring = c.concat([c[0]])
  const cycleEdges = edges.filter(e => ring.some((x, i) => i < c.length && e.held === x && e.acquired === ring[i + 1]))
  return agent(cyclePrompt(c, cycleEdges, mapText),
    opts({ label: `lock-cycle:${c.join('>')}`, phase: 'Cross-check', schema: VERDICT_SCHEMA }, VERIFY_EFFORT))
    .then(v => ({ cycle: c, edges: cycleEdges, verification: v || { verdict: 'unverified', reasoning: 'verifier did not return' } }))
}))).filter(Boolean)

// ------------------------------------------------------------------- result

const allFindings = []
for (const r of done) for (const f of r.findings) allFindings.push(Object.assign({ unit: r.unit.name, source: 'function-analysis' }, f))
for (const r of assumptionResults.filter(Boolean)) for (const f of r.findings) allFindings.push(Object.assign({ unit: r.unit.name, source: 'caller-assumption' }, f))
const by = v => allFindings.filter(f => f.verification.verdict === v)

const coverage = done.map(r => {
  const pts = r.analysis.points || []
  const unsure = []
  for (const p of pts) for (const s of p.scenarios) {
    if (s.verdict === 'unsure') unsure.push({ line: p.line, code: p.code, question: s.question, outcome: s.outcome })
  }
  return {
    unit: r.unit.name,
    file: r.unit.file,
    lines: `${r.unit.line_start}-${r.unit.line_end}`,
    points: pts.length,
    scenarios: pts.reduce((n, p) => n + p.scenarios.length, 0),
    entry_state: r.analysis.entry_state,
    unsure,
    not_examined: r.analysis.not_examined,
  }
})

return {
  scope: SCOPE,
  map,
  confirmed: by('confirmed'),
  uncertain: by('uncertain').concat(by('unverified')),
  refuted: by('refuted').map(f => ({ unit: f.unit, title: f.title, file: f.file, line: f.line, why_refuted: f.verification.reasoning })),
  lock_cycles: lockCycles,
  assumptions: assumptionResults.filter(Boolean).map(r => ({ unit: r.unit.name, failed: !!r.failed, results: r.results })),
  coverage,
  failed_units: results.filter(r => r.failed).map(r => r.unit.name),
  not_analysed: dropped.concat(followupDropped).map(u => ({ name: u.name, file: u.file, why: u.why })),
  lock_edges: edges,
}
