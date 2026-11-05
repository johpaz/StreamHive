#!/usr/bin/env bash
# StreamHive (modo escritorio, Linux): arranca LiveKit + backend con el motor ffmpeg, todo en localhost.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
DATA="${STREAMHIVE_DATA:-${XDG_DATA_HOME:-$HOME/.local/share}/streamhive}"
REC="${STREAMHIVE_RECORDINGS:-$HOME/Videos/StreamHive}"
API="${STREAMHIVE_PORT:-8780}"; LK="${STREAMHIVE_LK_PORT:-7880}"
FFMPEG_BIN="${FFMPEG_BIN:-$(command -v ffmpeg || true)}"
[ -x "$HERE/bin/ffmpeg" ] && FFMPEG_BIN="$HERE/bin/ffmpeg"
[ -n "$FFMPEG_BIN" ] || { echo "Falta ffmpeg (instálalo o colócalo en bin/ffmpeg)" >&2; exit 1; }
mkdir -p "$DATA" "$REC"; umask 077
rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ ! -f "$DATA/secrets.env" ]; then
  { echo "ADMIN_PASSWORD=$(rnd 10)"; echo "SESSION_SECRET=$(rnd 32)"
    echo "MASTER_KEY=$(head -c 32 /dev/urandom | base64)"
    echo "LIVEKIT_API_KEY=sh$(rnd 6)"; echo "LIVEKIT_API_SECRET=$(rnd 32)"; } > "$DATA/secrets.env"
  echo "Primer inicio. Contraseña de administrador: $(grep ^ADMIN_PASSWORD "$DATA/secrets.env" | cut -d= -f2)"
fi
set -a; . "$DATA/secrets.env"; set +a
cat > "$DATA/livekit.yaml" <<YAML
port: $LK
rtc:
  tcp_port: $((LK+1))
  udp_port: $((LK+2))
  use_external_ip: false
keys:
  $LIVEKIT_API_KEY: $LIVEKIT_API_SECRET
YAML
"$HERE/bin/livekit-server" --config "$DATA/livekit.yaml" --node-ip 127.0.0.1 >"$DATA/livekit.log" 2>&1 & LKPID=$!
trap 'kill $LKPID ${BEPID:-} 2>/dev/null || true' EXIT INT TERM
ENGINE=ffmpeg FFMPEG_BIN="$FFMPEG_BIN" DATA_DIR="$DATA" RECORDINGS_DIR="$REC" \
LISTEN_ADDR="127.0.0.1:$API" STATIC_DIR="$HERE/web" PUBLIC_ORIGIN="http://localhost:$API" \
RENDERER_URL="http://localhost:$API/render" LIVEKIT_INTERNAL_URL="http://127.0.0.1:$LK" \
LIVEKIT_PUBLIC_URL="ws://localhost:$LK" "$HERE/bin/streamhive" & BEPID=$!
for _ in $(seq 100); do curl -fs "http://127.0.0.1:$API/healthz" >/dev/null 2>&1 && break; sleep 0.1; done
echo "StreamHive en http://localhost:$API  (Ctrl+C para salir; mantén esa pestaña abierta durante el directo)"
[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null && xdg-open "http://localhost:$API" >/dev/null 2>&1 || true
wait $BEPID
