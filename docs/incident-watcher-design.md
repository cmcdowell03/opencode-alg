# Incident watcher: design spec

**Status:** Draft 0.3, reconciled 2026-10-17 with the
[umbrella design](skill-knowledge-graph-design.md) and four component contracts.
Based on Claude's Draft 0.1 of 2026-10-13; its code/live labels describe that
research snapshot, not current release certification. Nothing here is implemented.

**Contract ownership:** this feature owns scanning and bounded work admission.
[Execution](execution-recovery-contract.md) owns attempts, recovery, capabilities,
failure codes and cost; [knowledge](knowledge-environment-contract.md) owns
source/evidence/approval; [context](context-decision-contract.md) owns routing and
delivery; [coordination](coordination-improvement-contract.md) owns sharing and
observation. No second executor, recovery record or breaker taxonomy is introduced.

The linked design set is canonical. This watcher is a later V1 feature, not part
of the umbrella's first procedure-continuity phase. Updating this draft starts
neither the watcher nor any V2 implementation or probe.

**Scope:** an always-on watcher for OpenCode 1.18 that looks for known error strings, opens one
incident per distinct error, and runs an ALG graph to diagnose each one without a person present.

## 1. Summary

- A **scanner** (plain code, no model) reads configured sources for configured error patterns. It
  costs no tokens when nothing is wrong.
- Each distinct error becomes one **incident**, recorded with the incident model the plugin already
  has. Repeats of the same error add to that incident instead of opening another.
- Each new incident gets one **diagnosis run**: a new `troubleshooting-diamond` graph with two
  read-only exploration lanes, a synthesis step, and the independent checker.
- The watcher **diagnoses; it does not fix.** A run ends with a cause and a proposed remediation
  (action, rollback, verification). Applying it needs a person's approval of that exact plan.
- The watcher lives in the plugin and runs whenever an OpenCode process has the project loaded.
  "Always on" is a headless `opencode serve` kept alive by the operating system.
- Everything is bounded: runs at once, incidents per scan, runs per day, and a breaker that pauses
  the watcher when workers keep failing for infrastructure reasons.
- Two inputs from the owner decide the rest: where the error strings live, and how much the watcher
  may do unattended (section 13).

## 2. How to read the evidence

| Label | Meaning |
|---|---|
| **[code]** | Verified in this repository at `main` (`fb23c71`) |
| **[live]** | Observed in the live checks run against OpenCode 1.18.31 to 1.18.35 this month |
| **[unverified]** | An assumption that must be checked before the phase that depends on it |

## 3. Goals and non-goals

**Goals**

1. Detect configured error strings in configured sources without a model call.
2. Commit one incident per scoped grouping identity/revision and count deduplicated
   occurrences; grouping does not establish one underlying cause.
3. Diagnose each incident with a checked, durable, resumable run.
4. Never wait on a person, and never do anything a person has not approved.
5. Stay within fixed limits on runs, model calls and wall time.
6. Leave a record a person can open, read, continue or dismiss.
7. Keep the watcher logic independent of the host, so it carries over to OpenCode 2.

**Non-goals for the first version**

- Fixing anything unattended.
- Watching remote systems, network endpoints or other machines.
- Discovering new kinds of error by itself. The pattern list is supplied.
- A graph of graphs. Fan-out is many runs under one scheduler.
- Notifications outside OpenCode (mail, chat).

## 4. What exists today

| Piece | State | Label |
|---|---|---|
| Graph templates | `coding-diamond`, `research-diamond`, `spreadsheet-diamond`. There is no troubleshooting template | [code] |
| Incident model | `src/troubleshooter.ts`: states `opened → triaged → investigating → cause-identified → remediation-planned → remediating → verifying → resolved`, plus `blocked` and `reopened`. Revision-checked history. It never executes a remediation | [code] |
| Evidence rules in that model | A cause needs an observed diagnostic, not only an inference. A remediation plan needs distinct action, rollback and verification proposals. Remediating needs confirmation of the exact current plan. Resolution needs a fresh successful verification linked to that remediation | [code] |
| Read-only workers | `explorer` and `researcher` deny shell and edits (the researcher may write only under `.opencode/runs/`). The `checker` reads, greps and globs only | [code] |
| Starting a run | `createRun` needs an owning session; `executeRun` is a function that takes a client, an abort signal and an approval callback. Today both are reached only through a model's `alg_plan` and `alg_run` tool calls | [code] |
| Run durability | Runs survive restarts, resume without losing attempts, and can be closed | [code] |
| Single-owner leases | Filesystem lock with a heartbeat, used by historical review | [code] |
| Redaction | The learning pipeline's redaction of secrets in captured text | [code] |
| Headless host | `opencode serve` runs without a terminal, and runs were planned, executed, compacted and resumed through it | [live] |
| Scheduler in the host | None. OpenCode 1.18 has no timer or daemon facility for plugins | [code] |

