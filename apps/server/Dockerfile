# Build from the repository root:
# docker build -f apps/server/Dockerfile -t web-claude-code-server .
FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/package.json
COPY apps/server/package.json apps/server/package.json

RUN npm install --workspaces --include-workspace-root

COPY packages/core packages/core
COPY apps/server apps/server
COPY tsconfig.base.json tsconfig.base.json

EXPOSE 8787

CMD ["npm", "run", "start", "-w", "apps/server"]
