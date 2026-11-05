#!/bin/sh
# Container entrypoint: lets the daemon's git read over HTTPS with GH_TOKEN, then runs the command (factory up by default).
set -e
# Whoever holds this engine's socket holds what the engine holds: on a rootful engine, root on the host.
if [ -n "$FACTORY_CONTAINER_CLI" ] && [ "$FACTORY_ALLOW_ROOTFUL_ENGINE" != "1" ]; then
  options="$("$FACTORY_CONTAINER_CLI" info --format '{{.SecurityOptions}}')" || {
    echo "Moteur injoignable par $FACTORY_CONTAINER_CLI : vérifiez FACTORY_ENGINE_SOCKET et ses droits." >&2
    exit 1
  }
  case " $(printf '%s' "$options" | tr -d '[]') " in
    *" name=rootless "*) ;;
    *)
      echo "Moteur non rootless ($options) : son socket donnerait root sur l'hôte. Sur un poste de développement seulement : FACTORY_ALLOW_ROOTFUL_ENGINE=1." >&2
      exit 1
      ;;
  esac
fi
# The engine resolves a runner's mounts on the host, where the image's files are not: the install goes where it sees them.
if [ -n "$FACTORY_INSTALL_DIR" ]; then
  target="$FACTORY_INSTALL_DIR/$(cat .install-id)"
  if [ ! -d "$target" ]; then
    rm -rf "$target.tmp"
    mkdir -p "$target.tmp"
    cp -a . "$target.tmp/"
    mv "$target.tmp" "$target"
  fi
  cd "$target"
fi
if [ -n "$GH_TOKEN" ]; then
  gh auth setup-git
fi
if [ -z "$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN$CLAUDE_TOKEN_1$CLAUDE_TOKEN_2" ]; then
  echo "Attention : aucune authentification de Claude Code (ANTHROPIC_API_KEY, CLAUDE_TOKEN_1...) : les runs échoueront." >&2
fi
exec "$@"
