FROM oven/bun:1.4.3 AS build
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile
COPY frontend ./
COPY scripts /app/scripts
RUN bun run sdk && bun run effects && bun run build
FROM caddy:2.10.2-alpine
COPY --from=build /app/frontend/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80 443 8081
