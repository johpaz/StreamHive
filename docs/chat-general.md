# Chat general flotante

Implementado el 2026-11-05 para todas las personas del estudio: el anfitrión, los invitados del directo y quienes están en la sala de espera, para coordinar ingresos e interacción. Funciona tanto en el estudio local como en el portal de sesiones remotas. No requiere cámara o micrófono. La conexión multimedia del portal remoto sigue siendo una función independiente.

## Uso

La abejita abre el chat desde la esquina inferior derecha. Hay tres tamaños:

- **Reducido:** burbuja de 64 px con contador de mensajes no leídos.
- **Medio:** ventana de 360 × 480 px, limitada al espacio disponible; en móvil ocupa el ancho disponible con márgenes y hasta el 70 % de la altura visible.
- **Full:** superposición que ocupa la aplicación, con navegación por teclado y aislamiento del foco. Escape vuelve a medio; otro Escape reduce a burbuja.

En el estudio, la burbuja y la ventana media se colocan encima de la barra de emisión cuando esta queda fija al fondo de la pantalla, para no tapar Grabar, Iniciar directo ni Finalizar directo. Así ocurre también en el modo foco.

El borrador y la posición de lectura se conservan al cambiar de tamaño. Enter envía; Shift+Enter añade un salto de línea. Un envío fallido permite reintentar sin duplicar mensajes. El anfitrión puede borrar mensajes. La abejita reacciona a mensajes, envíos y reconexiones; no tiene IA ni sonido y respeta la preferencia de movimiento reducido.

En modo local, **Nueva conversación local** cierra el chat anterior para todos y abre uno vacío, previa confirmación. Iniciar o detener RTMP no reinicia el chat. En modo remoto, la conversación termina al cerrar o caducar su sesión. El chat se incorpora al estudio y al portal; el compositor `/render` no lo monta y no se añade como capa al programa.

Los enlaces `http://` y `https://` de los mensajes son clicables y se abren aparte (`noopener noreferrer`; en la app de escritorio, en el navegador del sistema). Cualquier otro esquema queda como texto.

## Materiales (adjuntos)

Todas las personas del chat (anfitrión, invitados del directo y sala de espera) comparten archivos con el botón 📎: se suben con barra de progreso, se pueden quitar antes de enviar y viajan en un mensaje, con o sin texto.

- **Tipos:** PDF, imágenes PNG/JPG/WebP, texto (TXT, CSV, MD), Word/Excel/PowerPoint (DOCX, XLSX, PPTX), OpenDocument (ODT, ODS, ODP) y ZIP. El tipo se reconoce por la firma del contenido, no por la extensión ni por lo que diga el navegador: un programa renombrado a `.pdf` se rechaza. Los formatos Office y ODF se distinguen del ZIP por la extensión una vez comprobada la firma ZIP.
- **Límites:** 25 MB por archivo, 200 MB por conversación y 10 subidas por minuto y persona. Un archivo subido y no enviado caduca en una hora.
- **Descarga:** siempre como adjunto (`Content-Disposition: attachment`, `nosniff`, `CSP: sandbox`), así que nada se abre ni se ejecuta dentro del estudio. Las imágenes se ven además en miniatura. Solo descargan quienes tienen acceso al chat; un archivo sin enviar, de un mensaje borrado o de otra conversación no se sirve.
- **Borrado:** borrar el mensaje borra su archivo. Los archivos se guardan aparte de la base (`DATA_DIR/chat-files` en el estudio y `chat-files` junto a la base del servicio de sesiones) y se limpian del disco al borrar mensajes y en cada purga; caducan con el historial.
- **Llevar a Archivos:** solo el anfitrión, y solo con imágenes PNG/JPG/WebP, copia el archivo a la biblioteca del estudio para mostrarlo en el programa. Funciona también con archivos de invitados remotos.
- **Remoto:** los archivos de una sesión remota se guardan en el servidor de sesiones; el escritorio los sube y descarga por su puente con un plazo de 180 s.

Nada del chat sale al aire ni queda en la grabación.

## Transporte, permisos y almacenamiento

