# SIGILFALL multiplayer server (Colyseus). Build from the repository root:
#   docker build -t sigilfall-server . && docker run -p 2567:2567 sigilfall-server
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/recognizer ./packages/recognizer
COPY packages/sim ./packages/sim
COPY packages/server ./packages/server
RUN npm ci --workspace @sigilfall/server --include-workspace-root
ENV PORT=2567
EXPOSE 2567
CMD ["npx", "tsx", "packages/server/src/index.ts"]
