FROM docker.io/oven/bun:1.4.3 AS guest
WORKDIR /app
COPY frontend/package.json frontend/bun.lock ./frontend/
RUN cd frontend && bun install --frozen-lockfile
COPY frontend/src frontend/src
COPY scripts/build-session-guest.mjs scripts/vendor-sdk.mjs scripts/scope-css.mjs scripts/vendor-effects.mjs scripts/
# El mismo paquete que en desarrollo: guest.js, el CSS del chat y el del estudio.
RUN bun scripts/build-session-guest.mjs
# Efectos de cámara del invitado: versiones fijadas y verificadas (integridad y suma del modelo).
RUN bun scripts/vendor-effects.mjs

FROM docker.io/library/rust:1.96-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY backend backend
COPY sessions sessions
COPY --from=guest /app/sessions/web/guest.js /app/sessions/web/chat.css /app/sessions/web/studio.css /app/sessions/web/livekit-client.umd.js sessions/web/
RUN cargo build --release --locked -p streamhive-sessions

FROM docker.io/library/debian:bookworm-slim
RUN useradd --uid 1000 --create-home sessions && mkdir -p /data /media && chown 1000:1000 /data /media
COPY --from=build /app/target/release/streamhive-sessions /usr/local/bin/streamhive-sessions
COPY --from=guest /app/frontend/public/effects /usr/share/streamhive-sessions/effects
COPY frontend/public/backgrounds /usr/share/streamhive-sessions/backgrounds
COPY frontend/public/branding/streamhive-mark.svg /usr/share/streamhive-sessions/branding/
USER 1000:1000
ENV DATA_DIR=/data LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=5 CMD ["streamhive-sessions", "healthcheck"]
ENTRYPOINT ["streamhive-sessions"]
