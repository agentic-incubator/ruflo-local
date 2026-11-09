# route-gateway — glibc Node 24 image so @ruvector/rvf and @ruvector/ruvllm resolve their
# prebuilt linux-{x64,arm64}-gnu native bindings (node:*-alpine is musl and has none).
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9

WORKDIR /app

# Install first, from the manifests alone, so dependency layers cache across code-only changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY config/routing ./config/routing

ENV GATEWAY_PORT=4000
EXPOSE 4000

CMD ["node", "scripts/gateway-server.mjs"]
