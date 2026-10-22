FROM node:24-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl gnupg bash \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
# Default commit identity, email here and name after the build (GIT_AUTHOR_* / GIT_COMMITTER_* env vars override it); repos are bind-mounted, possibly with another owner.
RUN git config --system user.email "factory@localhost" \
 && git config --system --add safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
# The commit name is the product name, read from the built source so it is written in one place only.
RUN git config --system user.name "$(node -p "require('./dist/src/product.js').PRODUCT_NAME")"
COPY docker/entrypoint.sh /usr/local/bin/factory-entrypoint
RUN chmod 0755 /usr/local/bin/factory-entrypoint \
 && mkdir -p /data /repos \
 && chown node:node /data /repos
ENV FACTORY_HOME=/data NODE_ENV=production
USER node
EXPOSE 4100
ENTRYPOINT ["/usr/local/bin/factory-entrypoint"]
CMD ["node", "dist/src/cli/factory.js", "up"]
