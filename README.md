# Claude Code dotfiles

Portable Claude Code configuration shared across the MCPJam team. This repo is
a **copy source**, not an installer — copy it into your `~/.claude/` (or symlink
it) and let Claude read the shared agreement, guard hooks, and skills.

## What's included

- `.claude/CLAUDE.md` — shared working agreement and quality bar
- `.claude/CLAUDE.local.md.example` — per-machine overlay template
- `.claude/settings.json` — hooks, permissions, plugins
- `.claude/settings.local.json.example` — machine-specific permission overrides
- `.claude/hooks/guard-bash.{sh,ps1}` — destructive-command guard
- `.claude/hooks/guard-write.{sh,ps1}` — write/secret guard
- `.claude/skills/preflight-ci/` — CI preflight skill + MCPJam reference
- `.claude/skills/review-lessons-mcpjam/` — recurring CodeRabbit/cubic findings
- `.config/kilo/kilo.jsonc` — Kilo config

## Setup

```bash
git clone https://github.com/olartgabo/claude-dotfiles ~/claude-dotfiles
cp -r ~/claude-dotfiles/.claude/* ~/.claude/
cp ~/claude-dotfiles/.claude/CLAUDE.local.md.example ~/.claude/CLAUDE.local.md
```

or symlink to stay on the repo's latest:

```bash
git clone https://github.com/olartgabo/claude-dotfiles ~/claude-dotfiles
ln -s ~/claude-dotfiles/.claude ~/.claude
```

Existing configs: copy over them intentionally — the repo's files are the
source of truth for the shared parts. Machine-specific files (`settings.local.json`,
`CLAUDE.local.md`, `.credentials.json`) are gitignored and never overwritten by
the repo.

## Windows

Claude Code config lives in `%USERPROFILE%\.claude\`. Use the `.ps1` hooks:
point the `PreToolUse` hook commands in `settings.json` at
`C:\Users\<you>\.claude\hooks\guard-write.ps1` and `guard-bash.ps1`:

```jsonc
"command": "powershell -NoProfile -File \"C:\\Users\\<you>\\.claude\\hooks\\guard-write.ps1\""
```

macOS/Linux teammates leave the default `~/.claude/hooks/guard-*.sh` commands.

## Post-copy

1. Edit `~/.claude/CLAUDE.local.md` — checkout path, shell, tools.
2. Create `~/.claude/settings.local.json` from the example — it holds
   machine-local `permissions.allow` entries.
3. Restart Claude Code so it reloads config and hooks.

## Structure

```
claude-dotfiles/
├── .claude/
│   ├── CLAUDE.md
│   ├── CLAUDE.local.md.example
│   ├── settings.json
│   ├── settings.local.json.example
│   ├── hooks/
│   │   ├── guard-bash.sh / guard-bash.ps1
│   │   └── guard-write.sh / guard-write.ps1
│   └── skills/
│       ├── preflight-ci/
│       └── review-lessons-mcpjam/
└── .config/
    └── kilo/
        └── kilo.jsonc
```

## Notes

- Hooks deny destructive git (`reset --hard`, force-push to `main`, `clean -fd`),
  `.env` writes, literal credentials, generated artifacts, and pipe-to-shell.
  `CLAUDE_GUARD_OFF=1` is the deliberate escape hatch.
- `.sh` hooks need `jq`; on machines without it, use the `.ps1` variants
  (PowerShell only, no external deps).
- `settings.json` is shared but holds the team's plugin and model choices — keep
  personal UI preferences in `settings.local.json`.
