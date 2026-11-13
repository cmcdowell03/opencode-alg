# Checker consistency and deployment qualification

The frozen `7a32708` runtime implements model-agnostic consistency checks for
bounded, host-verifiable assertions and pins the actual submitted dependency.
Ordinary resume preserves a substantive rejection; explicit feedback can repair
the producer before a fresh review. Sol's independent static review found no
remaining core blocker before the integrated gate.

The native Windows integrated gate passed **210 tests, one POSIX-only skip,
3,147 assertions**, plus TypeScript checking. The independent scorer passed
**80 synthetic HTTP controls** at the frozen checkout. All sixteen benchmark
configurations passed preflight without generation. These overlapping controls
are not additional real-model successes or a complete Windows suite.

## Real-model V4 result: admission failed

The complete two-case diagnostic ran once, using real `openai/gpt-6-luna`
checkers with deterministic local producer/controller roles. It lasted 97.232
seconds and issued three checker attempts. No larger comparison was admitted.

| Case | Attempts | Final outcome | Independent diagnosis |
| --- | ---: | --- | --- |
| Valid action | 2 | Invalid output, exhausted | First aggregate contradicted its supported finding; second mechanical verdict contradicted exact host action facts. The runtime correctly rejected both. |
| Known defect | 1 | Valid substantive rejection | Correctly rejected reported exit 1 against required exit 0. An additional valid manifest read/citation violated the frozen diagnostic's exact recipe. |

Both original diagnostic grades remain failed. Independent inspection verified
the negative case's citations; its combined missing/forged failure wording does
not establish a forged or missing record. The future V5 apparatus distinguishes
that qualification failure from verdict correctness and permits one bounded
manifest read. It is not a retrospective regrade or a real-model V5 result.

Each case executed ten producer calls, retained the original journal through a
completed requested parent summary and one server restart, and avoided producer
replay. Compaction exposure and evidence preservation are observed separately
from successful continuation: the failed end-to-end grades do not qualify
semantic recovery. This short diagnostic is not a long-session information-loss
estimate, a checker error-rate estimate, or evidence of ALG superiority.

Hosts and local providers stopped, temporary auth copies were removed, and
source/global configuration checks passed. Failed workspaces and private raw
histories remain preserved. Public evidence contains selected measurements and
receipt hashes, not credentials or raw model conversations.

Final deployment qualification and future-harness controls are recorded
separately with their exact candidate identities. Earlier V3 and paid cohort
outcomes remain unchanged. PR #14 stays draft and unmerged; all checks are local.
