FROM node:22-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/agentpay-core/ packages/agentpay-core/
COPY packages/agentpay-verifier/ packages/agentpay-verifier/
COPY packages/agentpay-facilitator/ packages/agentpay-facilitator/
COPY packages/agentpay-scorer/ packages/agentpay-scorer/
COPY packages/agentpay-keeper/ packages/agentpay-keeper/
RUN pnpm install --frozen-lockfile --filter @agentpay/verifier... --filter @agentpay/facilitator... --filter @agentpay/scorer... --filter @agentpay/keeper...
RUN pnpm --filter @agentpay/verifier... --filter @agentpay/facilitator... --filter @agentpay/scorer... --filter @agentpay/keeper... build
RUN pnpm --filter @agentpay/verifier deploy --legacy --prod /out/verifier && \
    pnpm --filter @agentpay/facilitator deploy --legacy --prod /out/facilitator && \
    pnpm --filter @agentpay/scorer deploy --legacy --prod /out/scorer && \
    pnpm --filter @agentpay/keeper deploy --legacy --prod /out/keeper
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /services
COPY --from=build --chown=node:node /out/ ./
RUN mkdir /data && chown node:node /data
USER node
CMD ["node", "verifier/dist/index.js"]
