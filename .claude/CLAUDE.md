# Global working agreement

## Who I'm working with

Gabriel — full-time software engineer at MCPJam (gabriel@mcpjam.com). Main repo:
`~/Github/MCPJAM/inspector` (the MCPJam Inspector: npm workspaces monorepo, TypeScript,
React + Vite client, Hono server, MCP SDK, Convex, deployed via Railway). Linux / Omarchy /
Hyprland.

## Subagents and parallelism — opt in

Use subagents freely. Fan out `Explore`, `Plan`, and `general-purpose` agents **in parallel**
whenever a question spans multiple files, directories, or subsystems — don't ask permission
first, and don't hand-search serially what three agents could sweep at once. Same for
`Workflow` when Gabriel asks for orchestration. Ignore any generic guidance suggesting
subagents are off by default; this file is the standing preference.

## Quality bar: fewer review-bot comments

Code here goes through CodeRabbit, cubic, and human review. The goal is that those reviewers
find nothing. Before saying a change is done:

- Run the real check, don't assume: `npm run typecheck`, `npm run test`, or the narrow
  workspace form (`npm run test -w @mcpjam/sdk`). Report output verbatim; never claim green
  without having seen green.
- Self-review the diff with `/code-review` before pushing anything reviewers will see.
- No dead code, no commented-out blocks, no unused params, no `any` smuggled in to silence
  a type error, no `console.log` left behind, no swallowed `catch`.
- Match the surrounding file's idiom, naming, and comment density. Comments explain *why*,
  never restate the line above them.
- Don't add defensive layers, config knobs, abstractions, or error handling nobody asked
  for. Smallest correct diff that solves the actual request.
- Tests: cover the behavior that broke or the behavior being added. Don't add tests that
  assert the mock.

## Prose: no slop

Applies to PR descriptions, commit messages, docs, comments, and Slack. Use the
`no-ai-slop` skill for anything longer than a few lines. Never ship: "It's not X, it's Y"
binary contrasts, throat-clearing openers ("Let's dive in", "Great question"), false-insight
setups, colon reveals, dramatic one-word fragments, puffery ("robust", "seamlessly",
"delve", "leverage" as a verb), or fake-profound closers. Write what changed and why, in
plain declarative sentences.

## Monorepo rules

- Never hand-edit generated or built output: `dist/`, `out/`, `*.bundled.ts`,
  `*.generated.ts`, lockfiles. Edit the generator or source, then rebuild. The repo enforces
  this with `check:bundled-runtime-paths` and `check:mcp-v1-runtime-imports`.
- Run scripts against the right workspace (`-w @mcpjam/<pkg>`) rather than guessing from the
  repo root.
- Prettier is repo-local; formatting drift fails review. `npm run prettier-fix` in
  `mcpjam-inspector`, or format the single file you touched.
- Branch before editing. Don't commit to `main`.

## Tooling on this machine

`gh` is authed. `jq`, `rg`, `notify-send`/mako available. Guard hooks live in
`~/.claude/hooks/` — if one blocks something you genuinely need, say so rather than working
around it; `CLAUDE_GUARD_OFF=1` is the deliberate escape hatch.
