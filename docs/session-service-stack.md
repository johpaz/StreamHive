# Stack del servicio de sesiones

Investigación: 2026-11-01. Implementación: 2026-11-02; despliegue y validación en `deploy/sessions/README.md` y `docs/session-service-validation.md`. Alcance: registro de instalaciones, creación de sesiones, invitaciones, espera, admisión, expulsión, señalización y recuperación del canal de control. No incluye distribución de audio/vídeo, grabación ni RTMP.

## Decisión

Crear un servicio separado, `streamhive-sessions`, usando Rust + Axum + Tokio, rusqlite + SQLite en modo WAL, una pequeña web React/TypeScript compilada con Bun y despliegue Docker Compose detrás del Traefik existente del VPS; Caddy queda como alternativa para quien no tenga proxy.

El motivo principal es la continuidad con el código: el backend actual ya usa Rust, Axum, Tokio, JWT, SHA-256 y SQLite; el frontend ya usa React/TypeScript/Vite y el despliegue existente utiliza Caddy. Esto evita introducir un lenguaje de backend distinto. No supone que una tecnología sea más rápida que otra sin medir.

## Comparación

| Alternativa | Encaje | Evaluación |
| --- | --- | --- |
| Rust + Axum + Tokio | HTTP y WebSocket, coincide con el backend actual | Opción recomendada para compartir modelos, validación y parte de la autenticación |
| TypeScript + Bun + Hono | Runtime con WebSocket y una API concisa | Viable si se prioriza TypeScript en el servicio; implica mantener otra implementación de lógica actualmente escrita en Rust |
| Go | Servicio compilado y modelo de concurrencia adecuado | Viable, pero añade un lenguaje al repositorio y aporta menos reutilización para este caso |

## Componentes

- Axum/Tokio: endpoints HTTP y conexiones WSS salientes del escritorio y navegador. Mensajes por estudio, colas acotadas, latidos, reconexión y recuperación del estado autorizado.
- rusqlite/SQLite: tablas normalizadas de instalaciones, sesiones, invitaciones y participantes, con migración versionada. Las operaciones se ejecutan mediante `spawn_blocking`, fuera del runtime asíncrono. Se reutiliza la misma biblioteca SQLite del backend local; no se mantiene un historial duradero de eventos.
- Memoria del servicio: presencia y conexiones transitorias. No escribir latidos ni conservar sockets como datos persistentes.
- Identidad: credenciales por instalación y propietario; invitaciones opacas guardadas por hash; tokens limitados a estudio, participante, rol y vencimiento. Confirmar la autorización del anfitrión antes de admitir o expulsar.
- React/TypeScript/Bun: página de nombre y espera compilada e incrustada en el ejecutable. No solicita cámara o micrófono en esta fase.
- Traefik: HTTPS y WebSocket por labels, red externa `n8n_evoapi`, puerto interno 8080 sin publicarlo al host. Caddy es una alternativa independiente.
- Docker Compose: imagen de API compilada mediante build multietapa, usuario no root, comprobaciones de salud, secretos fuera de la imagen, volumen local persistente para SQLite y copia de seguridad consistente.
- Disponibilidad: `/healthz` y `/readyz`. Los scripts de validación miden conexiones, latencia, RAM y CPU; no se incluye un servidor de métricas separado.

## Despliegue inicial

Dos contenedores si hace falta un proxy nuevo:

1. `sessions-api`: un proceso compartido para todas las instalaciones.
2. Caddy para terminación HTTPS solo si no existe Traefik. Los archivos de invitados los sirve la API. Un job adicional ejecuta la migración y termina antes del arranque.

SQLite vive en un volumen del contenedor API, no en un contenedor de base de datos separado ni en un sistema de archivos de red. El disco conserva solo metadatos de sesiones con retención acotada. El usuario guarda sus grabaciones en su PC.

Reservar inicialmente 512 MiB para API y proxy combinados como presupuesto de prueba, no como consumo medido ni capacidad certificada. Confirmar límites con carga, autenticaciones simultáneas, reinicios y conexiones lentas. Usar los 2 núcleos y la memoria disponible del VPS compartido con prudencia; no asignar un proceso o contenedor a cada instalación.

## Persistencia y escala

SQLite permite múltiples lectores y un escritor a la vez. Para este servicio de control, con pocas escrituras por sesión, es un inicio razonable en un solo VPS y una instancia de API. Limitar transacciones y evitar consultas bloqueantes en el runtime.

Pasar a PostgreSQL cuando se necesiten múltiples instancias, failover o la carga real muestre contención de escritura. Añadir Redis o un bus de mensajes si hace falta distribuir conexiones y eventos entre réplicas; no se necesita para el piloto de una sola instancia. La migración requiere revisar esquema y transacciones: no se presenta como un cambio automático de URL.

## Límites de la propuesta

El servicio implementado mantiene instalaciones y credenciales independientes. El control remoto está separado del motor de producción local. Un token aprobado no garantiza por sí mismo la conexión multimedia: WebRTC directo, TURN o LiveKit público siguen siendo una decisión y un despliegue aparte.

Se construyó y verificó una imagen local, incluyendo HTTPS/WSS a través de Traefik. No se configuró DNS, publicó la imagen ni desplegó en el VPS.

## Fuentes primarias

- Axum y Tokio: https://docs.rs/axum/latest/axum/
- WebSocket de Axum: https://docs.rs/axum/latest/axum/extract/ws/
- SQLx: https://docs.rs/sqlx/latest/sqlx/
- Usos y límites de SQLite: https://sqlite.org/whentouse.html
- SQLite WAL: https://sqlite.org/wal.html
- WebSocket de Bun: https://bun.sh/docs/runtime/http/websockets
- Hono sobre Bun: https://hono.dev/docs/getting-started/bun
- Go: https://go.dev/doc/
- Caddy HTTPS: https://caddyserver.com/docs/automatic-https
- Caddy WebSocket: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Docker Compose: https://docs.docker.com/compose/intro/compose-application-model/
