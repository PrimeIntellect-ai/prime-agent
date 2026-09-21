#!/bin/sh
# Pre-push guard against mirror-like pushes and remote branch deletions.
# Provenance: a 2026-09-17 mirror push deleted 62 remote branches and auto-closed 63 PRs.
# Git invokes the pre-push hook for every push, whatever process calls it, and
# kernel command guards cannot see pushes made through raw subprocesses.
#
# Rules for real GitHub remotes, reading the ref list from stdin: allow if
# stdin is empty (up-to-date push) or if every line updates a refs/heads/* or
# refs/tags/* ref, no line deletes a ref (first field "(delete)"), and at most
# 10 refs change (mirror signature; mirror pushes also create refs/remotes/*
# on the remote, which normal pushes never do). Malformed lines fail closed.
# Any other remote URL (relative or absolute paths, file://, other hosts) is a
# local or scratch remote and is always allowed.
#
# A real remote is github.com or ssh.github.com, as an scp-style form (with or
# without the git@ user) or an http://, https://, or ssh:// URL, optionally
# carrying credentials and a port, so https://<token>@github.com/o/r.git,
# https://github.com:443/o/r.git, ssh://git@github.com:22/o/r.git,
# http://github.com/ (redirects to https), www.github.com, and trailing-dot
# hosts (github.com.) all match; git follows each of these to the same origin.
# Known fail-open residuals: ssh aliases (git@gh:owner/repo.git), insteadOf
# rewrites to a proxy, uppercase hostnames, and deletions of remote-only refs
# by --mirror pruning (git never lists those on stdin; clone-shaped mirror
# pushes still trip the refs/remotes rule).
#
# Escape hatch for an intentional push (allows mirrors, deletions, and large
# ref updates on real remotes):
#   PRIME_AGENT_ALLOW_MIRROR_PUSH=1 git push <remote> ...
#
# Installed by husky via .husky/pre-push (active after `npm ci`). Clones and
# worktrees without husky's .husky/_ shims activate the tracked hooks directly:
#   git config core.hooksPath .husky

set -f

remote=$1
url=$2

case $PRIME_AGENT_ALLOW_MIRROR_PUSH in
1)
	exit 0
	;;
esac

real=0
case $url in
git@github.com:* | git@ssh.github.com:* | github.com:* | ssh.github.com:* | \
git@github.com.:* | git@ssh.github.com.:* | github.com.:* | ssh.github.com.:*)
	real=1
	;;
http://* | https://* | ssh://*)
	rest=${url#*://}
	case $rest in
	*@*) rest=${rest#*@} ;; esac
	case $rest in
	github.com/* | github.com:* | ssh.github.com/* | ssh.github.com:* | \
	github.com./* | github.com.:* | ssh.github.com./* | ssh.github.com.:* | \
	www.github.com/* | www.github.com:* | www.github.com./* | www.github.com.:*)
		real=1
		;;
	esac
	;;
esac
if [ "$real" -ne 1 ]; then
	exit 0
fi

max_refs=10
refs=0
deletions=0
outside=0
malformed=0

while IFS= read -r line || [ -n "$line" ]; do
	set -- $line
	if [ $# -eq 0 ]; then
		continue
	fi
	refs=$((refs + 1))
	if [ $# -ne 4 ]; then
		malformed=1
		break
	fi
	case $3 in
	refs/heads/* | refs/tags/*) ;;
	refs/*)
		outside=$((outside + 1))
		;;
	*)
		malformed=1
		break
		;;
	esac
	if [ "$1" = "(delete)" ]; then
		deletions=$((deletions + 1))
	fi
done

if [ "$malformed" -eq 1 ]; then
	detail="malformed ref line (expected: <local ref> <local oid> <remote ref> <remote oid>)"
elif [ "$refs" -gt "$max_refs" ] || [ "$deletions" -gt 0 ] || [ "$outside" -gt 0 ]; then
	detail="$refs refs (mirror-like), including $deletions deletion(s) and $outside ref(s) outside refs/heads + refs/tags"
else
	exit 0
fi

{
	echo "pre-push guard: refusing push to $url: $detail"
	echo "Allowed on real GitHub remotes: updates of refs/heads and refs/tags only, no deletions, at most $max_refs refs."
	echo "Mirror pushes copy refs/remotes/* onto the remote; normal pushes never target them."
	echo "To push anyway: PRIME_AGENT_ALLOW_MIRROR_PUSH=1 git push $remote ..."
} >&2
exit 1
