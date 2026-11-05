#!/bin/sh
# Container entrypoint: lets git push over HTTPS with GH_TOKEN, then runs the command (factory up by default).
set -e
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git
fi
if [ -z "$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN$CLAUDE_TOKEN_1$CLAUDE_TOKEN_2" ]; then
  echo "Attention : aucune authentification de Claude Code (ANTHROPIC_API_KEY, CLAUDE_TOKEN_1...) : les runs échoueront." >&2
fi
exec "$@"
