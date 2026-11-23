#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# Merges pithings/unkernel's main into this fork's main (remote-sync.yml runs
# this in a checkout of the fork, on main). A merge commit only: nothing is
# rebased or force-pushed. When upstream has no commit the fork lacks, nothing
# changes (FORCE_RELEASE=true still reports a release of main's head). A clean
# merge is pushed to main as a fast-forward and reported as released. A
# conflict leaves main alone: the conflicted merge goes to upstream-sync/<sha7>
# and a draft pull request for that branch is opened, once.
#
# Outputs, to $GITHUB_OUTPUT when it is set: released (true or false), tag
# (remote-v<YYMMDD>-<sha7>, for the release) and sha (the commit to release).
#
#   FORCE_RELEASE=true UPSTREAM_URL=https://github.com/pithings/unkernel.git bash remote/scripts/sync-upstream.sh

set -euo pipefail

export GIT_AUTHOR_NAME="github-actions[bot]"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

upstream_url=${UPSTREAM_URL:-https://github.com/pithings/unkernel.git}
force=${FORCE_RELEASE:-false}
today=$(date -u +%y%m%d)

output() {
	echo "sync: $1=$2"
	if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$upstream_url"
git fetch --no-tags --quiet upstream '+refs/heads/main:refs/remotes/upstream/main'
git fetch --no-tags --quiet origin '+refs/heads/main:refs/remotes/origin/main'
git checkout -q -B main refs/remotes/origin/main

upstream=$(git rev-parse refs/remotes/upstream/main)
base=$(git rev-parse HEAD)
if git merge-base --is-ancestor "$upstream" "$base"; then
	echo "sync: upstream ${upstream:0:7} is in main already (main is ${base:0:7})"
	if [ "$force" = true ]; then
		output released true
		output tag "remote-v$today-${base:0:7}"
		output sha "$base"
	else
		output released false
	fi
	exit 0
fi

up7=${upstream:0:7}
branch="upstream-sync/$up7"
git checkout -q -B "$branch" "$base"
log=$(mktemp)
if git merge --no-ff --no-edit -m "remote: merge upstream pithings/unkernel main at $up7" "$upstream" >"$log" 2>&1; then
	merged=$(git rev-parse HEAD)
	git push --quiet origin "HEAD:refs/heads/main"
	echo "sync: merged upstream $up7 into main at ${merged:0:7}"
	output released true
	output tag "remote-v$today-${merged:0:7}"
	output sha "$merged"
	exit 0
fi

conflicted=$(git diff --name-only --diff-filter=U)
if [ -z "$conflicted" ]; then
	cat "$log"
	git merge --abort || true
	echo "::error::the merge of upstream $up7 failed, and not on a conflict"
	exit 1
fi

git add -A
git commit -q -m "remote: merge upstream pithings/unkernel main at $up7 (conflicts to resolve)"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
	echo "sync: $branch is on origin already"
else
	git push --quiet origin "HEAD:refs/heads/$branch"
fi

echo "::warning title=Upstream sync conflict::upstream $up7 does not merge into main cleanly; main is unchanged, see the draft pull request for $branch"
open=$(gh pr list --repo "${GITHUB_REPOSITORY:?}" --head "$branch" --state open --json number --jq 'length')
if [ "$open" = 0 ]; then
	body=$(mktemp)
	{
		echo "Upstream \`pithings/unkernel\` main is at \`$up7\`, and merging it into this fork's \`main\` conflicts."
		echo
		echo "\`main\` is unchanged. This branch holds the merge with its conflict markers. Resolve the files below on this branch, then merge the pull request into \`main\` by hand (it is never merged automatically). Once \`main\` has the merge, release it with a run of Remote sync with \`force_release\`, or start Remote release by hand with a new tag."
		echo
		echo "Conflicted files:"
		while read -r file; do echo "- \`$file\`"; done <<< "$conflicted"
	} > "$body"
	if ! gh pr create --repo "$GITHUB_REPOSITORY" --draft --base main --head "$branch" \
		--title "remote: resolve the upstream sync at $up7" --body-file "$body"; then
		echo "::warning::could not open the pull request for $branch (enable \"Allow GitHub Actions to create and approve pull requests\")"
	fi
else
	echo "sync: the pull request for $branch is open already"
fi
output released false
