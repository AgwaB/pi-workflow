# Contributing to pi-workflow

Thanks for contributing to pi-workflow. This guide covers public documentation, code, workflows, and package changes.

## AI use and responsibility

You may freely use AI tools and autonomous agents for code, documentation, issues, and pull requests. No AI-use disclosure is required.

You must be able to explain what your change does, why it is needed, and how it affects the relevant workflow, runtime, or public interface. AI-assisted and agent-submitted contributions follow the same validation and review requirements as any other contribution.

## Choose the right entry path

Open a pull request directly for a typo, clarification, or small documentation correction that does not change behavior.

For code, workflows, public APIs or schemas, performance or default changes, security-related design or configuration work, releases, or package changes, discuss the change in an existing issue or open one and align with a maintainer on:

- the problem and intended outcome;
- the proposed scope and non-goals;
- related issues or pull requests; and
- the validation plan.

Search existing issues and pull requests before opening a new one. Use **Bug Report** for a reproducible fault and **Change Proposal** to discuss a proposed change. An existing bug report can serve as the coordination issue; a separate proposal is not needed once a maintainer agrees on the scope and validation.

Keep issues short, concrete, and actionable: state the problem, why it matters, and whether you intend to implement the change. Never include credentials, access tokens, or private data. For suspected vulnerabilities, use [private security reporting](SECURITY.md) instead of a public issue or pull request.

Keep each pull request focused on one feature, fix, or documentation change. Do not combine unrelated cleanup with a behavioral change.

## Set up a local checkout

pi-workflow requires Node.js `>=22.19.0` on macOS or Linux. Native Windows is not supported; use WSL2 instead.

Install the locked dependencies:

```bash
npm ci --legacy-peer-deps
```

Follow the surrounding code and documentation style. Keep generated workflow runs, session data, and local investigation files out of commits.

## Verify your change

Run every applicable check below. If a change fits more than one category, run the combined set of checks and report the results in the pull request.

| Change type | Required validation before opening a PR |
| --- | --- |
| Documentation-only | Review the rendered Markdown and verify changed links, commands, and examples. |
| General code or configuration | `npm run validate` |
| Workflow, CLI, or runtime behavior | `npm run validate` and `npm run e2e` |
| Package contents, exports, or install surface | `npm run validate`, `npm run e2e`, and `npm run pack:dry` |
| Performance or default behavior | Include the applicable checks above plus an agreed before/after comparison and evidence that the change does not regress the affected behavior. |

Changes to workflow prompts, agent/skill instructions, schemas, or helpers that affect behavior belong in the workflow/runtime category, regardless of file extension. For bug fixes, add a regression test when practical; otherwise explain how you verified the fix.

GitHub CI independently runs validation, E2E, and a package dry run across its supported OS and Node.js matrix. Local checks do not replace CI. If you cannot run an applicable check, say so in the pull request and explain why.

## Write commits

Use a concise conventional-commit subject, for example:

```text
fix: preserve workflow artifact paths
```

A commit body is welcome when it explains the change's context or rationale. Standard Git trailers are allowed when they are accurate. For example, use `Co-authored-by` for an actual human coauthor:

```text
fix: preserve workflow artifact paths

Explain why the previous behavior was unsafe.

Co-authored-by: Example Contributor <contributor@example.com>
```

Do not use a tool or model as a human coauthor, and do not add inaccurate attribution. The project does not currently require DCO sign-off.

## Open a pull request

Use the repository pull request template. Replace its prompts with the relevant information rather than leaving required context blank.

A pull request should include:

- a short description of the problem and the change;
- a link to the prior coordination issue when one is required;
- the validation commands run and their results, plus anything not run;
- any behavior, compatibility, performance, or package-surface impact; and
- enough reproduction detail for a bug fix to be understood and checked.

Passing CI does not guarantee that a pull request will be merged. Maintainers may request changes to scope, implementation, tests, documentation, or validation evidence.
