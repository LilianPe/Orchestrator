# The agent's image (ORC-204), not the daemon's: node, git and claude, no gh and no daemon code.
# Build: docker build -f docker/runner.Dockerfile -t factory-runner:<version> docker
FROM node:24.22.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
# The worktree is bind-mounted under the daemon's uid, unknown to the image.
RUN git config --system --add safe.directory '*'
# HOME of whatever uid runs the container; sticky, so a run cannot remove another's files.
RUN mkdir -p /home/factory && chmod 1777 /home/factory
ENV HOME=/home/factory
WORKDIR /work
