set -euo pipefail

DOTFILES="$HOME/claude-dotfiles"
BACKUP="$HOME/.claude-backup-$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP"

backup_if_exists() {
  if [ -e "$1" ] && [ ! -L "$1" ]; then
    mkdir -p "$(dirname "$BACKUP/$1")"
    mv "$1" "$BACKUP/$1"
    echo "Backed up $1 -> $BACKUP/$1"
  elif [ -L "$1" ]; then
    echo "Removing old symlink $1"
    rm "$1"
  fi
}

echo "Installing claude-dotfiles..."

backup_if_exists "$HOME/.claude/CLAUDE.md"
ln -s "$DOTFILES/.claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"

backup_if_exists "$HOME/.claude/settings.json"
ln -s "$DOTFILES/.claude/settings.json" "$HOME/.claude/settings.json"

backup_if_exists "$HOME/.claude/settings.local.json"
ln -s "$DOTFILES/.claude/settings.local.json" "$HOME/.claude/settings.local.json"

backup_if_exists "$HOME/.claude/hooks"
ln -s "$DOTFILES/.claude/hooks" "$HOME/.claude/hooks"

backup_if_exists "$HOME/.claude/skills"
ln -s "$DOTFILES/.claude/skills" "$HOME/.claude/skills"

backup_if_exists "$HOME/.config/kilo/kilo.jsonc"
ln -s "$DOTFILES/.config/kilo/kilo.jsonc" "$HOME/.config/kilo/kilo.jsonc"

echo "Done. Existing configs backed up to $BACKUP"
