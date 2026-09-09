FROM node:20-alpine AS builder
WORKDIR /app/vault-core
COPY vault-core/package*.json vault-core/tsconfig.*.json ./
COPY vault-core/scripts ./scripts
COPY vault-core/src ./src
COPY vault-core/consensus.json ./consensus.json
COPY contracts/src/HaloVault.sol /app/contracts/src/HaloVault.sol
RUN npm ci --silent

WORKDIR /app/sdk
COPY sdk/package*.json sdk/tsconfig.json ./
COPY sdk/src ./src
RUN npm ci --silent
RUN npm run build

WORKDIR /app/cli
# Container builds have no Git metadata, so pass the release tag through to the
# version generator. The release workflow supplies this build argument.
ARG HALO_CLI_VERSION=""
ENV HALO_CLI_VERSION=$HALO_CLI_VERSION
COPY cli/package*.json cli/tsconfig.json ./
RUN npm ci --silent
COPY cli/scripts ./scripts
COPY cli/src ./src
RUN npm run build

FROM node:20-alpine AS runner
ENV NODE_ENV=production
# Non-root user (uid/gid 10001) — keeps the CLI image consistent with the
# backend services. No HEALTHCHECK: the CLI has no HTTP endpoint.
RUN addgroup -g 10001 -S appuser \
 && adduser  -S -u 10001 -G appuser appuser
WORKDIR /app/vault-core
COPY vault-core/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --silent
COPY --from=builder /app/vault-core/dist ./dist
WORKDIR /app/sdk
COPY sdk/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --silent
COPY --from=builder /app/sdk/dist ./dist
WORKDIR /app/cli
COPY cli/package*.json ./
# --ignore-scripts: no transitive dep can run a lifecycle hook in the runner image.
RUN npm ci --omit=dev --ignore-scripts --silent
COPY --from=builder /app/cli/dist ./dist
RUN chown -R 10001:10001 /app
USER appuser
ENTRYPOINT ["node", "dist/index.js"]
