# Two images from one file:
#   docker build --target server -t pizza-server .   (API, worker, simulator: different start command)
#   docker build --target web    -t pizza-web .      (static UI + /api proxy)

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

FROM deps AS build-server
COPY server server
RUN npm run build -w server

FROM deps AS build-web
COPY web web
RUN npm run build -w web

# The Temporal worker includes a native library that requires glibc (no Alpine).
FROM node:22-bookworm-slim AS server
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build-server /app/server/dist server/dist
COPY server/migrations server/migrations
USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "dist/api/main.js"]

FROM nginxinc/nginx-unprivileged:1.27-alpine AS web
ENV API_UPSTREAM=api:3000
COPY deploy/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build-web /app/web/dist /usr/share/nginx/html
EXPOSE 8080
