

# Load Angular CLI autocompletion.
source <(ng completion script)
export PATH="$HOME/.local/bin:$PATH"

# pnpm
export PNPM_HOME='/Users/deeveshbeegun/Library/pnpm'
case ":$PATH:" in
  ":$PNPM_HOME/bin:"*) ;;
  *) export PATH="$PNPM_HOME/bin:$PATH" ;;
esac
# pnpm end

export NVM_DIR="$HOME/.nvm"
[ -s "$(brew --prefix nvm)/nvm.sh" ] && source "$(brew --prefix nvm)/nvm.sh"
