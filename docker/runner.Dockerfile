# The agent's image (ORC-204), not the daemon's: node, git, gitleaks and claude, no gh and no daemon code.
# Build: docker build -f docker/runner.Dockerfile -t factory-runner:<version> docker
FROM node:24.22.1-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.316
# Pinned by its checksum (ORC-151): `verify` runs it on the agent's commits, in a sandbox of its own. x86-64 only, as its release is by architecture.
RUN node -e "fetch('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then((b) => require('fs').writeFileSync('/tmp/gitleaks.tgz', Buffer.from(b)))" \
 && echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
 && rm /tmp/gitleaks.tgz
# The worktree is bind-mounted under the daemon's uid, unknown to the image.
RUN git config --system --add safe.directory '*'
# HOME of whatever uid runs the container; sticky, so a run cannot remove another's files.
RUN mkdir -p /home/factory && chmod 1777 /home/factory
ENV HOME=/home/factory
# The factory install is mounted read-only at /factory/app (ORC-204): `factory-agent` is on the PATH of every run.
ENV PATH=/factory/app/bin:$PATH
WORKDIR /work
