# StreamHive Sessions en tu VPS

Tu propio servidor para invitar a gente de fuera de tu red: **sala de espera, admisión, chat y cámara/audio** de los invitados. La app de escritorio solo necesita su URL HTTPS; las claves (de la app y de LiveKit) se crean solas. La emisión RTMP y las grabaciones siguen en el PC de cada estudio.

Requisitos:

1. Un VPS con Docker y un dominio o subdominio que apunte a él.
2. HTTPS en ese dominio: tu Traefik (abajo) o la variante con Caddy.
3. **Dos puertos abiertos en el firewall del VPS** para cámara y audio: `7882/udp` y `7881/tcp`. El vídeo (WebRTC) no puede pasar por el proxy HTTPS; va directo a esos puertos. Si la red de un invitado bloquea UDP, usa el TCP automáticamente.

Por ejemplo, con `ufw`: `sudo ufw allow 7882/udp && sudo ufw allow 7881/tcp`. En proveedores con firewall propio (Hetzner, AWS, Oracle…), ábrelos también en su panel.

Cuánto aguanta: cada cámara son unos 2–3 Mbps de subida al VPS y otros tantos de bajada hacia cada participante que la ve. Con 2 vCPU y 2 GB, unas 4–6 personas a 720p.

## Con tu Traefik

Todo está en un solo archivo, `compose.yaml`. En el VPS solo necesitas ese archivo y un `.env` junto a él con el subdominio, que debe apuntar al VPS:

```dotenv
SESSIONS_DOMAIN=sesiones.hiveagents.io
SESSIONS_TAG=0.2.2
```

Las etiquetas de Traefik van fijas, como en el resto de servicios del VPS: red externa `n8n_evoapi`, entrypoint `websecure`, resolver `mytlschallenge` y cabeceras HSTS. El servidor está en la red `backend` (compartida con la migración) y en `n8n_evoapi`, por la que entra Traefik. No se publica el puerto 8080 en el host: Traefik termina HTTPS y reenvía HTTP/WebSocket por la red Docker.

```bash
docker compose -f compose.yaml --env-file .env pull
docker compose -f compose.yaml --env-file .env up -d
```

Si tu Traefik usa otra red, entrypoint o resolver, cambia esos valores en las etiquetas de `compose.yaml`.

El job `sessions-migrate` prepara la base de datos y, la primera vez, las claves de LiveKit (en el volumen `media-config`, que no sale del servidor). LiveKit no es accesible desde fuera salvo por `https://tu.dominio/lk` y los puertos de vídeo; `/api/v1/meta` indica `"media": true`, los puertos y si LiveKit responde (`media_ready`). Comprueba `/healthz`, `/readyz` y `/api/v1/meta` sobre HTTPS. No incluyas una ruta adicional en la URL configurada en la app. Para cambiar de versión, edita `SESSIONS_TAG` en `.env` y repite ambos comandos.

Para construir la imagen desde este repositorio sin esperar a Docker Hub, desde la raíz:

```bash
docker compose --env-file deploy/sessions/.env \
  -f deploy/sessions/compose.yaml \
  -f deploy/sessions/compose.build.yaml up -d --build
```

## VPS sin Traefik

Configura `SESSIONS_DOMAIN` y `ACME_EMAIL`, y añade `compose.caddy.yaml`. Esa variante ocupa 80/443, requiere que estén disponibles y gestiona certificados públicos automáticamente. No la uses en un servidor que ya tiene Traefik.

```bash
docker compose --env-file deploy/sessions/.env \
  -f deploy/sessions/compose.yaml \
  -f deploy/sessions/compose.caddy.yaml up -d
```

## Vincular la app: solo URL

En **Configuración → Servidor de sesiones** introduce `https://sesiones.tudominio.com`.

- **Comprobar** verifica el servicio y protocolo sin registrar la instalación.
- **Guardar y conectar** registra la instalación automáticamente o reutiliza su credencial guardada.
- La credencial se cifra en el backend local y no se devuelve al navegador. No hay que copiar claves del `.env`.
- Crea una sesión remota y pulsa **Invitar por VPS**. El invitado escribe su nombre y queda esperando. Usa **Admitir**, **Rechazar** o **Retirar** en **Invitados del servidor**.
- La página de invitados indica expresamente que la conexión multimedia aún no está incluida. La aprobación no crea una cámara ni incorpora participantes al programa.
- Las invitaciones locales anteriores siguen disponibles y están identificadas como locales.

