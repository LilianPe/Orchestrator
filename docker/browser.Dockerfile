# The capture image of the visual proof (ORC-404): the runner's (docker/runner.Dockerfile), so that the application starts
# with the same tools as its commands, plus Playwright and its headless Chromium. Only the sandboxes that ask for a browser
# run it, at network `none`: every other sandbox stays on the runner's image, without a browser.
# Build: docker build -f docker/browser.Dockerfile --build-arg RUNNER_IMAGE=factory-runner:<version> -t factory-browser:<version> docker
# then FACTORY_BROWSER_IMAGE=factory-browser:<version>. About 630 MB on top of the runner's, uncompressed (docs/deployment.md).
ARG RUNNER_IMAGE
FROM ${RUNNER_IMAGE}
ARG PLAYWRIGHT_VERSION=1.64.1
# Out of HOME, which is the container's uid's at run time: the browser is the image's, read-only for the run.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
# The shooter loads it from the global modules (`npm root -g`, src/adapters/browser/playwright.ts). `--only-shell`: the
# headless shell alone, what `chromium.launch()` runs headless, not the full browser; `--with-deps`, its system libraries.
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*
# What `browserImage` (src/app/sandbox-wiring.ts) checks before it wires the shooter: the runner's image is no capture image.
LABEL factory.browser="playwright-${PLAYWRIGHT_VERSION}"
