FROM node:24.22.1-bookworm-slim
# The engine's CLI to create the runners (ORC-203); not the GitHub CLI: the daemon reads and publishes by its GitHub App alone (ORC-181).
ARG DOCKER_CLI_VERSION=29.9.3
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl bash \
 && rm -rf /var/lib/apt/lists/*
RUN arch="$(uname -m)" \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" | tar -xz -C /usr/local/bin --strip-components=1 docker/docker
# Repos are bind-mounted, possibly with another owner.
RUN git config --system --add safe.directory '*'
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev
# Default commit identity (GIT_AUTHOR_* / GIT_COMMITTER_* env vars override it); the name is the product name, read from the built source.
RUN name="$(node -e "const n = require('./dist/src/product.js').PRODUCT_NAME; if (typeof n !== 'string' || !n) process.exit(1); process.stdout.write(n)")" \
 && git config --system user.name "$name" \
 && git config --system user.email "factory@localhost"
# What the entrypoint copies where the engine sees it, named by what runs (the lockfile for node_modules): a change to it, a new copy.
RUN find dist bin packs drizzle web/dist package.json package-lock.json -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 > .install-id
COPY docker/entrypoint.sh /usr/local/bin/factory-entrypoint
RUN chmod 0755 /usr/local/bin/factory-entrypoint \
 && mkdir -p /data /repos \
 && chown node:node /data /repos
# The build's commit, on each attempt's labels (ORC-226): empty when the build was not given it.
ARG FACTORY_COMMIT=
ENV FACTORY_HOME=/data NODE_ENV=production FACTORY_COMMIT=$FACTORY_COMMIT
USER node
EXPOSE 4100
ENTRYPOINT ["/usr/local/bin/factory-entrypoint"]
CMD ["node", "dist/src/cli/factory.js", "up"]