La URL del VPS no se considera un secreto: los invitados pueden ver el dominio. El registro automático permite crear estudios propios a quien conozca la URL, pero las credenciales impiden leer o modificar estudios ajenos. No existe un token global de administrador distribuido en la app.

Cambiar de VPS requiere finalizar la sesión remota activa. Desconectar intenta cerrarla y borra la credencial local; si el VPS no responde, la sesión remota termina por caducidad. No cambies ni pierdas la clave maestra de una instalación existente, porque protege sus credenciales guardadas.

## Persistencia y límites

- Un volumen Docker conserva SQLite en `/data/sessions.sqlite`; no hay archivos multimedia.
- Una sesión activa por instalación, con caducidad de 24 horas.
- Hasta 20 solicitudes esperando, 200 participantes históricos y 100 invitaciones por sesión.
- Las invitaciones caducan en 24 horas; revocar una retira también sus participantes.
- Las decisiones son idempotentes y persisten tras reinicios. La presencia se recalcula según los WebSockets conectados.
- Se eliminan sesiones caducadas hace más de siete días; los latidos no se escriben en SQLite.
- Límites configurables: 120 registros/hora/IP, 600 solicitudes/minuto/IP y 1.000 conexiones simultáneas por proceso. Ajustarlos tras medir carga real. Los clientes lentos tienen colas y plazos de escritura acotados.
- `TRUST_PROXY=true` en Compose solo debe utilizarse detrás del proxy confiable. El servicio usa la IP reenviada para limitar solicitudes; nunca para conceder permisos.

El contenedor principal reserva como límites máximos 384 MiB y 0,5 CPU. El migrador tiene 128 MiB. La raíz es de solo lectura y ambos ejecutan como UID/GID 1000 sin capacidades. Solo `/data` y `/tmp` son escribibles. Los logs están rotados a tres archivos de 10 MB.

## Copia y actualización

Copia consistente de SQLite, ejecutada desde `deploy/sessions` y con los mismos archivos Compose de tu despliegue:

```bash
docker compose -f compose.yaml --env-file .env exec sessions \
  streamhive-sessions backup /data/backup-20261102.sqlite
```

El destino no debe existir. Copia ese archivo fuera del VPS y aplica tu política de retención. No copies únicamente `sessions.sqlite` mientras está en uso, ignorando el WAL. Para restaurar, detén el servicio y sustituye los datos por una copia consistente con propietario 1000:1000.

Para actualizar, realiza una copia, cambia `SESSIONS_TAG` a una versión publicada y ejecuta `pull` y `up -d`. La imagen incluye el esquema y el job de migración. Evita borrar el volumen: perderlo obligará a volver a vincular las apps.

## Construcción y publicación

El Dockerfile multietapa está en `sessions/Dockerfile`: Bun compila únicamente la web de invitados; Rust compila el servidor; la imagen final no contiene compiladores ni un servidor Node.

El workflow `sessions-image.yml` construye AMD64 y ARM64. Un tag Git `sessions-v0.1.0` publica la versión `0.1.0` y un tag por commit en Docker Hub usando `DOCKERHUB_USERNAME` y `DOCKERHUB_TOKEN` de GitHub Actions. La ejecución manual no publica salvo que se seleccione `publish`. Nunca guardar esos secretos en el repositorio.

## Validación reproducible

```bash
bun scripts/build-session-guest.mjs
cargo test --workspace --locked
bun run --cwd frontend build
cargo build --workspace --locked
CHROMIUM_PATH=/ruta/a/chrome bun scripts/session-service-e2e.mjs
cargo build --release --locked -p streamhive-sessions
bun scripts/session-service-load.mjs
```

La prueba E2E inicia servicios locales con datos aislados: configuración por URL, dos navegadores de invitados, admisión/rechazo/retirada, reinicio del VPS simulado y de la app, restauración de conexión y copia consistente. No usa cámaras ni servicios externos.

Para comprobar HTTPS/WSS con Traefik en contenedores locales (requiere Podman y la imagen `localhost/streamhive-sessions:review`):

```bash
podman build --format docker -t localhost/streamhive-sessions:review -f sessions/Dockerfile .
bun scripts/session-traefik-smoke.mjs
```

Esta comprobación acepta el certificado de prueba solo en su controlador; la app conserva la validación TLS normal.

La medición local de referencia está en `docs/session-service-validation.md`. No es una certificación de capacidad del VPS ni incluye TLS; los límites de despliegue deben validarse en ese equipo antes de aumentar usuarios.
