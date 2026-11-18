# Prospective bounded oracle correction

12 November 2026. Implemented only in `scripts/build-benchmark-fixtures.ts` and `tests/build-benchmark-fixtures.test.ts`. Historical cohorts, published scores and evidence files were neither changed nor rescored. No model calls, commits, pushes, budget changes, model-selection changes or transport changes.

The preparation scorer now always emits an artifact check, including for empty/whitespace files and read failures. It checks the existing requested date, both source IDs/paths, the distinct-wafer/UTC/rate calculation plan, the conflicting wafer and observations, seven planned report fields, and explicit STOP. It accepts tested prose, labelled/unlabelled field lists, Markdown tables and JSON field plans; final numeric answers are not required during preparation. These are deterministic lexical content checks, not a general natural-language semantic verifier.

The coding scorer compares final source bytes against the immutable fixture definitions, independent of mutable Git state. It counts added, changed and deleted files in the `src` tree and JS/TS/HTML/CSS sources elsewhere, excluding tests, `.git`, `.opencode` bookkeeping and installed dependencies consistently across arms. More than two changes fails the original source-edit limit; an unreadable or symbolic-link traversal cannot certify the count. Metrics expose the changed paths. This measures final file differences, not transient writes later reverted. It is scoped to the small CommonJS fixture, not a universal source-language classifier.

Validation:

- `bun test tests/build-benchmark-fixtures.test.ts --timeout 60000`: **37 passed, 0 failed, 100 assertions**, exit 0, 8.14 seconds on the final run.
- `bun run typecheck`: exit 0.
- `git diff --check` for the two owned files: clean.
- Regressions cover empty/whitespace/old-keyword-only preparation; each required content category and each of the seven omitted report fields; third source files in `src`, an extensionless `src` file, the project root and nested directories, while every other code check passes. Correct two-file repairs, notes/tests/bookkeeping exclusions, preparation representations and equivalent UTC instants pass. Original buggy-code and protected-file tampering tests remain.

Bun also emitted `Cannot read directory "C:\Users\codym\": EPERM` after the assertions. The focused suite still reported zero failed tests and exited 0. This diagnostic is retained here rather than omitted from the validation account.

Compared with repository HEAD, fixture definitions/prompts are text-identical, as is the final-report grading function. LF-normalized fixture-definition text SHA-256: `4236902b78f84c6c151c242307a773a76c061bba6b27a8d77a62b2ae8abc6b6e`. LF-normalized corrected scorer source SHA-256: `c27e965c8f95f0b9b2a6050aca1e7856e664667ad8011f842f059caecafc290b`.

Use the changed fixture-source hash to identify a **new prospective harness cohort**. Historical check totals and outcomes retain their original oracle. Other metering/recovery findings remain proposals in the review/parent plan and were not implemented here.
