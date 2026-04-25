FROM node:22-slim

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY agent ./agent

RUN corepack enable && pnpm install --frozen-lockfile \
    && pnpm --filter @web-app-gen/contracts build \
    && pnpm --filter @web-app-gen/agent build

# Skills must be at /app/skills for the Copilot SDK runner
RUN cp -r agent/skills /app/skills

WORKDIR /app/agent
ENV PORT=8088
EXPOSE 8088
CMD ["node", "dist/server.js"]
