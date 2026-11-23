# The agent's image (ORC-204), not the daemon's: node (pnpm), python (uv), git, gitleaks, semgrep, crapper and dryer, and claude, no gh and no daemon code.
# Build: docker build -f docker/runner.Dockerfile -t factory-runner:<version> docker (BuildKit, or Podman: RUN --mount)
FROM node:24.22.1-bookworm-slim
# python3 from the distribution: a runner has no route to download one (`uv python install` would need GitHub's CDN).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.316 pnpm@10.20.0
RUN pip3 install --break-system-packages --no-cache-dir uv==0.13.7
# Pinned (ORC-333): `verify` runs it on the lines a branch adds, in a sandbox without network, with the factory's rules below.
# A tool of its own on the distribution's python, apart from the packages a run installs. About 330 MB.
RUN UV_TOOL_DIR=/opt/semgrep UV_TOOL_BIN_DIR=/usr/local/bin UV_PYTHON_DOWNLOADS=never uv tool install --no-cache semgrep==1.182.1
COPY semgrep /usr/local/share/factory/semgrep
# Pinned (ORC-280): `factory/qualité-diff`, a measure, runs crapper and dryer (0BSD, no release: their repositories at a commit)
# on the files a branch changes, in a sandbox without network. One tool environment for both, tree-sitter pinned. Their grammars
# are fetched here, never at run time, into a fixed dir, each checked by its sha256: the network serves the build only.
ENV TREE_SITTER_LANGUAGE_PACK_CACHE_DIR=/opt/quality/grammars
RUN UV_TOOL_DIR=/opt/quality UV_TOOL_BIN_DIR=/opt/quality/bin UV_PYTHON_DOWNLOADS=never uv tool install --no-cache \
      --with git+https://github.com/unclebob/dryer@66ff6d21a42c04afcad89c78a80066176d1294b0 \
      --with tree-sitter==0.27.0 --with tree-sitter-language-pack==1.25.2 \
      git+https://github.com/unclebob/crapper@c757ec79a6c15dc815238bbd9c2f4601eb54d3cc \
 && /opt/quality/crapper/bin/python -I -c "import tree_sitter_language_pack as t; t.download(['typescript', 'tsx', 'javascript', 'python'])" \
 && cd /opt/quality/grammars/tree-sitter-language-pack/v1.25.2 \
 && rm -rf bundles .download.lock \
 && printf '%s  %s\n' \
      e14f485dcb2c126d245b478d7e98f00a64eacbd0cb58800b0dd077af681acf47 libs/libtree_sitter_typescript.so \
      9a30cced320347e037bd3436d29c3afd99665d271f263e4b50057c6baf9b3463 libs/libtree_sitter_tsx.so \
      f84a9be398f93b38f779579cd71b33edaa6df4f7dd415f929f9b156e26582fbe libs/libtree_sitter_javascript_orchard.so \
      fa6228f600a193d6ca4ffc1cd2146c04ea5007342c8702992d169304106ad48f libs/libtree_sitter_python.so \
    | sha256sum -c - \
 && [ "$(ls libs | wc -l)" = 4 ] \
 && chmod -R a+rX /opt/quality
COPY quality /usr/local/share/factory/quality
# Pinned by its checksum (ORC-151): `verify` runs it on the agent's commits, in a sandbox of its own. x86-64 only, as its release is by architecture.
# The archive comes from the build context when it is there (CI caches it, ORC-369), from GitHub's releases otherwise.
RUN --mount=type=bind,target=/context \
    cp /context/gitleaks_8.30.1_linux_x64.tar.gz /tmp/gitleaks.tgz 2>/dev/null \
 || node -e "fetch('https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz').then((r) => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); }).then((b) => require('fs').writeFileSync('/tmp/gitleaks.tgz', Buffer.from(b)))" \
 && echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tgz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks \
 && rm /tmp/gitleaks.tgz
# The worktree is bind-mounted under the daemon's uid, unknown to the image.
RUN git config --system --add safe.directory '*'
# HOME of whatever uid runs the container; sticky, so a run cannot remove another's files.
RUN mkdir -p /home/factory && chmod 1777 /home/factory
ENV HOME=/home/factory
WORKDIR /work
