# MCPJam Inspector — CI command set

Repo root: `~/Github/MCPJAM/inspector` (npm workspaces monorepo). Run everything
from the **repo root**, not from `mcpjam-inspector/` — the root `npm test` chains
guards that the workspace scripts don't have.

Derived from `.github/workflows/lint.yml` (check name **"Build and Test"**) and
`.github/workflows/test.yml` (check names **"Run Tests"** and **"E2E Smoke
(Playwright)"**). Both run on `pull_request` into `main`. Re-read those files if a
check name in the PR doesn't appear below — the workflows change.

## The full preflight, cheap first

```bash
cd ~/Github/MCPJAM/inspector
git fetch origin && git merge origin/main        # step 2: test the merged tree
export NODE_OPTIONS="--max-old-space-size=8192"  # see below — not optional here

npm run docs:check-tokens                        # Build and Test
npm run typecheck                                # Build and Test
npm run typecheck:client -w @mcpjam/inspector    # Build and Test
npm test                                         # Run Tests
npm run build:inspector                          # Build and Test
```

`npm test` is the long one (~12.5k tests across 8 workspaces via
`concurrently --kill-others-on-fail`). Everything above it is fast, so a failure
there saves you the wait.

Capture real exit codes. `npm test | tail -20` reports *tail's* status, so a
failing run reads as success — pipe to a file and check `$?`, or `set -o
pipefail` first. This is the single easiest way to talk yourself into a green
that isn't there.

### Why `NODE_OPTIONS`

`test.yml` sets `--max-old-space-size=6144` because the vitest workspace runs
server + client + shared concurrently and blows past Node 24's default heap.

Locally it is needed for **`npm run typecheck` too**, which CI does not set it
for. On a 14 GB machine that command dies partway through the `@mcpjam/sdk` build
with `ERR_WORKER_OUT_OF_MEMORY: Worker terminated due to reaching memory limit`
(tsup workers). That is a local resource limit, not a type error — CI's "Build and
Test" passes the same command. Export the heap flag for the whole preflight and it
exits 0. Don't go looking for a type error that isn't there.

### What the root `npm test` chains

In order: `check:mcp-v1-runtime-imports` → `check:bundled-runtime-paths` →
`check:platform-runtime-safety` → build `@mcpjam/sdk` →
`check:platform-runtime-safety:dist` → `test:parallel` (8 workspaces) →
`test:packaging -w @mcpjam/sdk`.

The `check:*` guards are `! rg -n '...'` expressions. They need `rg` on PATH —
present on this machine, and `test.yml` apt-installs it into the Playwright
container for exactly this reason. If `rg` were missing the guards would pass
without checking anything.

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

## Known local-only divergence: `slack-app` biome

Root `npm test` currently fails locally at `npm run verify -w @mcpjam/slack-app`
(`npx @biomejs/biome check .` → 5 **format**-category diagnostics), and that
failure kills the whole parallel run before the workspaces you care about finish.

CI runs the identical command on the identical commit and reports `Checked 59
files. No fixes applied.` with exit 0. Verified identical on both sides: biome
2.5.6 (wrapper and every `@biomejs/cli-*` platform package), `slack-app/biome.json`
(tracked, not gitignored, no `.editorconfig` anywhere up the tree), and the file
blobs. No biome daemon is running locally. **The cause is unresolved** — treat it
as environmental until someone reproduces it in CI.

Do **not** "fix" it by running `biome check --write` on `slack-app`. CI is happy
with those files; reformatting them commits churn in a package your diff never
touched, which is exactly the unrelated-noise a reviewer will bounce. If a run
dies here and your diff is nowhere near `slack-app`, run the workspaces your
change affects directly and say in the PR that the root run was blocked locally by
this and which parts you did verify.

## Iterating on a single failure

```bash
cd ~/Github/MCPJAM/inspector/mcpjam-inspector
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