The incident model guards the transition into remediation. It does not itself
prove worker termination or authenticate an approver; those boundaries are supplied
by the shared execution and knowledge approval contracts.

## 5. Design

```
 sources ──► scanner ──► fingerprint ──► incident store ──► scheduler ──► diagnosis run
 (files)     (code)      and dedupe      (existing model)   (limits,      (troubleshooting-
                                                              breaker)      diamond)
                                                                               │
                              person approves exact plan ◄── cause + proposed ─┘
                                        │                    remediation
                                        ▼
                               remediation (not in v1)
```

### 5.1 Sources and patterns

A **source** is something the scanner reads. A **pattern** is something it looks for.

| Source type | What it reads | First version |
|---|---|---|
| `file` | One file, from where the last scan stopped | yes |
| `glob` | Files matching a pattern, each tracked separately, up to a file limit | yes |
| `manual` | Text handed to the `alg_incident` tool by a person or an agent | yes |
| `command` | Output of a fixed command the owner declared in configuration | later (D1) |

Rules:

- Reading is the only thing the scanner does to a source.
- The first scan of a file starts at its end. Old content is not swept unless `backfill` is set.
- Each scan reads at most a fixed number of new bytes per file and records where it stopped (path,
  file identity, offset). A truncated or rotated file starts again from its beginning.
- A pattern is a literal string or a bounded, validated non-backtracking expression,
  with an id, optional context-line limit and template. Reject unsupported syntax
  rather than executing an unbounded regex on attacker-controlled logs.
- Matched text is **untrusted input**. It is redacted, cut to a size limit, and only ever shown to a
  model inside a block marked as data.

Paths outside the project require an operator-authorized source policy covering
the canonical path/root and allowed data scope. A model-written configuration is
not consent. Validate aliases, traversal, redirects and rotation against that
policy; secret-bearing or uncertain captures are withheld under intake rules.
Persist scan cursors only after occurrence/admission or explicit rejection receipts
commit; a crash must not silently skip an unrecorded occurrence.

### 5.2 Fingerprint and dedupe

Group repeated occurrences without asserting that they share a cause. Use a
versioned fingerprint over project, source identity, environment/principal scope,
pattern/rule version and canonical safe diagnostic fields. Keep occurrence identity
(file identity/offset or manual-intake ID) separate from grouping identity so
re-reading a rotated or replayed event cannot inflate counts.

Normalize only declared volatile fields. Preserve semantically meaningful numbers,
HTTP/database error codes, ports and version distinctions; blanket removal of all
numbers/hex/quoted values can collapse unrelated failures. Redact secrets before
persisting or hashing. If safe normalization is unavailable, report an intake gap
rather than persisting raw sensitive text.

- One open incident exists per scoped grouping identity and current generation.
  Further distinct occurrences update its count and last-seen evidence.
- Ambiguous correlations remain separate or flagged; a fingerprint never proves
  root cause, procedure applicability, safe replay or shared authorization.
- A recurrence after resolution/dismissal follows the configured cooldown and a
  recorded reopen decision. Revalidate environment and previous resolution before
  reusing it.
- A per-pattern cap bounds distinct groups admitted per day. Excess eligible
  occurrences remain durably queued or explicitly rejected by capacity policy.
  Normalizer changes create a new version with migration links, not silent merging.

### 5.3 Incidents

The watcher writes through the existing incident model and adds no second store.

| When | Transition | Evidence written |
|---|---|---|
| First match of a fingerprint | `opened` | The redacted excerpt as an observation the watcher itself observed |
| Dedupe and limits checked | `triaged` | none |
| Diagnosis run starts | `investigating` | The run id |
| Checker passes the diagnosis | `cause-identified` | The cause, with the observations that support and refute it |
| Diagnosis includes a complete proposal | `remediation-planned` | Action, rollback and verification proposals |
| Run fails, limits hit, or breaker open | `blocked` | The reason |
| Fingerprint returns after resolution | `reopened` | The new excerpt |

