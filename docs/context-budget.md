# Context budget

ALG adds text to the system prompt before each model call: a summary of the
session's unfinished run, skill guidance, the working memory pack, and
environment facts. It adds the same kinds of text to a compaction prompt.

How much it may add is a share of the model's context window, not a fixed
number of bytes. A fixed 32 KiB is a quarter of a small local model's window and
a rounding error on a large one. Sizing from the window gives a 32k-token model
about 5 KB, a 200k model about 30 KB, and a 1M model about 150 KB, and each
shrinks as the conversation fills the window.

## How the allowance is worked out

For each model call:

1. Take `perCall` of the model's context window, in tokens (`compaction` for a
   compaction prompt).
2. If the size of the conversation is known, take no more than `ofAvailable` of
   the window that is still free after reserving room for the reply.
3. Convert tokens to bytes with `bytesPerToken`.
4. Never go below `floorBytes`, so what identifies an unfinished run and how to
   resume it still fits in a nearly full window.

The allowance is then divided among the parts that are in use, by the weights in
`shares`. A part that is switched off is left out, so its share goes to the
others. A part that uses less than its share passes the rest to the parts after
it, in this order: run, skills, memory, environment.

The size of the conversation comes from the host's own token counts on the last
assistant reply, plus an estimate for anything sent after it. What ALG itself
added on the previous call is subtracted, so ALG does not count its own text
against itself.

## Options

Add `contextBudget` to the ALG plugin options. Every field is optional.

```json
{
  "contextBudget": {
    "perCall": 0.05,
    "compaction": 0.05,
    "ofAvailable": 0.5,
    "shares": { "run": 0.2, "skills": 0.35, "memory": 0.35, "environment": 0.1 },
    "bytesPerToken": 3,
    "floorBytes": 1536
  }
}
```

| Option | Default | Meaning |
|---|---|---|
| `perCall` | 0.05 | Share of the context window ALG may add to one model call (0.005 to 0.5). |
| `compaction` | 0.05 | Share ALG may add to a compaction prompt. |
| `ofAvailable` | 0.5 | Never plan to use more than this share of the window still free. |
| `shares` | 0.2 / 0.35 / 0.35 / 0.1 | Weights for run, skills, memory, environment. |
| `bytesPerToken` | 3 | Estimated bytes of text per model token. |
| `floorBytes` | 1536 | The least ALG plans for. |

Builds before this option reject `contextBudget` as an unknown key. Remove it
before rolling back.

## What each part does with its allowance

- **Run summary.** Shows as much detail as fits: up to 64 criteria and 128 nodes
  with room, down to the run id, status, node states and how to resume. The id,
  status and resume instruction come first and are never cut.
- **Skills.** About a third goes to the catalog listing. A matching skill's
  complete body is included when it fits what is left, up to the 64 KiB a skill
  file may be. Bodies are never clipped: one that does not fit is listed as
  needing a full load. At most three bodies are included per call.
- **Memory pack** (session memory in `assist` mode). The allowance replaces the
  `fallbackTokens`, `contextFraction` and `maxContextTokens` options, which still
  apply when the window is unknown. The run summary travels inside the pack but
  is planned under "run", so it does not reduce what memory may use. If the pack
  is blocked or unavailable, the run summary is still added on its own.
- **Environment memory** (in `assist` mode). The allowance replaces
  `contextByteBudget`.

## When the window is unknown

The plan needs the model's context limit, which the host passes to the system
prompt hook. A compaction uses the window last seen for that session. When no
window is known (the first compaction of a session after a restart, or a host
that does not report limits) the long-standing fixed limits apply: 16 KiB for a
run summary, 12 KiB for skills, 32 KiB in total for a compaction.

## Seeing it

`alg_context_status` reports `context_budget`: the options in effect and the
last plan for the session, with the window size, the tokens in use, what limited
the allowance (`share`, `available`, `floor`, or `fixed`), and what each part was
allowed and used.

## Limits of this design

- `bytesPerToken` is an estimate. Dense text such as code or JSON has fewer
  bytes per token than prose, so the true share can be somewhat above or below
  the configured one. The check against the free part of the window bounds the
  effect.
- The conversation size is as recent as the last message hook. Text added to
  the conversation in the same request after that hook is not counted until the
  next call.
- Tested with synthetic hook fixtures at 32k, 100k, 200k and 1M windows. Not yet
  observed against a real provider's token counts.
