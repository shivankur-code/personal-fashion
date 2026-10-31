# The app is bundled before the image build (pnpm --filter @stylist/api build),
# so the image needs no package install and no network access.
# Build from the repository root:  docker build -f apps/api/Dockerfile -t stylist-api .
FROM node:22-alpine
ARG GIT_SHA=dev
ENV NODE_ENV=production GIT_SHA=$GIT_SHA PORT=8080
WORKDIR /app
COPY apps/api/dist/main.js ./main.js
USER node
EXPOSE 8080
CMD ["node", "main.js"]
