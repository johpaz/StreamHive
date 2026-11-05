FROM docker.io/oven/bun:1.4.3 AS guest
WORKDIR /app
COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile
COPY frontend/src/SessionGuest.tsx frontend/src/SessionGuest.tsx
RUN bun build frontend/src/SessionGuest.tsx --target browser --minify --define 'process.env.NODE_ENV="production"' --outfile /guest.js

FROM docker.io/library/rust:1.96-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY backend backend
COPY sessions sessions
COPY --from=guest /guest.js sessions/web/guest.js
RUN cargo build --release --locked -p streamhive-sessions

FROM docker.io/library/debian:bookworm-slim
RUN useradd --uid 1000 --create-home sessions && mkdir /data && chown 1000:1000 /data
COPY --from=build /app/target/release/streamhive-sessions /usr/local/bin/streamhive-sessions
USER 1000:1000
ENV DATA_DIR=/data LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 CMD ["streamhive-sessions", "healthcheck"]
ENTRYPOINT ["streamhive-sessions"]
