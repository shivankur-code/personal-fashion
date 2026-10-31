# Bundled before the image build (pnpm --filter @stylist/worker build).
# Default: long-running workers. Container Apps jobs append "job <name>".
# Build from the repository root:  docker build -f apps/worker/Dockerfile -t stylist-worker .
# Base image: our registry copy in builds and CI (avoids Docker Hub pull limits).
ARG BASE_IMAGE=node:22-alpine
FROM ${BASE_IMAGE}
ARG GIT_SHA=dev
ENV NODE_ENV=production GIT_SHA=$GIT_SHA
WORKDIR /app
COPY apps/worker/dist/main.js ./main.js
USER node
ENTRYPOINT ["node", "main.js"]
