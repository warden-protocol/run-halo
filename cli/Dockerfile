# Build context is the REPO ROOT (not cli/): the CLI bundles the local
# @halo/vault-core and halo-sdk workspace packages, so they must be present.
#   docker build -f cli/Dockerfile -t halo-cli .
FROM node:20-alpine AS builder

# vault-core — regenerates + type-checks the EIP-712 consensus constants. The
# generator reads contracts/src/HaloVault.sol (address comes from consensus.json),
# so the contract source is copied in as a build input.
WORKDIR /app/vault-core
COPY vault-core/package*.json vault-core/tsconfig.*.json ./
COPY vault-core/scripts ./scripts
COPY vault-core/src ./src
COPY vault-core/consensus.json ./consensus.json
COPY contracts/src/HaloVault.sol /app/contracts/src/HaloVault.sol
RUN npm ci --silent
RUN npm run build

# sdk — depends on @halo/vault-core.
WORKDIR /app/sdk
COPY sdk/package*.json sdk/tsconfig.json ./
COPY sdk/src ./src
RUN npm ci --silent
RUN npm run build

# cli — esbuild bundles @halo/vault-core + halo-sdk into a self-contained
# dist/index.js, so the runner needs neither package at runtime.
WORKDIR /app/cli
COPY cli/package*.json cli/tsconfig.json ./
RUN npm ci --silent
COPY cli/src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Non-root user (uid/gid 10001) — keeps the CLI image consistent with the
# backend services. No HEALTHCHECK: the CLI has no HTTP endpoint.
RUN addgroup -g 10001 -S appuser \
 && adduser  -S -u 10001 -G appuser appuser
COPY cli/package*.json ./
# --ignore-scripts: no transitive dep can run a lifecycle hook in the runner image.
# --omit=dev drops @halo/vault-core + halo-sdk (they are bundled into dist).
RUN npm ci --omit=dev --ignore-scripts --silent
COPY --from=builder /app/cli/dist ./dist
RUN chown -R 10001:10001 /app
USER appuser
ENTRYPOINT ["node", "dist/index.js"]
