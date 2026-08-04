---
name: preflight-ci
description: >
  Run the repository's real CI checks locally and prove they pass before a branch
  is pushed or a PR is opened. Use this whenever the user is about to open, push,
  or update a pull request, says a change is "done"/"ready"/"ready to merge",
  asks whether CI will pass, or asks why CI is red — and also before you claim on
  your own that work is complete. Triggers on: "open a PR", "push this", "is this
  ready", "will CI pass", "CI failed", "the build is red", "checks are failing",
  "before I merge". A red PR is a preventable failure; assume this skill applies
  unless the user has explicitly said to skip verification.
---

# Preflight CI

A red PR costs a reviewer's cycle and a batch of runner minutes to tell you
something you could have learned locally in one command. The goal here is narrow:
reach a state where you have *seen* the same commands CI will run exit zero, on
the same tree CI will build.

Two failures cause almost every surprise red PR, and neither is caught by running
the tests you happen to think are relevant:

1. **You ran a narrower command than CI runs.** A workspace-scoped test skips the
   repo guards, typechecks, and sibling workspaces that the root command chains
   together.
2. **You tested the wrong tree.** Your diff is green against the base you branched
   from; CI tests the merge of your diff with base branch *now*. When something
   landed on base that your diff never saw, the merge is red while both halves
   are green. This is a semantic merge conflict, and it is invisible to `git
   merge` — no conflict markers, no warning, just failing tests.

## Workflow

### 1. Derive the command list — don't guess it

Read the workflows that run on pull requests rather than recalling what a repo
usually does. The point is to catch checks you'd never think to run.

```bash
rg -l "pull_request" .github/workflows/
rg -n "run:" .github/workflows/<each-pr-workflow>.yml
```

Collect every `run:` step across every PR-triggered job, plus the `env:` block —
CI often sets something load-bearing (a heap size, a skip flag) that your shell
does not. Note steps that install a tool the job needs; if the check is a
`! rg ...` guard and `rg` is missing, the shell returns 127, `! 127` is 0, and
the guard passes vacuously. A check that cannot fail is telling you nothing.

If the repo has its own CI/verification skill or a documented `verify` script,
that supersedes this step.

### 2. Test the tree CI will test

Bring the branch up to date with base *before* running anything, so the tree you
verify is the tree CI builds:

```bash
git fetch origin
git merge origin/<base>     # or rebase, per the repo's convention
```

Skipping this is what makes a preflight pass and the PR fail anyway.

### 3. Establish whether base is already red

Do this before attributing any failure to your own diff. It costs one command
and changes what you should do next:

```bash
gh run list --workflow=<ci-workflow>.yml --branch <base> --limit 5 \
  --json conclusion,headSha,displayTitle
```

- **Base is green, your branch is red** → your diff. Fix it.
- **Base is red on the same checks** → you inherited it. Fixing it is still the
  right move to unblock the PR, but say so plainly in the PR description and
  commit message: the diff now contains a repair that isn't yours, and a reviewer
  who doesn't know that will read it as scope creep. Consider whether it belongs
  in a separate PR that lands first.

Never report an inherited failure as if your change caused it, or your change as
if the base caused it. Both misdirect whoever reads it next.

### 4. Run the checks, cheap first

Order by how fast they fail, so you spend the long run only on a tree that has
already cleared the quick gates: guards and format checks, then typecheck, then
the full test command, then build, then e2e. Run the *root* command CI runs, not
a subset — the chained steps are part of the check.

Narrow, workspace-scoped runs are for the debugging loop while you iterate. They
never substitute for the full run at the end.

When the full run fans out across packages in parallel, the first real failure
usually kills the siblings, and their termination shows up in the log as further
failures. Find the *first* thing that failed on its own before diagnosing
anything — a process killed by a signal (exit 143 on SIGTERM) is a casualty, not
a cause, and debugging it means debugging code that was working.

### 5. Prove it, then say it

State only what you watched exit zero, and quote the real summary line — counts
and exit status, not a paraphrase.

Make sure the exit code you read is the one you think it is. `npm test | tail -20`
reports the status of *tail*, which is always 0, so a failing run looks green and
you report a pass that never happened. Redirect to a file and check `$?`, or `set
-o pipefail` before the pipeline. Any check whose result you inferred rather than
observed is unverified.

If a check is genuinely impractical to run locally (needs a container, secrets, a
pinned browser image), say which one and why rather than implying full coverage.
Partial verification honestly described is useful; "should be fine" is not.

If anything is still red, the branch is not ready. Report the failure with its
output rather than describing it as nearly passing.

## Applying the fix

When a check fails, fix the cause rather than the symptom, and keep the repair
proportional — a broken mock gets a working mock, not a rewritten test. Match how
the repo already solves the same problem: if the code that broke your test shipped
with its own tests, read how *those* stub the new dependency and follow that
pattern instead of inventing a second convention.

Then re-run the full command. A fix you have not re-verified is a guess.

## Repo-specific command sets

- MCPJam Inspector (`~/Github/MCPJAM/inspector`) →
  read `references/mcpjam-inspector.md`

For any other repo, derive the list per step 1 and consider adding a reference
file here once you've done it, so the next run starts from the answer.