The watcher never writes `remediating`, `verifying` or `resolved` in the first version. Those belong
to the person who approves and applies the fix.

The transitions are made by code from the run's validated output. A model never calls the incident
API.

### 5.4 The troubleshooting diamond

A new template beside the three existing ones.

| Node | Agent | Depends on | Job |
|---|---|---|---|
| `evidence` | explorer | none | Where the error appears: surrounding log lines, configuration, recent changes on disk |
| `origin` | explorer | none | Where the error string is produced: the code path and its callers |
| `diagnose` | researcher | `evidence`, `origin` | The most likely cause, what supports it, what would refute it, and a proposed action, rollback and verification |
| `check` | checker | `diagnose` | Verify each claim against the files. Reject a cause that the evidence does not support. Feedback goes to `diagnose` |

- The run's goal is the incident, and its criteria are fixed: the cause cites specific files and
  lines; at least one piece of evidence is an observation rather than an inference; the proposal has
  three distinct parts; no application or external operational state was changed.
  Declared diagnosis artifacts and run records are accounted writes, not remediation.
- Workers cannot edit application code, run a shell or invoke undeclared network
  tools. The researcher's declared run-artifact writes remain confined to the
  approved artifact root; permissions must be tested at the host boundary.
- Record those effective capabilities per attempt. A researcher role is not
  effect-free: artifact writes need attempt-private isolation or confirmed stop
  before conflicting replacement. Read-only tools also need verified effect and
  cost scope; an HTTP method or tool name alone is not proof. A clean `git status`
  never substitutes for stop or effect reconciliation.
- The graph attempt limit bounds attempts, not model calls: one worker may take
  multiple model/tool steps. The shared budget ledger separately bounds calls,
  request volume, known usage and wall time, including retries and host resumes.
- For watcher runs the researcher's web tools are switched off unless the owner turns them on (D6).
  An attacker who can write a log line must not be able to make a worker fetch a URL.

### 5.5 Starting a run without a model

The watcher submits work to the existing run store/executor through a bounded
admission interface. It does not need an orchestrator model to issue ALG tool calls,
but admission still needs durable identities, failure handling and reconciliation.

Before host creation, persist a reservation binding incident revision, work ID,
source/approval scope, pinned models and cumulative budget. Reconcile an interrupted
reservation through the shared execution contract; do not create a second session
because the first response or lookup is missing. The watcher never schedules DAG
nodes or implements its own attempt retry state machine.

Use verified/unverified/unavailable host-epoch evidence rather than inventing an
epoch from a local UUID. Unknown outcomes block conflicting admission; demonstrably
disjoint incidents may proceed within permissions and the same cumulative budget.
Retain reservations/unknown usage for old workers when charging replacements.
Headless admission uses an operator-controlled approved policy; an agent-writable
configuration or model-invoked CLI cannot approve additional source/action scope.

- **One host session per incident**, titled `ALG incident <id>: <pattern id>`. It owns the run and
  is the parent of the worker sessions, so the workers appear under it in the session list.
- The watcher posts the incident summary into that session as a note. A person who opens the session
  sees what happened, and because the plugin already re-states an unfinished run on every request,
  they can simply ask the orchestrator to continue or to apply the fix.
- **Approval callback:** the watcher supplies one that always refuses. Anything in a run that would
  need approval fails closed and the incident becomes `blocked: needs approval`.
- **Models:** watcher runs use explicitly pinned role models. If any role would fall back to "the
  model used last", the watcher refuses to start and says so.

Whether a session with no model turn in it can parent workers and hold the note is W2.

### 5.6 Scheduler, limits and the breaker

| Limit | Default | Purpose |
|---|---|---|
| Scan interval | 5 minutes | How often sources are read |
| Runs at once | 1 | Keeps the machine and the provider usable |
| New incidents per scan | 3 | A burst is drained over several scans |
| Runs per day | 10 | Admission-count ceiling, not a monetary or model-call cap |
| Fingerprints per pattern per day | 5 | Stops one noisy pattern |
| Cooldown before reopening | 60 minutes | Stops flapping |
| Wall time per run | 30 minutes | A stuck run is cancelled and its incident blocked |
| Breaker threshold | 3 consecutive infrastructure failures | See below |
| Daily model-call and cumulative request-byte ceilings | Required operator configuration before unattended enablement | Shared ledger, including failed/unknown attempts and attributable retries/resumes |

