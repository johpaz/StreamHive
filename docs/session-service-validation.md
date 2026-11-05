# Validación del servicio de sesiones

Fecha: 2026-11-02. Servicios y navegadores aislados; no se desplegó nada en el VPS ni se modificó DNS.

## Pruebas funcionales

- Tests de API: aislamiento entre instalaciones; ausencia de credenciales en vistas; admisión y retirada; revocación y caducidad; límite de espera; creación concurrente idempotente; rechazo de orígenes ajenos y registros excesivos.
- Integración con el backend local: comprobar URL no registra; guardar registra una vez; guardado repetido reutiliza credenciales; secretos cifrados; acceso solo de administrador; URL inválida o protocolo incompatible no sustituyen datos válidos.
- Chromium real, dos invitados: configuración con un único campo URL, espera, aprobación/rechazo, restauración al recargar, reinicio del servicio y del backend local sin registrar otra instalación, retirada, fin de sesión y copia SQLite. Directorio de evidencia de la ejecución local: `/tmp/sh-sessions-e2e-gvOxc1`.
- Imagen Docker multietapa construida con Podman: `localhost/streamhive-sessions:review`.
- Migración y arranque comprobados en la imagen con usuario 1000:1000, raíz de solo lectura, capacidades eliminadas, volumen persistente y límites de 128 MiB para migración / 384 MiB y 0,5 CPU para servidor. La comprobación de disponibilidad y SIGTERM terminó correctamente.
- Configuración Compose/Traefik expandida y validada: hostname, red externa `n8n_evoapi`, resolver `mytlschallenge`, entrada `websecure`, redirección HTTP y puerto interno 8080 sin puerto publicado.

- Traefik real en contenedores: metadata, disponibilidad y WebSockets de anfitrión e invitado por HTTPS/WSS; espera y admisión verificadas. El ensayo usa el proveedor de archivos y un certificado local aceptado únicamente por el controlador de prueba. Las labels se verificaron por separado al expandir Compose; DNS y ACME requieren el VPS. Evidencia inicial: `/tmp/sh-traefik-GVAxiC`; repetición satisfactoria con la imagen final: `/tmp/sh-traefik-YPYoqq` (2026-11-03).
- Suite completa: 59 pruebas del backend, 7 del servicio de sesiones, 41 del frontend y 2 de scripts. Incluye rechazo de certificados no confiables y de esquemas SQLite de una versión futura.

## Carga local medida

Ejecutable Rust en **release**, controlador Bun en la misma máquina Linux. 100 sesiones con 6 invitados más anfitrión: **700 WebSockets** abiertos durante 30 segundos. Se ejecutó una ráfaga de 100 admisiones; los límites de registro/peticiones se elevaron solo en la prueba porque todos los clientes comparten IP.

| Métrica | Medición |
| --- | --- |
| Conexiones conservadas al finalizar | 700/700 |
| RSS inicial del servicio | 7,87 MiB |
| RSS con conexiones | 19,21 MiB |
| Pico RSS observado | 19,28 MiB |
| CPU media, equivalente a un núcleo | 0,43 % |
| Latencia de admisión p50 | 1,79 ms |
| Latencia de admisión p95 | 3,26 ms |
| Mensajes de snapshot durante el intervalo | 1.666 |
| Payload JSON saliente | 601.838 bytes |

Los datos corresponden a `/tmp/sh-sessions-load-zMuNwL/report.json`. El payload no incluye cabeceras HTTP, framing WebSocket, ping/pong ni TLS. La prueba no incluye tráfico de audio/vídeo, descargas del frontend, latencia de internet ni contención de un VPS compartido. No extrapolar estas cifras como un SLA o máximo de usuarios. Los procesos del generador y navegador no están incluidos en el RSS del servicio.

Para repetir: `cargo build --release --locked -p streamhive-sessions && bun scripts/session-service-load.mjs`. Variables: `LOAD_STUDIOS` (100), `LOAD_GUESTS` (6), `LOAD_SECONDS` (30), `SESSIONS_BIN` (ejecutable release).
