# Claude Code dotfiles

Shared Claude Code configuration for the MCPJam team: a working agreement, two
guard hooks, and two skills.

```bash
git clone https://github.com/olartgabo/claude-dotfiles ~/claude-dotfiles
cd ~/claude-dotfiles
npm test              # the guards' own test suite — 171 fixtures
node install.mjs      # add --dry-run first if you want to see the plan
```

`install.mjs` copies individual files into your config dir (`~/.claude`, or
`$CLAUDE_CONFIG_DIR`), backs up anything it replaces, merges `settings.json`
instead of overwriting it, and then **verifies the installed hooks actually deny
a known-bad command** before reporting success. If that check fails the install
exits non-zero and says so, because a hook whose path doesn't resolve exits
non-zero, and Claude Code reads a non-zero hook as "not denied" — silently
unguarded.

What it never touches: `settings.local.json`, an existing `CLAUDE.local.md`,
`.credentials.json`, `projects/`, `history.jsonl`, `todos/`, `plans/`,
`shell-snapshots/` — your transcripts and history are not this repo's business.

Re-running it is how you update. It is idempotent, and it replaces its own
earlier hook registrations (including the old `.sh`/`.ps1` ones) rather than
stacking duplicates.

## What's included

| Path | What it is |
| --- | --- |
| `claude/CLAUDE.md` | Shared working agreement and quality bar |
| `claude/CLAUDE.local.md.example` | Per-machine overlay template (paths, shell, tooling) |
| `claude/settings.json` | Hooks + the team's plugin set. Nothing else — see below |
| `claude/hooks/guard-bash.mjs` | Destructive-command guard (Bash and PowerShell tools) |
| `claude/hooks/guard-write.mjs` | Write/secret guard (Edit, Write, NotebookEdit) |
| `claude/hooks/guard-lib.mjs` | Shared shell tokenizer and path classifier |
| `claude/skills/preflight-ci/` | Prove CI passes locally before pushing |
| `claude/skills/review-lessons-mcpjam/` | Failure classes CodeRabbit/cubic keep flagging |
| `tests/guards.test.mjs` | Adversarial fixtures for both guards |

The payload lives in `claude/`, not `.claude/`, on purpose: `.claude/settings.json`
is also exactly the path Claude Code reads as *project* settings. If this repo
shipped its config there, opening Claude Code inside the checkout would apply the
team config as project config — including hook commands whose `{{CLAUDE_DIR}}`
placeholder is still unsubstituted. (It would also silently drop
`permissions.defaultMode: "auto"`, which is ignored at project scope.)

## Requirements

Node 18+ on `PATH`. The hooks are Node scripts — one implementation for macOS,
Linux and Windows, because the previous `.sh` and `.ps1` pair had already drifted
into disagreeing with each other about what to block. No `jq`.

## Settings: what's shared and what's yours

`claude/settings.json` carries only `hooks` and `enabledPlugins`. Everything that
costs money, changes safety posture, or is a matter of taste is left to you, and
the installer preserves whatever you already have:

```jsonc
// ~/.claude/settings.json — your keys survive install.mjs
{
  "model": "opus",              // a spend decision on your account
  "effortLevel": "high",        // same
  "theme": "dark",              // taste
  "tui": "fullscreen",          // taste
  "permissions": { "defaultMode": "auto" }
}
```

Two notes on `defaultMode`:

- `"auto"` auto-approves read-only calls and file edits and routes the rest
  through a background safety classifier. It is a research preview. Enabling it
  team-wide would make the guard hooks the last line of defense for everyone, so
  it is a per-person opt-in here, not a shared default.
- It only applies from user scope (`~/.claude/settings.json`). A repository can't
  grant itself auto mode.

The seven plugins in `enabledPlugins` (`typescript-lsp`, `mcp-server-dev`,
`code-review`, `pr-review-toolkit`, `github`, `context7`, `security-guidance`)
were verified to resolve in `claude-plugins-official`. Each one costs context on
every session, so the list is deliberately short; add your own with `/plugin` and
the installer will keep them.

