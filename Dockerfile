FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg bash \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
# Default commit identity (GIT_AUTHOR_* / GIT_COMMITTER_* env vars override it); repos are bind-mounted, possibly with another owner.
RUN git config --system user.name "Relais" \
 && git config --system user.email "relais@localhost" \
 && git config --system --add safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
COPY docker/entrypoint.sh /usr/local/bin/relais-entrypoint
RUN chmod 0755 /usr/local/bin/relais-entrypoint \
 && mkdir -p /data /repos \
 && chown node:node /data /repos
ENV RELAIS_HOME=/data NODE_ENV=production
USER node
EXPOSE 4100
ENTRYPOINT ["/usr/local/bin/relais-entrypoint"]
CMD ["node", "dist/src/cli/relais.js", "up"]
