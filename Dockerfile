# Image for the Grok frontend-testing bot (README.md). Built from this folder
# only: nothing of the repository is copied into it.
FROM node:24-bookworm

ARG PLAYWRIGHT_VERSION
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1

# Chromium and its system libraries, at the Playwright version the tests use.
RUN test -n "$PLAYWRIGHT_VERSION" \
 && npx -y "playwright@${PLAYWRIGHT_VERSION}" install --with-deps chromium \
 && chmod -R a+rX /ms-playwright \
 && rm -rf /root/.npm /var/lib/apt/lists/*

USER node
WORKDIR /home/node

# Grok Build (xAI) for this user only. The caches are created here so the
# named volumes mounted over them start out owned by this user.
RUN curl -fsSL https://x.ai/cli/install.sh | GROK_BIN_DIR=/home/node/.grok/bin bash \
 && mkdir -p /home/node/.pnpm-store /home/node/.cache/node/corepack
ENV PATH=/home/node/.grok/bin:$PATH
