# Claude Code dotfiles

Portable configuration for Claude Code and Kilo. Clone this repo on a new machine
and run `install.sh` to symlink everything into place.

## What's included

- `~/.claude/CLAUDE.md` — global working agreement and instructions
- `~/.claude/settings.json` — model, permissions, hooks, plugins, theme
- `~/.claude/settings.local.json` — machine-specific permission overrides
- `~/.claude/hooks/` — PreToolUse guards (bash + write)
- `~/.claude/skills/preflight-ci/` — CI preflight skill + MCPJam reference
- `~/.config/kilo/kilo.jsonc` — Kilo config

## Setup

```bash
git clone <url> ~/claude-dotfiles
cd ~/claude-dotfiles
bash install.sh
```

Existing configs are backed up to `~/.claude-backup-<timestamp>` before being replaced.

## Structure

```
claude-dotfiles/
├── install.sh
├── .claude/
│   ├── CLAUDE.md
│   ├── settings.json
│   ├── settings.local.json
│   ├── hooks/
│   │   ├── guard-bash.sh
│   │   └── guard-write.sh
│   └── skills/
│       └── preflight-ci/
│           ├── SKILL.md
│           └── references/
│               └── mcpjam-inspector.md
└── .config/
    └── kilo/
        └── kilo.jsonc
```

## Notes

- `settings.local.json` contains machine-specific permissions. Copy and edit for each machine.
- Hooks need to be executable (already set in the repo).
- The `.credentials.json` and session history in `~/.claude/` are intentionally excluded.
