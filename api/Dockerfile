FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9 --activate

FROM base AS deps
WORKDIR /app
COPY api/package.json ./package.json
RUN pnpm install --node-linker=hoisted

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY api/ .
RUN pnpm build

FROM base AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY api/package.json ./package.json
EXPOSE 4000
CMD ["node", "dist/main"]
