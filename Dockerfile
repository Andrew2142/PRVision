# PRVision in Docker. Two targets:
#   app  API and worker on Playwright's image, which ships the Chromium the renderer drives.
#   web  The built UI, served by nginx on 4210.
# The Playwright tag must match the playwright version in backend/package-lock.json.

FROM node:22-bookworm-slim AS web-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npx ng build --configuration production

FROM nginx:1.27-alpine AS web
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
COPY docker/nginx-main.conf /etc/nginx/nginx.conf
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=0755 docker/web-ready.sh /docker-entrypoint.d/99-prvision-ready.sh
COPY --from=web-build /src/frontend/dist/frontend/browser /usr/share/nginx/html
EXPOSE 4210

FROM mcr.microsoft.com/playwright:v1.63.0-noble AS app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git tini \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
WORKDIR /app/backend
# backend's postinstall links tests/node_modules for the test suite; give it its script and folder.
COPY scripts/link-test-modules.mjs /app/scripts/
RUN mkdir -p /app/tests
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build
COPY docker/entrypoint.sh /usr/local/bin/prvision-entrypoint
RUN chmod 0755 /usr/local/bin/prvision-entrypoint
ENV NODE_ENV=production \
    PRVISION_CONTAINER=1 \
    HOST=0.0.0.0 \
    PORT=3100 \
    HOME=/tmp \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false
EXPOSE 3100
ENTRYPOINT ["tini", "--", "prvision-entrypoint"]
CMD ["node", "dist/app.js"]
