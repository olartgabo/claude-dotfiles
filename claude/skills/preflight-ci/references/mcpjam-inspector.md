# MCPJam Inspector — CI command set

An npm workspaces monorepo. Your checkout path is in `CLAUDE.local.md`; the
commands below all run from the **repo root**, not from `mcpjam-inspector/` — the
root `npm test` chains guards that the workspace scripts don't have.

Derived from `.github/workflows/lint.yml` (check name **"Build and Test"**) and
`.github/workflows/test.yml` (check names **"Run Tests"** and **"E2E Smoke
(Playwright)"**). Both run on `pull_request` into `main`. Re-read those files if a
check name in the PR doesn't appear below — the workflows change.

## The full preflight, cheap first

```bash
cd <your inspector checkout>
git fetch origin && git merge origin/main        # step 2: test the merged tree
export NODE_OPTIONS="--max-old-space-size=8192"  # see below — not optional here

npm run docs:check-tokens                        # Build and Test
npm run typecheck                                # Build and Test
npm run typecheck:client -w @mcpjam/inspector    # Build and Test
npm test                                         # Run Tests
npm run build:inspector                          # Build and Test
```

`npm test` is the long one — thousands of tests, one `concurrently` process per
workspace, `--kill-others-on-fail`. Everything above it is fast, so a failure
there saves you the wait. Read `test:parallel` in the root `package.json` for the
current workspace set rather than trusting a count written down here; workspaces
get added.

Capture real exit codes. `npm test | tail -20` reports *tail's* status, so a
failing run reads as success — pipe to a file and check `$?`, or `set -o
pipefail` first. This is the single easiest way to talk yourself into a green
that isn't there.

### Why `NODE_OPTIONS`

`test.yml` sets `--max-old-space-size=6144` because the vitest workspace runs
server + client + shared concurrently and blows past Node 24's default heap.

Locally it is needed for **`npm run typecheck` too**, which CI does not set it
for. On a machine with less headroom than the runner, that command dies partway
through the `@mcpjam/sdk` build with `ERR_WORKER_OUT_OF_MEMORY: Worker terminated
due to reaching memory limit` (tsup workers). That is a local resource limit, not
a type error — CI's "Build and Test" passes the same command. Export the heap flag
for the whole preflight and it exits 0. Don't go looking for a type error that
isn't there.

### What the root `npm test` chains

In order: `check:mcp-v1-runtime-imports` → `check:bundled-runtime-paths` →
`check:platform-runtime-safety` → build `@mcpjam/sdk` →
`check:platform-runtime-safety:dist` → `test:parallel` → `test:packaging -w
@mcpjam/sdk`.

The `check:*` guards are `! rg -n '...'` expressions, so they need `rg` on PATH.
`test.yml` apt-installs it into the Playwright container for exactly this reason.
**If `rg` is missing, the guards pass without checking anything** — the `!` makes
a failed invocation look like a clean result. Run `rg --version` once before you
trust a green `npm test` on a new machine.

`npm run verify` (typecheck + test + build:inspector) covers most of the above in
one command, but **not** `docs:check-tokens` or `typecheck:client`. Both are CI
gates. Prefer the explicit list.

## E2E — not worth running locally by default

```bash
npm run build -w @mcpjam/inspector
npm run test:e2e -w @mcpjam/inspector
npm run test:e2e:oauth-debugger -w @mcpjam/inspector
```

CI runs these in `mcr.microsoft.com/playwright:v1.59.1-noble`, pinned in lockstep
with the `@playwright/test` dependency. Run them locally only when the diff
touches routing, app boot, or the OAuth debugger; otherwise say you skipped them
and why. If you bump `@playwright/test`, bump the container tag in `test.yml` too.

## Reading a `test:parallel` failure

`test:parallel` runs 8 workspaces under `concurrently --kill-others-on-fail`. The
first real failure SIGTERMs the other seven, so the log ends with a pile of
casualties that look like failures and aren't:

```
[slack] npm run verify -w @mcpjam/slack-app exited with code 1     <- the cause
[sdk]   npm run test -w @mcpjam/sdk exited with code 143           <- killed
[cli]   npm run test -w @mcpjam/cli exited with code 143           <- killed
```

**Exit 143 is SIGTERM — a victim, never the cause.** Find the first line that
exited non-zero and non-143 and start there. Diagnosing the last error in the log
means debugging a workspace that was working fine. Interleaved output makes the
cause easy to miss:

```bash
grep -nE "exited with code|Sending SIGTERM" run.log | head
```

## When a workspace your diff never touched fails locally

It happens: a lint or format check goes red locally in a package you didn't
change, CI is green on the same commit, and because `--kill-others-on-fail` takes
down the whole run, you never get to the workspaces you care about.

Do **not** "fix" it by reformatting that package. CI is happy with those files;
rewriting them commits churn in code your diff never touched, which is exactly
the unrelated noise a reviewer will bounce. Instead:

1. Confirm CI is green there on the same SHA (`gh run view` on the base commit).
2. Run the workspaces your change actually affects, directly.
3. Say so in the PR: the root run was blocked locally by an unrelated workspace,
   and here is what you did verify.

Then chase the divergence separately — it is usually a tool version or a config
file resolving differently, and it is worth a fix, just not inside your PR.

## Iterating on a single failure

```bash
cd <your inspector checkout>/mcpjam-inspector
npx vitest run client/src/path/to/file.test.tsx
npm run test -w @mcpjam/sdk                      # one workspace
```

Fine for the debug loop. Always finish with the root `npm test` before pushing.

## Reading a failed CI run

```bash
gh pr view <n> --json statusCheckRollup           # which check failed
gh run view <run-id> --log-failed | sed 's/\x1b\[[0-9;]*m//g' | grep -aE "FAIL|Test Files|::error"
```

The logs carry ANSI escapes and GitHub `::error` annotations with `%0A`-encoded
newlines, so strip colors and grep rather than reading straight through — the
failed-log dump for this repo runs tens of KB.

Base-branch health:

```bash
gh run list --workflow=test.yml --branch main --limit 5 \
  --json conclusion,headSha,displayTitle
```

## Known trap: shared components that query the backend

`SettingsNav` calls `useGithubChecksAvailability`, which calls `useQuery` and
`useConvexAuth` from `convex/react`. Every test that renders any settings surface
therefore needs that stubbed, even tests with nothing to do with the feature:

```ts
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksAvailability: () => undefined,
}));
```

Stub the *hook*, not `convex/react` — mocking the module means enumerating every
export the tree reaches, and the next added export breaks you again. This is the
general shape of the trap: a component-level data dependency added to a widely
shared component turns unrelated test files red, and it lands as a semantic merge
conflict in every open PR that predates it.
