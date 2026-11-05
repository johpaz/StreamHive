# Chat general flotante

Implementado el 2026-11-05 para el anfitrión y los invitados admitidos, tanto en el estudio local como en el portal de sesiones remotas. No requiere cámara o micrófono. La conexión multimedia del portal remoto sigue siendo una función independiente.

## Uso

La abejita abre el chat desde la esquina inferior derecha. Hay tres tamaños:

- **Reducido:** burbuja de 64 px con contador de mensajes no leídos.
- **Medio:** ventana de 360 × 480 px, limitada al espacio disponible; en móvil ocupa el ancho disponible con márgenes y hasta el 70 % de la altura visible.
- **Full:** superposición que ocupa la aplicación, con navegación por teclado y aislamiento del foco. Escape vuelve a medio; otro Escape reduce a burbuja.

El borrador y la posición de lectura se conservan al cambiar de tamaño. Enter envía; Shift+Enter añade un salto de línea. Un envío fallido permite reintentar sin duplicar mensajes. El anfitrión puede borrar mensajes. La abejita reacciona a mensajes, envíos y reconexiones; no tiene IA ni sonido y respeta la preferencia de movimiento reducido.

En modo local, **Nueva conversación local** cierra el chat anterior para todos y abre uno vacío, previa confirmación. Iniciar o detener RTMP no reinicia el chat. En modo remoto, la conversación termina al cerrar o caducar su sesión. El chat se incorpora al estudio y al portal; el compositor `/render` no lo monta y no se añade como capa al programa.

## Transporte, permisos y almacenamiento

- HTTP autenticado para historial, envío y moderación. WebSocket existente para notificaciones tipadas, sin texto de mensajes; los clientes recuperan los cambios desde SQLite mediante un cursor. Se conserva `refresh` local y `snapshot` remoto.
- Actualización al abrir/reconectar el WebSocket y consulta de respaldo cada cinco segundos. Los receptores retrasados reciben `chat.sync`; el historial persistido permite recuperar cambios que no llegaron por el socket.
- Historial inicial de hasta 50 mensajes, paginación hacia atrás y hasta 100 eventos por consulta incremental, incluidos borrados. El identificador de envío del cliente hace idempotente el reintento; un borrado elimina el texto almacenado y sincroniza una marca de mensaje eliminado.
- La lectura, el envío y las notificaciones exigen admisión vigente. Invitados en espera, rechazados, expulsados o de otra sesión no acceden al historial. El anfitrión es el único que modera.
- Texto plano con emoji: 2.000 caracteres y 8 KiB UTF-8 como máximo. Por participante y conversación se permiten hasta 30 mensajes por minuto, con un máximo de cinco en cualquier ventana de diez segundos.
- Tablas `chat_conversations`, `chat_messages` y `chat_events`; operaciones de chat fuera del runtime asíncrono. La base local conserva una conversación activa; el servicio remoto usa el identificador de sesión. No se reescribe el agregado JSON del estudio por cada mensaje.
- En modo remoto, el backend del escritorio actúa como puente usando las credenciales existentes. El historial reside en el servidor de sesiones; ante un corte no se cambia silenciosamente a otro historial local.
- El historial cerrado se purga a partir de las 24 horas: al arrancar y periódicamente (cada hora localmente y cada minuto en sesiones). Una conversación local activa continúa hasta que el anfitrión la sustituya.

Los contratos completos están en `docs/openapi.json` y `sessions/openapi.json`. Nuevas rutas:

| Método | Ruta | Función |
| --- | --- | --- |
| GET | `/api/v1/chat/messages` | Historial, `session_id`, cursor `after` o mensajes anteriores con `before` |
| POST | `/api/v1/chat/messages` | `session_id`, `client_message_id` UUID y `text` |
| DELETE | `/api/v1/chat/messages/{id}?session_id=…` | Borrado del anfitrión |
| POST | `/api/v1/chat/conversation` | Solo backend local: sustituir la conversación activa |

`chat.message` y `chat.deleted` notifican cambios; `chat.closed` avisa del reinicio local. El cierre remoto se comunica mediante el snapshot terminal existente. Cada página identifica al lector con `viewer_id`, para que los mensajes del anfitrión remoto se reconozcan como propios.

## Compilación y despliegue

Las migraciones son aditivas. El servicio de sesiones pasa a versión de esquema 2 y rechaza bases más nuevas. Actualizar primero el servicio remoto y después los clientes. Los clientes anteriores siguen interpretando sus snapshots habituales; no conocen el chat.

El bundle del portal extrae los estilos del componente a `sessions/web/chat.css`, servido bajo la política CSP existente. `scripts/build-session-guest.mjs` y el Dockerfile de sesiones incluyen tanto JavaScript como CSS.

```bash
bun install --frozen-lockfile
(cd frontend && bun install --frozen-lockfile)
bun scripts/build-session-guest.mjs
cargo build --workspace --locked
(cd frontend && bun run build)
bun scripts/chat-e2e.mjs
```

La prueba de navegador usa bases temporales, puertos libres y Chromium; no lee credenciales reales, solicita dispositivos ni configura destinos. Si Playwright no encuentra su navegador preferido, usa un Chromium ya instalado en la caché; `CHROMIUM_PATH` permite elegir otro ejecutable. Se necesita permiso para abrir puertos locales.

## Validación

- Pruebas Rust: permisos locales/remotos, aislamiento, persistencia al reabrir, rotación, límites, paginación, retención, idempotencia y recuperación de borrados.
- Pruebas TypeScript: orden y deduplicación de mensajes; una respuesta tardía no puede restaurar texto borrado.
- `scripts/chat-e2e.mjs`: anfitrión y dos invitados en cada modo, notificaciones en tiempo real, tres tamaños, foco, borrador, posición de lectura, no leídos, texto seguro, recarga, desconexión, reintento, borrado durante un corte, móvil, movimiento reducido, reinicio, expulsión y cierre remoto. Guarda capturas de escritorio y móvil en su directorio temporal.

La validación de navegador usa Chromium en la misma máquina. No certifica Safari/iOS, teclado físico de un dispositivo móvil ni redes externas; no se desplegó esta versión al VPS.