Incidents beyond a limit stay `triaged` and queued; they are not dropped.

**Breaker.** Consume schema-owned infrastructure categories from the shared
diagnostic envelope, not raw text matching or a second taxonomy. Three consecutive
eligible infrastructure failures pause the affected configured provider/role scope,
mark its incidents blocked and require operator resume. A substantive rejection,
invalid output or unknown effect is not automatically a provider outage. Record
breaker state and outstanding reservations durably; restart never clears either.

Daily counters use a recorded policy/time-window boundary; clock rollback cannot
refund charges. Existing run budgets and deadlines survive a new day, resume or
plan revision. Known provider usage is recorded, unknown usage stays unknown and
reserved conservatively. Unattended operation requires tested enforcement of the
needed host step/call boundary; otherwise report unsupported rather than claim a
hard spend cap. Operator monetary limits, when available, require reliable pricing/
usage accounting and are not inferred from the run count.

**Pause and stop.** `alg_watch pause` stops new admissions and lets owned work
finish under its existing limits. `alg_watch stop` persists cancellation intent and
requests stop; it reports confirmed or unknown termination/effects, never claims
an abort request proves a kill. Disabling the watcher takes effect on reload without
discarding existing reconciliation obligations. Neither action grants permission
to kill unrelated processes or reset reservations.

### 5.7 Where the watcher runs

- The watcher is part of the plugin. It runs in any OpenCode process that has the project loaded: a
  terminal session or a headless server.
- **One admission owner per project.** A revision-fenced lease serializes scanner/
  queue writes. Expiry allows a controller takeover, not conflicting worker replay:
  reconcile existing admissions and effects before dispatching replacement work.
- **Always on** means a headless `opencode serve` for the project, started at logon or boot by the
  operating system (Task Scheduler on Windows, a service unit on Linux) and restarted if it exits.
  A small script installs and removes that entry.
- After restart, reconcile scan positions, occurrence receipts, admission queue,
  breaker state, budget reservations and host-bound work. Attach or continue only
  when the shared recovery contract permits it; an unknown outcome remains blocked.
- Installing a keep-alive task/service requires separate explicit authorization.
  Enabling a configuration option or approving this design does not install one.

Whether a headless server loads the plugin for a project before any request names that project is
W1. If it does not, the keep-alive script also makes one request for the project at start.

### 5.8 Tools and views

Two tools, each with an `action`, to keep the per-call tool overhead small.

| Tool | Actions |
|---|---|
| `alg_watch` | `status`, `scan` (run one scan now), `pause`, `resume`, `stop` |
| `alg_incident` | `list`, `show`, `open` (manual intake), `dismiss`, `reopen` |

`status` reports: enabled or paused and why, the lease holder, last scan time, positions per source,
queue length, admissions/calls/bytes against limits, unknown usage, breaker state,
effective source policy, host capability coverage and unsettled stop/effect receipts.

Worker sessions do not get either tool, as with every other `alg_*` tool.

A terminal view (`/alg-incidents`) is a later phase. Until then, incidents are visible through the
tools, the incident sessions, and the existing `/alg-runs` browser.

### 5.9 Configuration

A new `watcher` section in the plugin options. Off by default.

```jsonc
"watcher": {
  "enabled": false,
  "intervalSeconds": 300,
  "autonomy": "diagnose",
  "sources": [
    { "id": "app", "type": "file", "path": "logs/app.log" },
    { "id": "jobs", "type": "glob", "pattern": "logs/jobs/*.log", "maxFiles": 50 }
  ],
  "patterns": [
    { "id": "db-refused", "kind": "literal", "match": "ECONNREFUSED" },
    { "id": "panic", "kind": "regex", "match": "panic: .*", "contextLines": 20 }
  ],
  "limits": { "concurrentRuns": 1, "newIncidentsPerScan": 3, "runsPerDay": 10 },
  "models": { "explorer": "provider/model", "researcher": "provider/model", "checker": "provider/model" },
  "researcherWeb": false
}
```

This is a proposed configuration sketch, not installable configuration. It is
intentionally disabled and omits the operator-selected daily call/byte ceilings
required before unattended enablement. The implementation schema must reject
enabled unattended operation without these limits and its required capability receipts.

