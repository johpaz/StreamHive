FROM rust:1.96-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY backend backend
COPY docs docs
RUN cargo build --release --locked -p streamhive
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/* && useradd --uid 1000 --create-home streamhive && mkdir /data /recordings && chown 1000:1000 /data /recordings
COPY --from=build /app/target/release/streamhive /usr/local/bin/streamhive
USER 1000:1000
ENV DATA_DIR=/data RECORDINGS_DIR=/recordings LISTEN_ADDR=0.0.0.0:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["streamhive"]
