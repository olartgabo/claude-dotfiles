# Working agreement — MCPJam

Shared Claude Code configuration for the team. This file holds only what is true
for everyone. Machine-specific facts — checkout paths, shell, which CLI tools
exist — live in `CLAUDE.local.md`, which Claude Code loads after this file.
Anything you'd have to change on a teammate's laptop belongs there, not here.

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

PreToolUse hooks in `~/.claude/hooks/` (`guard-bash.mjs`, `guard-write.mjs` —
one Node implementation on every platform) deny destructive git, deletes that
resolve outside the working directory, writes to credential files, literal
credentials in file content, edits to generated artifacts, and pipe-to-shell.
The README lists what they cover and what they deliberately don't.

If a guard blocks something genuinely needed, say so rather than working around
it — a rule with a false positive is a bug worth a fixture in
`tests/guards.test.mjs`. `CLAUDE_GUARD_OFF=1` is the deliberate escape hatch.

## Installing / updating

`node install.mjs` from a checkout of the dotfiles repo. It merges into your
existing settings, backs up what it replaces, and verifies the hooks are live
before it reports success. Re-run it to update. See the README.
