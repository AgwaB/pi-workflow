# Multi-Provider Gold-Key Workflow

## Purpose

Use multiple LLM providers to improve gold-key quality without letting live scoring depend on model preference.

## Roles

1. **Author A** — drafts the gold key from the fixture diff and sanitized source.
2. **Author B** — independently drafts a gold key with no access to Author A's draft.
3. **Skeptical reviewer** — compares drafts, searches for missing bugs, false positives, ambiguous claims, and leakage risks.
4. **Reconciler** — merges only source-grounded claims into a draft gold key.
5. **Lock reviewer** — final checks before setting `status: locked`.

Use different providers where available, e.g. GPT-5.5 xhigh, Kimi xhigh, and a third family if configured.

## Review checklist

Each provider must answer:
- Is the patch realistic for this repository?
- Is the asserted bug objectively present in the diff/source?
- Is the location specific enough for line/file scoring?
- Does the evidence quote exist in the source/diff?
- Is the expected fix safe and not over-specific?
- Are there plausible false positives or no-issue regions?
- Is the task too easy, too hard, or likely medium difficulty?
- Does any candidate-visible material leak the answer?

## Disagreement handling

- If providers disagree on whether a bug exists: mark task `needs-review` and rewrite/reject unless deterministic evidence resolves it.
- If they agree on existence but disagree on severity: keep the lower severity unless impact evidence justifies higher.
- If they agree on bug but not location: include all acceptable locations or rewrite the task to make evidence clearer.
- If one provider finds an extra bug: either add it to gold with evidence or modify fixture to isolate one intended issue.

## Lock criteria

A gold key can be locked only when:
- source revision is pinned,
- fixture diff is stable,
- every gold bug has evidence quotes and file/line locations,
- no-issue regions/must-avoid claims are documented,
- at least two independent provider reviews are archived,
- leakage checklist passes.

LLM provider outputs are untrusted inputs. They inform the locked gold key but do not override deterministic evidence or maintainer judgment.
