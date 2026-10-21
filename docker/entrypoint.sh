#!/bin/sh
# Container entrypoint: lets git push over HTTPS with GH_TOKEN, then runs the command (factory up by default).
set -e
# compose passes an unset GIT_*_NAME as empty: drop it so the image identity (the product name) applies.
[ -n "$GIT_AUTHOR_NAME" ] || unset GIT_AUTHOR_NAME
[ -n "$GIT_COMMITTER_NAME" ] || unset GIT_COMMITTER_NAME
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git
fi
exec "$@"
