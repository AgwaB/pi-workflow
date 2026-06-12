# Dynamic Review Eval Plan — apply patch + write repro tests

## Goal

Break the static-review ceiling seen on seeded diff fixtures. Instead of scoring whether a reviewer *mentions* seeded defects in prose, score whether the arm can turn a proposed patch into executable evidence:

1. apply the patch in an isolated worktree,
2. write the smallest failing repro test(s) for behavior-changing defects,
3. run the relevant test command,
4. report RED/GREEN evidence and fixes.

This should distinguish workflows that preserve and verify findings from direct prose reviewers that can name bugs but do not operationalize them.

## Candidate task shape

```text
The patch fixture at <diff.patch> contains behavior-preserving refactors plus possible regressions.
Apply it in a disposable worktree. For each suspected regression, write the smallest targeted repro test you can.
Run the relevant test command. Report:
- defect title and severity,
- changed file/function,
- test file/test name you added,
- RED evidence on patched code,
- expected GREEN evidence after reverting/fixing the hunk when available,
- caveats.
Do not modify files outside the disposable worktree.
```

## Fixture requirements

Use the existing RED/GREEN-verified seeds as the starting point, but package each with deterministic test hooks:

- `seedId`
- patched file/function
- expected failing test behavior after applying the bad patch
- minimal test target / command
- optional fix hunk or revert hunk to prove GREEN
- false-positive trap hunks that should not receive tests

The gondolin seeds already have static answer-key coverage; dynamic scoring needs a private manifest of expected test signals rather than prose keywords.

### Fixture difficulty guardrails

Do not treat every RED/GREEN seed as a useful A/B discriminator. A fixture is likely too easy for holdout if the exact upstream regression test already exists, the patch is an obvious one-line revert, or the allowed test command directly names the failing behavior. Those fixtures are still useful as runner/external-target smokes, but they should not be counted as hard holdout evidence for workflow-vs-plain superiority.

For hard A/B fixtures, prefer seeds where the arm must design or adapt a targeted repro: cross-file behavior, event ordering, async/concurrency, stateful protocol transitions, or traps that require semantic reasoning. Existing tests may be used for setup clues, but the answer key should record whether a novel repro test is expected versus whether an existing test is acceptable smoke evidence.

## Runner changes

Add a new task class, e.g. `dynamic-review-seeded-diff`, with per-arm worktrees that allow mutation inside the arm workspace. The runner should:

1. build isolated worktree(s),
2. copy/apply fixture patch before the arm begins or instruct the arm to apply it (prefer runner-applied for consistency),
3. allow tools needed for tests (`bash`, maybe package-manager commands),
4. collect:
   - changed files,
   - test files added/modified,
   - command logs,
   - final report,
5. restore/cleanup worktrees.

## Scoring signals

Prefer deterministic scoring over prose matching:

- **repro coverage**: expected seed has a test file and command that fails for the patched defect;
- **GREEN validation**: optional fix/revert makes that test pass;
- **trap precision**: no test/report claims a behavior-preserving trap as a defect;
- **scope hygiene**: no unrelated broad rewrites, no source modification outside tests unless explicitly allowed;
- **evidence quality**: command output includes exact test names and failure messages.

A hidden scorer should parse structured run artifacts first, not final prose. LLM extraction can summarize test intent, but pass/fail evidence should come from command logs.

## Arms to compare

Start with:

- A: `deep-review` followed by a test-writing/verification stage (new workflow or extension of deep-review)
- B: plain single Pi with the same mutation-capable tools
- C: plain self-check two-pass

Keep model constant (`kimi-coding/kimi-for-coding`, xhigh for first ceiling-breaking run). Later repeat with weaker thinking/model only after the harness works.

## Success criteria

The fixture is useful as a discriminator only if at least one arm misses or over-tests a seed/trap. If all arms produce complete RED/GREEN evidence, keep it as a smoke/regression fixture and increase subtlety before spending xhigh holdout budget:

- cross-file seeds requiring caller/context tests,
- time/concurrency tests with deterministic fake clocks or lock fixtures,
- seeds where a prose finding is easy but writing a reliable test is hard,
- traps that look testable but are semantically equivalent.

## Risks / gotchas

- Mutation-capable arms must be isolated from the real repo and from private answer keys.
- Test commands can be slow/flaky; use narrow test targets and deterministic fixtures.
- Runner-applied patches avoid the CC-v1 base-vs-patch failure mode.
- Do not score by final-report keywords; score by artifacts and command logs first.