- HTTP autenticado para historial, envío y moderación. WebSocket existente para notificaciones tipadas, sin texto de mensajes; los clientes recuperan los cambios desde SQLite mediante un cursor. Se conserva `refresh` local y `snapshot` remoto.
- Actualización al abrir/reconectar el WebSocket y consulta de respaldo cada cinco segundos. Los receptores retrasados reciben `chat.sync`; el historial persistido permite recuperar cambios que no llegaron por el socket.
- Historial inicial de hasta 50 mensajes, paginación hacia atrás y hasta 100 eventos por consulta incremental, incluidos borrados. El identificador de envío del cliente hace idempotente el reintento; un borrado elimina el texto almacenado y sincroniza una marca de mensaje eliminado.
- Leen, escriben y reciben notificaciones el anfitrión, los invitados admitidos y los que están en sala de espera. Los mensajes de quien espera se guardan con `sender_role: "waiting"` y se muestran con la etiqueta *En sala de espera*, que conserva aunque luego sea admitido. Invitados rechazados, expulsados o de otra sesión no acceden al historial. El anfitrión es el único que modera.
- Texto plano con emoji: 2.000 caracteres y 8 KiB UTF-8 como máximo. Por participante y conversación se permiten hasta 30 mensajes por minuto, con un máximo de cinco en cualquier ventana de diez segundos.
- Tablas `chat_conversations`, `chat_messages` (con `attachment_id`), `chat_events` y `chat_files`; operaciones de chat fuera del runtime asíncrono. La base local conserva una conversación activa; el servicio remoto usa el identificador de sesión. No se reescribe el agregado JSON del estudio por cada mensaje.
- En modo remoto, el backend del escritorio actúa como puente usando las credenciales existentes. El historial reside en el servidor de sesiones; ante un corte no se cambia silenciosamente a otro historial local.
- El historial cerrado se purga a partir de las 24 horas: al arrancar y periódicamente (cada hora localmente y cada minuto en sesiones). Una conversación local activa continúa hasta que el anfitrión la sustituya.

Los contratos completos están en `docs/openapi.json` y `sessions/openapi.json`. Nuevas rutas:

| Método | Ruta | Función |
| --- | --- | --- |
| GET | `/api/v1/chat/messages` | Historial, `session_id`, cursor `after` o mensajes anteriores con `before` |
| POST | `/api/v1/chat/messages` | `session_id`, `client_message_id` UUID, `text` y, opcional, `attachment_id` |
| POST | `/api/v1/chat/files?session_id=…` | Subir un archivo (cuerpo binario, nombre en `x-file-name` en base64) |
| GET | `/api/v1/chat/files/{id}?session_id=…` | Descargar un archivo enviado |
| POST | `/api/v1/chat/files/{id}/library?session_id=…` | Solo backend local y anfitrión: copiar una imagen a Archivos |
| DELETE | `/api/v1/chat/messages/{id}?session_id=…` | Borrado del anfitrión |
| POST | `/api/v1/chat/conversation` | Solo backend local: sustituir la conversación activa |

`chat.message` y `chat.deleted` notifican cambios; `chat.closed` avisa del reinicio local. El cierre remoto se comunica mediante el snapshot terminal existente. Cada página identifica al lector con `viewer_id`, para que los mensajes del anfitrión remoto se reconozcan como propios.

## Compilación y despliegue

Las migraciones son aditivas. El servicio de sesiones pasa a versión de esquema 3 (archivos del chat) y rechaza bases más nuevas. Actualizar primero el servicio remoto y después los clientes. Los clientes anteriores siguen interpretando sus snapshots habituales; no conocen el chat.

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

- Pruebas Rust: permisos locales/remotos, aislamiento, persistencia al reabrir, rotación, límites, paginación, retención, idempotencia y recuperación de borrados. Archivos: sala de espera, tipos falsos y nombres con rutas, archivo ajeno, cabeceras de descarga, borrado con el mensaje, persona retirada o rechazada, otra sesión, Llevar a Archivos, 25 MB, 10 por minuto, 200 MB por conversación y caducidad de subidas no enviadas.
- Pruebas TypeScript: orden y deduplicación de mensajes; una respuesta tardía no puede restaurar texto borrado; enlaces solo http(s) y sin la puntuación final; tamaños legibles.
- `scripts/chat-e2e.mjs`: anfitrión y dos invitados en cada modo, notificaciones en tiempo real, tres tamaños, foco, borrador, posición de lectura, no leídos, texto seguro, recarga, desconexión, reintento, borrado durante un corte, móvil, movimiento reducido, reinicio, expulsión y cierre remoto. Con archivos: PDF con enlace subido con el botón real y descargado byte a byte, miniatura de imagen, Llevar a Archivos solo para el anfitrión, programa renombrado rechazado y, en remoto, descarga por el puente del escritorio y archivo del anfitrión descargado por un invitado. Guarda capturas de escritorio y móvil en su directorio temporal.

La validación de navegador usa Chromium en la misma máquina. No certifica Safari/iOS, teclado físico de un dispositivo móvil ni redes externas; no se desplegó esta versión al VPS.

## Diseño previo

Se conserva el [diseño previo del chat](chat-general-diseno-previo.md) como referencia histórica. Incluye una propuesta distinta (moderadores delegados) que no forma parte de esta implementación del chat flotante.
