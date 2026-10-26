# route-gateway — glibc Node 24 image so @ruvector/rvf and @ruvector/ruvllm resolve their
# prebuilt linux-{x64,arm64}-gnu native bindings (node:*-alpine is musl and has none).
FROM node:24-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app

# Install first, from the manifests alone, so dependency layers cache across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY config/routing ./config/routing

ENV GATEWAY_PORT=4000
EXPOSE 4000

CMD ["node", "scripts/gateway-server.mjs"]
