#!/bin/sh
set -eu

# Kept at the configured entry path; preparation is project-independent.
number=${DSH_SUPERAGENT_GITHUB_NUMBER:-}
[ -n "$number" ] || exit 0
repo=${DSH_SUPERAGENT_GITHUB_REPOSITORY:?}
workspace=${DSH_SUPERAGENT_DIR:?}
ticket_name=${DSH_SUPERAGENT_NAME:?}
gh_cli=${HEPHI_GH_CLI:-gh}
labels=$("$gh_cli" api "repos/$repo/issues/$number" --jq '.labels[].name')
printf '%s\n' "$labels" | grep -Fxq 'hephi/delivery' || exit 0

# Fail before touching the checkout if the project's explicit settings are absent.
: "${HEPHI_SOURCE_REPO:?set the existing local project clone}"
: "${HEPHI_STATE_DIR:?use the same stateDir as the mounted plugin}"
: "${HEPHI_ALLOWED_PATHS:?set the approved project paths}"
: "${HEPHI_VERIFICATION_FILE:?set the frozen project check configuration file}"
[ -r "$HEPHI_VERIFICATION_FILE" ] || { echo 'HEPHI verification configuration is unreadable' >&2; exit 1; }

HEPHI_ISSUE_TITLE=$("$gh_cli" api "repos/$repo/issues/$number" --jq '.title')
# The task card and frozen acceptance tests are read from the Issue body.
HEPHI_ISSUE_BODY=$("$gh_cli" api "repos/$repo/issues/$number" --jq '.body // ""')
base_ref=$("$gh_cli" api "repos/$repo" --jq '.default_branch')
base_sha=$("$gh_cli" api "repos/$repo/commits/$base_ref" --jq '.sha')
if [ ! -e "$workspace/.git" ]; then
  git -C "$HEPHI_SOURCE_REPO" fetch origin "$base_ref"
  git -C "$HEPHI_SOURCE_REPO" worktree add -b "agent/$ticket_name" "$workspace" "$base_sha"
fi

export HEPHI_ENABLED=1 HEPHI_REQUIRE_PULL_REQUEST=1 HEPHI_ISSUE_TITLE HEPHI_ISSUE_BODY
export HEPHI_REQUIRE_TASK=${HEPHI_REQUIRE_TASK:-1}
export HEPHI_BASE_REF=$base_ref HEPHI_BASE_COMMIT=$base_sha
plugin_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$plugin_dir/lib/cli.mjs" prepare
