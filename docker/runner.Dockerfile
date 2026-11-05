# The agent's image (ORC-204), not the daemon's: node (pnpm), python (uv), git and claude, no gh and no daemon code.
# Build: docker build -f docker/runner.Dockerfile -t factory-runner:<version> docker
FROM node:24.22.1-bookworm-slim
# python3 from the distribution: a runner has no route to download one (`uv python install` would need GitHub's CDN).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.316 pnpm@10.20.0
RUN pip3 install --break-system-packages --no-cache-dir uv==0.13.7
# The worktree is bind-mounted under the daemon's uid, unknown to the image.
RUN git config --system --add safe.directory '*'
# HOME of whatever uid runs the container; sticky, so a run cannot remove another's files.
RUN mkdir -p /home/factory && chmod 1777 /home/factory
ENV HOME=/home/factory
# The factory install is mounted read-only at /factory/app (ORC-204): `factory-agent` is on the PATH of every run.
ENV PATH=/factory/app/bin:$PATH
WORKDIR /work
