#!/bin/sh
set -eu
# g1-exp prepare：一次性实验实例（G1 制品）。
# 与 experiment 的差异：独立 state/sources/work；sources 惰性 clone（不与其它实例共享，避免 worktree 元数据串写）；
# 项目检查配置使用 G1 版（.g1.json：requirePlan + protectedAssets + acceptance 检查）。
instance=/Users/zm/dsh-instances/g1-exp
repo=${DSH_SUPERAGENT_GITHUB_REPOSITORY:-}
name=${DSH_SUPERAGENT_NAME:-}
[ -n "$repo" ] && [ -n "$name" ] || exit 0

src="$instance/sources/${repo#paxxie2/}"
if [ ! -e "$src/.git" ]; then
  case ":$PATH:" in *":/opt/homebrew/bin:"*) ;; *) PATH="/opt/homebrew/bin:$PATH" ;; esac
  case ":$PATH:" in *":/Users/zm/.local/bin:"*) ;; *) PATH="/Users/zm/.local/bin:$PATH" ;; esac
  export PATH
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  export GIT_CONFIG_COUNT=3
  export GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf'
  export GIT_CONFIG_VALUE_0='git@github.com:'
  export GIT_CONFIG_KEY_1='credential.helper'
  export GIT_CONFIG_VALUE_1=''
  export GIT_CONFIG_KEY_2='credential.helper'
  export GIT_CONFIG_VALUE_2='!/Users/zm/.local/bin/gh-agent auth git-credential'
  git clone --no-checkout "https://github.com/$repo.git" "$src"
fi

export HEPHI_STATE_DIR="$instance/state"
export HEPHI_GH_CLI='/Users/zm/.local/bin/gh-agent'
export GIT_CONFIG_COUNT=3
export GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf'
export GIT_CONFIG_VALUE_0='git@github.com:'
export GIT_CONFIG_KEY_1='credential.helper'
export GIT_CONFIG_VALUE_1=''
export GIT_CONFIG_KEY_2='credential.helper'
export GIT_CONFIG_VALUE_2='!/Users/zm/.local/bin/gh-agent auth git-credential'

case "$repo" in
  paxxie2/site-pnl-diagnosis)
    export HEPHI_SOURCE_REPO="$src"
    export HEPHI_ALLOWED_PATHS='["backend/**","web/**","acceptance/**","contracts/**","scripts/**","docs/**","README.md","INTERFACES.md","pyproject.toml","uv.lock",".python-version",".gitignore",".env.example"]'
    export HEPHI_VERIFICATION_FILE="$instance/project-config/b5-site-pnl-checks.g1.json"
    ;;
  paxxie2/b5-off-*|paxxie2/b5-native-*)
    export HEPHI_SOURCE_REPO="$src"
    export HEPHI_ALLOWED_PATHS='["backend/**","web/**","acceptance/**","contracts/**","scripts/**","docs/**","README.md","INTERFACES.md","pyproject.toml","uv.lock",".python-version",".gitignore",".env.example"]'
    export HEPHI_VERIFICATION_FILE="$instance/project-config/b5-generic-checks.g1.json"
    ;;
  paxxie2/super-agent-hephi-review)
    export HEPHI_SOURCE_REPO="$src"
    export HEPHI_ALLOWED_PATHS='["scripts/host/**","hephi/src/**","hephi/tests/**","hephi/scripts/**","hephi/docs/**","hephi/package.json","hephi/pnpm-lock.yaml","hephi/tsdown.config.ts","docs/**"]'
    export HEPHI_VERIFICATION_FILE="$instance/project-config/hephi-checks.g1.json"
    ;;
  *)
    exit 0
    ;;
esac
exec /bin/sh "$instance/hephi-review/hephi/scripts/prepare-dubbo.sh"
