# Working agreement — MCPJam

Shared Claude Code configuration for the team. Machine-specific facts (paths,
shell, OS-specific tooling) live in `CLAUDE.local.md`, which Claude Code loads
after this file. Copy `CLAUDE.local.md.example` to create yours.

## Who this is for

Engineers at MCPJam. Main codebase: the MCPJam Inspector — an npm workspaces
monorepo (TypeScript, React + Vite client, Hono server, MCP SDK, Convex,
deployed via Railway). Point `CLAUDE.local.md` at your local checkout.

## Subagents and parallelism — opt in

Use subagents freely. Fan out `Explore`, `Plan`, and `general-purpose` agents
**in parallel** whenever a question spans multiple files, directories, or
subsystems — don't ask permission first, and don't hand-search serially what
three agents could sweep at once. Same for `Workflow` when someone asks for
orchestration.

## Quality bar: fewer review-bot comments

Code goes through CodeRabbit, cubic, and human review. The goal is that those
reviewers find nothing. Before saying a change is done:

- Run the real check, don't assume: `npm run typecheck`, `npm run test`, or the
  narrow workspace form (`npm run test -w @mcpjam/sdk`). Report output verbatim;
  never claim green without having seen green.
- Self-review the diff with `/code-review` before pushing anything reviewers
  will see, and check the work against the `review-lessons-mcpjam` skill (the
  recurring classes CodeRabbit/cubic flag: SSRF, authn/authz, races, leaks,
  zod/parse traps, TS compile breakers).
- No dead code, no commented-out blocks, no unused params, no `any` smuggled in
  to silence a type error, no `console.log` left behind, no swallowed `catch`.
- Match the surrounding file's idiom, naming, and comment density. Comments
  explain *why*, never restate the line above them.
- Don't add defensive layers, config knobs, abstractions, or error handling
  nobody asked for. Smallest correct diff that solves the actual request.
- Tests: cover the behavior that broke or the behavior being added. Don't add
  tests that assert the mock.

## Prose: no slop

Applies to PR descriptions, commit messages, docs, comments, and Slack. Never
ship: "It's not X, it's Y" binary contrasts, throat-clearing openers ("Let's
dive in", "Great question"), false-insight setups, colon reveals, dramatic
one-word fragments, puffery ("robust", "seamlessly", "delve", "leverage" as a
verb), or fake-profound closers. Write what changed and why, in plain
declarative sentences.

## Monorepo rules

- Never hand-edit generated or built output: `dist/`, `out/`, `*.bundled.ts`,
  `*.generated.ts`, lockfiles. Edit the generator or source, then rebuild.
- Run scripts against the right workspace (`-w @mcpjam/<pkg>`) rather than
  guessing from the repo root.
- Prettier is repo-local; formatting drift fails review. Format the file you
  touched before pushing.
- Branch before editing. Don't commit to `main`.

## Guard hooks

PreToolUse hooks in `~/.claude/hooks/` (`.sh` on macOS/Linux, `.ps1` on
Windows) deny destructive git, `.env` writes, literal credentials, generated
artifacts, and pipe-to-shell. If a guard blocks something you genuinely need,
say so rather than working around it; `CLAUDE_GUARD_OFF=1` is the deliberate
escape hatch.

## Installing / updating

The repo is a copy source, not an installer. Copy `.claude/` into your
`~/.claude/` (or symlink it), then create `CLAUDE.local.md` and
`settings.local.json` for this machine. See the README.