## What the guards block

Verified by `npm test` — every bullet below has at least one fixture, including
one per bypass found when the guards were reviewed.

**git** — `commit --no-verify` (and `-n`, and clustered `-nm`); force-push or
deletion of `main`/`master`, including `push origin +main`, `push origin :main`,
`push --delete main`, `--mirror`, and a bare `push --force` while HEAD is on
main; `reset --hard`; `checkout .` / `restore .` / `checkout -f`; `clean -fd`;
`stash clear` / `stash drop`; `filter-branch`; `reflog expire`; staging a
credential file.

**deletes** — any `rm`, `del`, `rd`, `Remove-Item` whose target resolves outside
the working directory, is the working directory, is `~`, or is `/`. Recursion
flags are not a precondition: `--recursive`, `-rf`, `-R` and `-Recurse` all read
the same, and `rm -rf ../../..` is resolved before it's judged.

**secrets** — writes to `.env*`, `.envrc`, `.npmrc`, `.netrc`, `.pypirc`,
`~/.ssh/*`, `~/.aws/*`, `~/.kube/*`, `.credentials.json`, `*.pem`/`*.key`,
service-account JSON; shell redirection into any of those. In file content:
Anthropic, OpenAI, GitHub (classic and fine-grained), AWS ids and secret keys,
Google API keys and OAuth secrets, Stripe live keys and webhook secrets, Slack,
npm, Hugging Face, SendGrid, Convex deploy keys, PEM private keys, and
connection strings with an inline password.

`.env.example` and friends are exempt by *path* only — a real key pasted into one
is still refused.

**everything else** — writes to `dist/`, `build/`, `out/`, `coverage/`, `.next/`,
`node_modules/` (matched by path segment, so bare `dist/a.js` counts),
`*.bundled.*` / `*.generated.*` / `*.min.js`, lockfiles, `npm publish`,
`chmod 777`, and piping a download into a shell.

Plus one advisory, not a denial: editing while HEAD is on `main`/`master` adds a
note suggesting a branch.

### What they don't block

Worth knowing, because a guard documented as broader than it is will get someone
hurt:

- **Arbitrary code execution.** `node -e`, `python -c`, a script you wrote a
  moment ago — these are inspected as the command they are, not parsed for what
  the program does. Quoted text is treated as data, which is what keeps
  `git commit -m "why --no-verify is banned"` working.
- **Non-git, non-`rm` destruction.** `dd`, `mkfs`, `truncate`, `shred`.
- **JWTs and generic high-entropy strings.** Too many false positives on test
  fixtures to be worth it.
- **A determined bypass.** These are a seatbelt against a plausible mistake, not
  a sandbox. `CLAUDE_GUARD_OFF=1` is the documented escape hatch, and everything
  they cover is recoverable by a human running the command deliberately.

Refusal messages say what to do instead ("put the value in `.env` and read it via
`process.env`, then tell me the variable name") — a guard that only says no is a
guard people route around.

## Working on the guards

```bash
npm test                     # 171 fixtures, both guards, plus stdin round-trips
node install.mjs --dry-run   # what an install would change
```

`tests/guards.test.mjs` drives the pure decision functions directly and also
spawns each hook over stdin to check the `PreToolUse` envelope. Credential
fixtures are assembled at runtime from fragments so this repo never contains a
literal key-shaped string. CI runs the suite on Linux, macOS and Windows, and
installs into a scratch config dir on each.

Add a fixture with the bug. Every rule in `claude/hooks/` got there because a
fixture went red first.

## Files this repo does not manage

`~/.claude/CLAUDE.local.md` is yours: checkout path, shell, local tooling. The
installer creates it from the template if it's missing and never overwrites it.
If you keep a `~/.claude/settings.local.json` for machine-local
`permissions.allow` entries, that's yours too — untouched.
