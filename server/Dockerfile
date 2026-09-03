# Optional Docker image for VPS / homelab — not required for LAN.
FROM rust:1.85-bookworm AS build
WORKDIR /app
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/target/release/multiplayer-server /usr/local/bin/multiplayer-server
RUN mkdir -p /app/logs
ENV MULTIPLAYER_BIND=0.0.0.0:7777
ENV MULTIPLAYER_LOG_DIR=/app/logs
EXPOSE 7777
CMD ["multiplayer-server"]
