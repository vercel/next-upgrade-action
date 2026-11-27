#!/usr/bin/env bash
# Live end-to-end run against a fixture consumer repository: pins the fixture's caller workflow to
# this commit, dispatches it with a real agent, checks the pull request it opens, dispatches it
# again to check the rerun reuses that pull request, and cleans up.
#
# Environment: GH_TOKEN (token with contents, workflows, actions, and pull-requests write access
# to FIXTURE), FIXTURE (owner/name), WORKFLOW_REPOSITORY (owner/name of this repository),
# WORKFLOW_SHA, NEXT_VERSION, APP_PATH, POLICY, AGENT.
#
# The fixture keeps an app with a committed npm, pnpm, or Yarn 1 lockfile at APP_PATH on its default branch,
# and the secrets NEXT_UPGRADE_PUBLISH_TOKEN and NEXT_UPGRADE_AGENT_CREDENTIAL_<AGENT>.
set -euo pipefail

workflow=next-upgrade.yml
workflow_path=".github/workflows/$workflow"
default_branch=$(gh api "repos/$FIXTURE" --jq .default_branch)

fail() {
  echo "$1" >&2
  exit 1
}

cleanup() {
  gh pr list -R "$FIXTURE" --state open --limit 100 --json number,headRefName \
    --jq '.[] | select(.headRefName | startswith("next-upgrade/")) | .number' |
    while read -r number; do
      gh pr close -R "$FIXTURE" "$number" --comment "Closed by the live end-to-end run."
    done
  gh api "repos/$FIXTURE/git/matching-refs/heads/next-upgrade/" --jq '.[].ref' |
    while read -r ref; do
      gh api -X DELETE "repos/$FIXTURE/git/${ref#refs/}" >/dev/null
    done
}

pin_workflow() {
  local agent_secret contents existing
  agent_secret="NEXT_UPGRADE_AGENT_CREDENTIAL_$(tr '[:lower:]' '[:upper:]' <<<"$AGENT")"
  contents=$(sed \
    -e "s|vercel/next-upgrade-action/|$WORKFLOW_REPOSITORY/|" \
    -e "s|__NEXT_UPGRADE_WORKFLOW_SHA__|$WORKFLOW_SHA|" \
    -e "s|__NEXT_UPGRADE_NEXT_VERSION__|\"$NEXT_VERSION\"|" \
    -e "s|__NEXT_UPGRADE_APP_PATH__|\"$APP_PATH\"|" \
    -e "s|__NEXT_UPGRADE_POLICY__|$POLICY|" \
    -e "s|__NEXT_UPGRADE_AGENT__|$AGENT|" \
    -e "s|__NEXT_UPGRADE_AUTH__|api-key|" \
    -e 's|__NEXT_UPGRADE_MODEL__|""|' \
    -e 's|__NEXT_UPGRADE_EFFORT__|""|' \
    -e "s|__NEXT_UPGRADE_TELEMETRY_DISABLED__|true|" \
    -e "s|secrets.NEXT_UPGRADE_AGENT_CREDENTIAL|secrets.$agent_secret|" \
    templates/next-upgrade.yml)
  if grep -q '__NEXT_UPGRADE_' <<<"$contents"; then
    fail "The caller template has a placeholder this run does not fill."
  fi

  existing=$(gh api "repos/$FIXTURE/contents/$workflow_path?ref=$default_branch" --jq .sha 2>/dev/null || true)
  gh api -X PUT "repos/$FIXTURE/contents/$workflow_path" \
    -f message="Pin the Next.js upgrade workflow to $WORKFLOW_SHA" \
    -f content="$(base64 <<<"$contents" | tr -d '\n')" \
    -f branch="$default_branch" \
    ${existing:+-f sha="$existing"} >/dev/null
}

dispatch_and_wait() {
  local started run_id=""
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  gh workflow run "$workflow" -R "$FIXTURE" --ref "$default_branch"
  for _ in $(seq 1 30); do
    run_id=$(gh run list -R "$FIXTURE" --workflow "$workflow" --event workflow_dispatch \
      --limit 10 --json databaseId,createdAt \
      --jq "map(select(.createdAt >= \"$started\")) | sort_by(.createdAt) | .[0].databaseId // empty")
    if [ -n "$run_id" ]; then
      break
    fi

    sleep 10
  done
  if [ -z "$run_id" ]; then
    fail "The dispatched fixture run did not appear."
  fi

  echo "Fixture run: $(gh run view -R "$FIXTURE" "$run_id" --json url --jq .url)"
  gh run watch -R "$FIXTURE" "$run_id" --interval 30 --exit-status >/dev/null
}

open_upgrade_pulls() {
  gh pr list -R "$FIXTURE" --state open --base "$default_branch" --limit 100 \
    --json number,headRefName,headRefOid,title \
    --jq '[.[] | select(.headRefName | startswith("next-upgrade/"))]'
}

trap cleanup EXIT
cleanup
pin_workflow
dispatch_and_wait

pulls=$(open_upgrade_pulls)
if [ "$(jq length <<<"$pulls")" != 1 ]; then
  fail "Expected one upgrade pull request, found: $pulls"
fi

number=$(jq -r '.[0].number' <<<"$pulls")
head=$(jq -r '.[0].headRefOid' <<<"$pulls")
target=$(jq -r '.[0].title' <<<"$pulls" | sed -n 's/^Upgrade Next\.js to \(.*\)$/\1/p')
if [ -z "$target" ]; then
  fail "Unexpected pull request title: $(jq -r '.[0].title' <<<"$pulls")"
fi

if [ "$(gh api "repos/$FIXTURE/commits/$head" --jq .commit.verification.verified)" != true ]; then
  fail "The upgrade commit $head is not verified."
fi

if gh pr view -R "$FIXTURE" "$number" --json files --jq '.files[].path' |
  grep -Eiq '(^|/)(\.github|\.gitmodules)(/|$)'; then
  fail "The upgrade pull request touches a protected path."
fi

manifest_path=$([ "$APP_PATH" = "." ] && echo package.json || echo "$APP_PATH/package.json")
required=$(gh api "repos/$FIXTURE/contents/$manifest_path?ref=$head" --jq .content |
  base64 --decode | jq -r '.dependencies.next // .devDependencies.next')
if [ "$required" != "$target" ]; then
  fail "The upgrade requires next $required instead of $target."
fi

echo "Opened #$number upgrading Next.js to $target."

dispatch_and_wait
rerun=$(open_upgrade_pulls)
if [ "$(jq -c 'map(.number)' <<<"$rerun")" != "[$number]" ]; then
  fail "The rerun did not reuse #$number: $rerun"
fi

echo "The rerun reused #$number."
