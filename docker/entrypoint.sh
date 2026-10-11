#!/bin/sh
# Container entrypoint: lets git push over HTTPS with GH_TOKEN, then runs the command (relais up by default).
set -e
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git
fi
exec "$@"