The plugin options schema is strict, so older builds reject the `watcher` key.
The upgrade runbook must preserve reservations/state and document rollback.

## 6. Autonomy

| Level | What the watcher may do | Status |
|---|---|---|
| `diagnose` | Scan, open incidents, run read-only diagnosis, propose a remediation | **First version, the default** |
| `remediate-approved` | Also carry out a remediation a person approved, in an isolated git worktree | Later, a separate decision (D2) |
| Unattended fix | Apply a fix nobody approved | Not planned |

How approval would work at the second level, using what the incident model already enforces:

1. The person reviews the exact action, rollback, verification, resource/principal
   scope and spending bounds. The knowledge contract records an authenticated,
   digest-bound approval. Git history or a model-supplied confirmation is not
   approval. A rollback description does not authorize automatic rollback unless
   the approval explicitly includes that action and its conditions.
   A TUI confirmation must satisfy the shared approval-boundary tests, including
   SDK/CLI invocation and forged receipts; showing a dialog alone is insufficient.
2. The watcher creates a worktree and a branch for the incident and runs a `coding-diamond` there,
   with the plan's verification command as its shell gate.
3. The incident moves to `verifying` and to `resolved` only on a fresh successful verification.
   Merging the branch stays with the person.

Until that level exists, the same path is available by hand: open the incident session and ask the
orchestrator to apply the plan, with the usual interactive permissions.

## 7. Safety

| Concern | Rule |
|---|---|
| Unattended changes | Tested permissions deny application edits and shell; only declared attempt-scoped artifact writes are allowed. The watcher's approval callback always refuses |
| Hostile log content | Excerpts are data, never instructions; redacted and size-limited; researcher web access off by default |
| Secrets in logs | Reject/withhold unsafe captures before persistence or hashing; redaction is defense in depth, not a guarantee that every secret is detected |
| Runaway cost | Limits in 5.6; the attempt ceiling of the graph; the breaker |
| Wrong model | Pinned role models; refusal to start otherwise |
| Two watchers | One fenced admission owner; worker/effect reconciliation before conflicting takeover |
| Waiting on a person | Any permission request raised for a watcher run fails the attempt (W4) |
| Losing track | Every action is an incident transition with evidence; nothing happens off the record |
| Session clutter | Clear titles; retention is the owner's choice (D5). The watcher deletes nothing by default |

## 8. OpenCode 2

This section records future compatibility only. The watcher targets V1, and neither
V2 implementation nor a V2 runtime probe is part of its delivery. The shared host
interface is implemented for V1 now when the watcher is authorized; the V2 adapter
waits for its finalized design and explicit implementation authorization.

This feature is designed so it does not have to be redone for OpenCode 2.

- The scanner, fingerprinting, incident transitions, scheduler, limits and breaker have no host
  dependency.
- The host-specific parts are small: create a session, post a note, launch and observe a worker,
  cancel. These are the same operations the V2 design spec puts behind its host port, so the watcher
  should be written against that small interface from the start, as the first slice of that seam.
- "A worker never waits on a person" is already a rule of the V2 permissions contract.
- The keep-alive piece is V1 only. OpenCode 2 runs as a single always-on service.
- The shared capability descriptor gains watcher requirements. V1 support is a
  target pending this feature's conformance; V2 execution preview remains disabled
  until its required entries pass. No separate watcher capability truth is stored.

## 9. Testing

| Layer | What it covers |
|---|---|
| Scanner | Offsets, rotation, truncation, byte limits, first scan at end of file, globs |
| Fingerprint | Scoped volatile-only normalization; preserve error codes/ports/versions; separate ambiguous causes; duplicate occurrence replay does not inflate counts |
| Incident flow | Every transition the watcher makes is accepted by the existing model; a model cannot reach the incident API |
| Scheduler | Each limit holds under a burst; queued incidents drain; fake clock |
| Breaker | Three infrastructure failures pause the watcher; a wrong answer does not |
| Lease | Two processes, one fenced admission owner; expiry while an old worker still acts cannot authorize conflicting replay |
| Restart | Before/after admission crash, missing/deleted session, unavailable/changed epoch evidence, preserved completed siblings, artifact writers and unknown effects; only safe scoped continuation |
| Safety | A log line containing instructions changes nothing; a secret in a log is not stored or sent |
| Live check | A scratch project with a seeded error: the incident opens, the run completes, the cause is recorded, and a second identical error opens nothing |
| Soak | Shared one-hour/optional 24-hour profile with occurrence, admission, stop/effect, budget and recovery receipts |

All tests run locally, never on GitHub runners. Use synthetic files/services first;
installed-host and paid-provider checks require separate authorization. The
[shared profiles](coordination-improvement-contract.md#local-long-horizon-acceptance-profiles)
define measured duration and workload rather than inferring endurance from fast tests.

## 10. Phases

Each phase is usable without the next and closes a local scoped gate. Watcher
phase numbers are feature-specific. Scan/admission phases require the umbrella's
shared execution recovery/capability/budget boundary; they cannot bypass it because
they precede the V2 migration. No watcher phase gates umbrella V1 Phase 1, and no
watcher implementation may silently start through enabling skill restoration.

| Phase | Work | Size | Exit test |
|---|---|---|---|
| 1. Template and manual intake | `troubleshooting-diamond`; `alg_incident open/list/show`; the diagnosis runs in the calling session | S | A pasted error produces a checked cause and a proposal recorded on the incident |
| 2. Scan on demand | Sources, patterns, fingerprint, dedupe, incident sessions, scheduler and limits; `alg_watch scan/status` | M | A seeded log yields one incident per distinct error and respects every limit |
| 3. Scheduled watcher | Interval, lease, breaker, pause/resume/stop, restart reconciliation | M | Two processes, one scanner; the breaker opens on a dead model and stays open |
| 4. Always on | Keep-alive install script, runbook section, offline install | S | The watcher survives a reboot and resumes its queue |
| 5. Terminal view | `/alg-incidents` | M | Incidents can be browsed, opened and dismissed from the terminal |
| 6. Approved remediation | Section 6, second level | L | Decided separately |

## 11. Open questions

| # | Question | Decides |
|---|---|---|
| W1 | Does a headless `opencode serve` load the plugin for a project before any request names it? | The keep-alive script (5.7) |
| W2 | Can a session with no model turn own a run, parent worker sessions, and hold a posted note? Do attempt cards have an anchor there? | Incident sessions (5.5) |
| W3 | Does the run's execution directory option make workers operate inside a git worktree? | Approved remediation (6) |
| W4 | What does a headless server do with a permission request nobody answers: hang, or fail? | The time bound and failure reason for watcher runs |
| W5 | Does the per-prompt tool map reliably switch off the researcher's web tools? | Safety default (5.4) |

W1, W2, W4 and W5 can be answered with a short live check before phase 2. W3 matters only for
phase 6.

## 12. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| Noisy patterns | Queue floods, daily limit spent on one error | Dedupe, per-pattern cap, cooldown, queue instead of drop |
| Shallow diagnosis | A plausible but wrong cause is recorded | The checker verifies claims against files; the model's rules require an observed diagnostic |
| Prompt injection through logs | A worker follows instructions in a log line | Data-only framing, read-only workers, web off, redaction |
| Provider or login failure | Every run fails | Breaker; pinned models; status says why |
| The headless server is not running | Nothing is watched | Keep-alive entry; `status` shows last scan time; a stale last-scan time is the signal |
| Session build-up | Hundreds of sessions over weeks | Titles; retention choice; one run per incident, not per occurrence |
| Scope creep into fixing | Unattended changes | Autonomy levels; the incident model refuses remediation without the exact plan confirmed |
| Divergence from the V2 design | Rework later | Written against the host port from the start (section 8) |

## 13. Decisions needed from the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Where do the error strings live? Log files on disk, command output, or both; on which machine | Files and manual intake first; declared commands later |
| D2 | Autonomy | `diagnose` only for the first version; revisit approved remediation after it has run for a while |
| D3 | Which machine runs the always-on watcher first | The workstation, in one project, before the air-gapped machine |
| D4 | Default limits in 5.6 | As listed; one run at a time and ten a day |
| D5 | Session retention | Keep everything by default; add a retention setting only if clutter becomes a problem |
| D6 | May the researcher use the web in watcher runs | No by default |
| D7 | Order against OpenCode 2 and shared core work | Manual intake may precede V2; automatic admission requires the shared execution, approval and budget contracts, not a duplicate early port |
| D8 | Name | "Incident watcher"; tools `alg_watch` and `alg_incident`; template `troubleshooting-diamond` |
