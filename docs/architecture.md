# Arquitectura

```mermaid
flowchart LR
    P[Productor e invitados] -->|HTTPS / WSS| H[HAProxy :443]
    H -->|SNI web / rtc| C[Caddy]
    H -->|SNI turn + PROXY v2| T[TURN integrado en LiveKit]
    C --> A[API Rust / Axum]
    C --> L[LiveKit SFU]
    P <-->|WebRTC UDP / TCP / TURN| L
    A --> D[(SQLite)]
    A -->|Twirp HTTP| L
    L <--> R[(Redis)]
    R <--> E[Egress]
    E -->|Chrome + plantilla React| V[Compositor web]
    V <-->|Pistas seleccionadas| L
    V -->|Estado y confirmación de revisión| A
    E --> Y[Destino RTMP / RTMPS]
    E --> F[MP4 en volumen compartido]
    A --> F
```

## Estado y autorización

Una instancia de aplicación gestiona un estudio y una sala de LiveKit. SQLite conserva una instantánea JSON transaccional del agregado de estudio, además de los ajustes de autenticación. Esta decisión reduce las migraciones de la primera versión; no es un diseño para múltiples réplicas del backend. `rusqlite` sustituye SQLx, conservando SQLite, WAL y sentencias parametrizadas. La estructura pública está documentada en OpenAPI.

El backend serializa comandos de producción y actualiza una revisión monotónica del programa. Una revisión desactualizada devuelve 409. Las notificaciones WebSocket solo señalan que hay cambios: cada cliente obtiene una instantánea autenticada. Hay sondeo de respaldo y reconexión del WebSocket.

Invitaciones aleatorias se guardan como hashes; la respuesta inicial es la única que revela el enlace completo. La previsualización de invitados usa getUserMedia local. La sala de espera no recibe JWT multimedia. El administrador tiene controles de estudio; los invitados solo consultan estado y solicitan un token después de ser admitidos.

El renderer recibe una credencial aleatoria independiente por directo, además del JWT de lectura generado por Egress. Su credencial solo autoriza leer la composición y confirmar revisiones de ese directo activo. Se deshabilita la suscripción automática y se suscriben explícitamente pistas autorizadas por fuente e identidad. El componente Stage solo monta elementos de audio permitidos y los desmonta al retirarlos del programa. No se utiliza un reproductor global de audio de la sala dentro del compositor.

Los micrófonos de todas las identidades seleccionadas siguen al aire en modo protagonista, aunque solo se vea su cámara principal. El audio de pantalla requiere habilitación explícita y la composición de pantalla. Los participantes admitidos pueden conversar entre sí fuera del programa; este espacio no se presenta como conversación privada entre productor e invitado.

## Emisión y reconciliación

StartEgress recibe una fuente TemplateSource y dos salidas: un archivo MP4 y un StreamOutput RTMP. La codificación H.264/AAC es compartida. No existe una salida RTMP desde el navegador del productor.

Se persiste la sesión antes de llamar al servicio externo. Una respuesta ambigua produce estado uncertain y bloquea otros inicios. ListEgress recupera el trabajo mediante su identificador o la ruta única del archivo en `egress.outputs`. Una consulta satisfactoria sin trabajo correspondiente durante más de 90 segundos marca la solicitud como fallida. Un error de conectividad conserva la incertidumbre.

La reconciliación consulta cada cinco segundos el estado de Egress y participantes. Webhooks firmados verifican emisor, firma, expiración y SHA-256 del cuerpo original; no deciden estados terminales de emisión basándose en el orden de entrega. La desaparición de una pantalla se procesa por webhook y también por reconciliación.

Emisión y grabación son servicios independientes de una sesión de salida, que sigue activa mientras alguno lo esté. Con el motor local se activan y detienen por separado en cualquier momento, y una sesión puede producir varias grabaciones. Egress fija sus salidas al iniciar, así que allí los servicios se eligen al arrancar y se finalizan juntos. Con el motor local, la carpeta de destino se guarda en los ajustes y se valida al elegirla y al empezar cada grabación: si deja de estar disponible se avisa, nunca se graba en otra. Cada grabación conserva su carpeta. Con Egress la define el despliegue. Solo un EGRESS_COMPLETE con archivo presente se ofrece como descarga finalizada. Los errores mantienen el archivo como interrumpido; no se promete integridad tras un crash del compositor o del host.

Los timeouts de API son de 20 segundos. Un servicio multimedia caído puede retrasar los controles de producción o impedir una parada ordenada: el panel debe mostrar el fallo, y la recuperación operativa debe comprobar LiveKit/Egress antes de reiniciar otra emisión. Los avisos y límites de disco son preventivos, no una garantía contra fallos de almacenamiento.

## Versiones y red

- LiveKit server v1.13.11, Egress v1.15.0 y SDK navegador 2.23.0: versiones fijadas; compatibilidad audiovisual pendiente de ensayo en VPS.
- Axum 0.8.9, Tokio 1.53.3, React 19.3.0; dependencias transitorias fijadas en Cargo.lock y bun.lock.
- WebSocket de control con tokio-tungstenite 0.28 y upgrade HTTP de Hyper. Esto permite compilar con las dependencias disponibles en caché.
- HAProxy inspecciona SNI sin terminar TLS. TURN recibe PROXY v2 para conservar la dirección del invitado. Caddy termina HTTPS para el panel y la señalización.
- La versión fijada de LiveKit anuncia TURN/TLS en el puerto público 443 aunque escuche internamente en 5349. HAProxy enruta ese dominio a 5349.
- Caddy obtiene el certificado TURN mediante HTTP-01 y lo comparte en modo lectura con LiveKit. La primera adquisición y posteriores recargas de LiveKit forman parte de la operación.

## Fuentes técnicas

Documentación consultada el 1 de noviembre de 2026:

- [API Egress unificada](https://docs.livekit.io/reference/other/egress/api/): StartEgress requiere servidor autohospedado 1.13.5 o posterior.
- [Plantillas de compositor](https://docs.livekit.io/transport/media/ingress-egress/egress/custom-template/).
- [Requisitos de Egress](https://docs.livekit.io/transport/self-hosting/egress/): al menos 4 CPU y 4 GB por instancia recomendados por el proveedor.
- [Puertos y firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/).
- [Pantalla y audio compartidos](https://docs.livekit.io/transport/media/screenshare/).
- [Protocolo Egress](https://github.com/livekit/protocol/blob/main/protobufs/livekit_egress.proto).
- [TURN anunciado y tokens en LiveKit v1.13.11](https://github.com/livekit/livekit/blob/v1.13.11/pkg/service/roommanager.go).
- [Implementación TURN y PROXY protocol](https://github.com/livekit/livekit/blob/v1.13.11/pkg/service/turn.go).

Alternativas estudiadas: mediasoup-rust proporciona control sobre un SFU C++ pero exige integrar composición y exportación; str0m permite construir un motor WebRTC en Rust con un esfuerzo mucho mayor. MediaMTX resulta útil para encaminamiento de protocolos, pero no sustituye por sí solo el estudio multiparte con escenas. Se eligió LiveKit por ajuste al producto solicitado.

## Biblioteca y composición del programa

`Program` mantiene compatibilidad con datos previos mediante valores por defecto para contenido, reproducción y estilo. Las fuentes `screen` y `media_asset` son mutuamente excluyentes. Una fuente de contenido tiene modo lateral, flotante o completo; la composición de cámaras calcula rectángulos 16:9 centrados para 1–6 participantes.

La biblioteca vive en `DATA_DIR/assets`; sus metadatos se guardan junto al agregado de SQLite. La subida es binaria y se escribe por bloques con límites por tipo y validación de firma inicial. Los nombres originales solo se usan como etiquetas; las rutas de disco usan UUID y extensión del formato admitido. La descarga admite Range para búsqueda en video. El propietario y los participantes admitidos pueden consultar archivos; la credencial del renderer solo sirve para el contenido y la imagen de fondo seleccionados en el programa activo.

El backend fija el instante de reproducción en milisegundos. Los clientes compensan la diferencia entre relojes usando `server_time_ms`; cambios de posición y pausa se sincronizan mediante revisiones de programa. Los archivos entran en pausa, no se repiten por defecto y el último cuadro permanece al finalizar. El compositor espera a que su contenido inicial esté cargado antes de confirmar disponibilidad. La previsualización usa el mismo componente de escenario; escuchar localmente el video es independiente del audio exportado.


## Efectos y fondos

La galería ofrece cuatro fondos locales con miniaturas: Oficina luminosa, Oficina cálida, Streamer neón y Estudio de podcast. Están incluidos en la aplicación y no requieren subida ni servicios de imágenes externos. Los prompts y archivos se documentan en [Fondos de cámara](camera-backgrounds.md).

Cada participante abre **Efectos de cámara** para elegir Sin efecto, Desenfoque (intensidad 4–30) o una imagen PNG/JPEG/WebP local de hasta 5 MB y 4096 × 4096 px. La prueba usa una pista privada sin publicar; Cancelar conserva la cámara enviada y Aplicar actualiza solo su cámara. Las preferencias duran en la pestaña y se reaplican al encenderla o reconectar. La pantalla compartida no pasa por el procesador. Los recortes dependen de la iluminación, el navegador y la capacidad gráfica del equipo del participante.

**Pantalla compartida por invitados.** Cualquier persona admitida y conectada a la sala puede pulsar **Compartir pantalla** (su credencial de LiveKit permite `screen_share` y `screen_share_audio`). El anfitrión la ve en Fuentes → Pantallas cuando él también está conectado a la sala, y decide con **Mostrar en programa** si sale al aire; compartir no la emite por sí solo. `scripts/guest-screen-e2e.mjs` lo comprueba con un invitado real en Chromium: botón, lista del anfitrión, vista previa y fotograma del MP4 grabado. Límites: los navegadores de móvil no ofrecen captura de pantalla, así que el botón no aparece allí; quien está en la sala de espera no comparte nada hasta ser admitido. Los invitados que entran por el servidor de sesiones tienen lo mismo cuando el servidor incluye cámara y audio (sección siguiente); si no, solo la sala de espera y el chat.

`scripts/vendor-effects.mjs` fija `@livekit/track-processors` 0.8.2, MediaPipe Tasks Vision 0.10.14 y Selfie Segmenter float16 v1. Verifica SRI de paquetes y SHA-256 del modelo antes de instalar el módulo, WASM, licencias y modelo en `/effects`. Docker y el arranque local preparan estos archivos; una compilación manual requiere `cd frontend && bun run sdk && bun run effects && bun run build`. Los participantes descargan el runtime del mismo servidor, sin peticiones a CDNs durante la sesión. La imagen personal se mantiene como URL local del navegador; la sala recibe el video procesado. Requiere WebGL2, OffscreenCanvas y APIs de procesamiento/captura de video. Si falta soporte, Sin efecto sigue disponible. Chrome/Edge recientes con aceleración gráfica son el punto de partida recomendado; otros navegadores requieren verificación en su dispositivo.

El anfitrión elige **Identidad del programa → Fondo del escenario**: color sólido o una imagen ya subida en Archivos. `background_asset` es independiente del contenido y las cámaras; el backend solo acepta imágenes existentes y protege las que estén en uso contra borrado. El mismo Stage compone la vista del estudio y el renderer; este espera la carga del fondo antes de confirmar una revisión. La ruta RTMP/MP4 completa sigue pendiente de prueba con Egress.

Referencias: [procesadores oficiales de LiveKit](https://github.com/livekit/track-processors-js/blob/main/processor-docs/video-processors.md), [ciclo de vida de LocalTrack en SDK 2.23.0](https://github.com/livekit/client-sdk-js/blob/v2.23.0/src/room/track/LocalTrack.ts).

## Pantallas de inicio, pausa y fin

`Data.slates` guarda la configuración y `Data.active_slate` la pantalla al aire. Viven fuera de `Program` para que los dos formatos cambien a la vez, las escenas no las capturen y el programa se pueda preparar debajo.

El compositor conserva la misma raíz `.stage`, porque la captura guarda esa referencia. `slateProgram` deriva un programa sin personas, micrófonos ni contenido; `Stage` lo dibuja y `Renderer` lo usa con `allowedTrack`, de modo que esas pistas ni se suscriben. La música es un `<audio>` que solo monta el renderer y que `AudioMixer` engancha a la mezcla.

El fin del temporizador lo aplica una tarea de `tokio` si sigue al aire esa misma pantalla; `reconcile` hace de respaldo. La pantalla activa se limpia al terminar la sesión y al arrancar el servidor.

## Programas horizontal y vertical

`Data.program` conserva el programa 16:9 y `Data.portrait_program` guarda el 9:16. Cada uno tiene su propia revisión. Las escenas guardadas contienen nombre, formato y una copia del programa; activarlas incrementa la revisión del formato correspondiente. Retirar participantes limpia ambos programas y las escenas. El acceso a archivos del renderer y la protección contra borrado consideran ambos programas; las escenas guardadas también protegen los archivos referenciados.

Los destinos se agrupan por formato al iniciar. Solo se crean compositores para los formatos con destinos activos: 1920×1080 y/o 1080×1920. Cada grupo tiene un trabajo de Egress o FFmpeg, un MP4 y un identificador de salida en `Broadcast.outputs`. El segundo MP4 usa el sufijo `-portrait`. Las credenciales de los dos renderers locales tienen identidades LiveKit distintas para que no se expulsen entre sí. El token del renderer sigue limitado a la emisión activa.

FFmpeg codifica H.264/AAC una vez por formato y reparte MPEG-TS mediante un canal de memoria acotado. Cada destino tiene un proceso FFmpeg que solo remultiplexa a FLV/RTMP, con tiempo máximo de escritura y reconexión independiente. El progreso de ese publicador determina su estado; no se infiere del proceso de grabación. Al reconectar se espera suficiente información para recibir un fotograma clave y recuperar los parámetros de H.264. La grabación es otro suscriptor del mismo canal: copia a MP4 sin recodificar y nunca frena al encoder, por lo que un disco incapaz de seguir el ritmo deja huecos en el archivo. La grabación y los demás destinos no esperan a una conexión caída.

La reconciliación conserva el último intento de **cada URL** y traduce los resultados a IDs de destinos antes de persistir o responder al navegador. Las URLs y claves no se guardan en `Broadcast.destination_statuses` ni salen en las respuestas. Reintentar una salida sana no la vuelve a añadir. El servidor de un destino también se cifra por separado para permitir renovar la clave sin devolver las credenciales guardadas.

## Cámara y audio por el servidor de sesiones

Sin servidor, la sala de cámara y audio es el LiveKit local de cada equipo: solo llega quien está en ese equipo o en su red local. Para invitar a gente de cualquier red, cada persona despliega su propio servidor de sesiones (`deploy/sessions/compose.yaml`: una URL HTTPS y dos puertos de vídeo, `7882/udp` y `7881/tcp`), que incluye su propio LiveKit.

- **Una sola puerta.** LiveKit está en la red interna del compose. Desde fuera solo se llega por `https://dominio/lk` (señalización WebSocket y cuatro llamadas de administración de la sala propia: listar, consultar, silenciar y retirar) y por los puertos de vídeo. Sus claves las genera `migrate` la primera vez en un volumen aparte y no salen del servidor.
- **Permisos limitados.** Cada instalación tiene su sala (`sh-<instalación>`). La app pide al servidor (`POST /api/v1/media/token`) permisos para publicar (anfitrión e invitados locales), para el compositor oculto (`EG_*`) o para administrar su sala; las identidades `g-*` quedan reservadas a los invitados del servidor. Un invitado del servidor recibe su permiso (`GET /api/v1/guest/media`) solo después de ser admitido; al retirarlo, rechazarlo o revocar su invitación sale de la sala al momento, y al cerrar la sesión remota se cierra la sala.
- **La app elige la sala** en `backend/src/rtc.rs`: si el servidor configurado anuncia medios (`/api/v1/meta` → `media: true`) y la casilla *Usar el servidor para cámara y audio* está activa (por defecto), todo (anfitrión, invitados locales, compositor, silenciar y retirar) va al LiveKit del servidor; si no, al local. No se cambia durante un directo o una grabación.
- **Portal del invitado.** La página del servidor (`frontend/src/SessionGuest.tsx` y `GuestStudio.tsx`, compilados en `sessions/web/`) lleva al invitado, una vez admitido, a su propio estudio: el escenario del anfitrión tal como lo tiene él (mismo componente `Stage`), si está en el programa, el estado del directo, sus controles (encender cámara y micrófono, silenciar, compartir pantalla, dispositivos con su nombre real, sonido de la sala), quién está en la sala y el chat fijo al lado. Entra en la sala para ver y oír nada más ser admitido; su cámara y su micrófono, cuando él los enciende. Los estilos del estudio se sirven encerrados en `.guest-studio` (`scripts/scope-css.mjs`) para no tocar la página de entrada. El SDK de LiveKit lo sirve el propio servidor (`/livekit-client.umd.js`), porque su CSP solo admite scripts propios.
- **El escenario del anfitrión.** La app publica en el servidor (`PUT /api/v1/sessions/{sid}/stage`, hasta 16 KB, solo en memoria) el programa horizontal, los nombres, la pantalla al aire y si está en directo o grabando, cada vez que cambia y cada 30 s. Sin rutas de archivos: logos, fondos, vídeos y música del equipo no salen de él, y el portal avisa cuando hay un archivo en pantalla. Solo los invitados admitidos lo reciben, en su snapshot.
- **Invitados del servidor en el estudio.** Los admitidos en el servidor aparecen como participantes del estudio (`g-<id>`): en Fuentes → Participantes, en cupos de pantalla, en el programa y en la grabación. Retirarlos desde el estudio los retira también en el servidor. Admitir, rechazar o retirar se aplica en el estudio al momento (la app vuelve a pedir la lista sin esperar al canal de control), el servidor expulsa al invitado de su sala de cámara (con un reintento; si LiveKit no lo confirma, la app lo avisa) y el portal apaga su cámara y su micrófono en cuanto LiveKit lo desconecta.
- **Cómo se entera la app de que alguien espera.** Por el canal de control (WebSocket saliente hacia `/api/v1/events`): cada cambio llega como snapshot, se refleja en la sala de espera del estudio y dispara el aviso de llegada (sonido, aviso con Admitir y, si la ventana no está al frente, notificación del sistema desde el proceso principal de Electron). Si ese canal se cae, la app vuelve a pedir `GET /sessions/current` cada 5 s como mucho, así que las solicitudes siguen llegando; a los 15 s sin canal lo indica en «Invitados del servidor» y en la franja del modo foco.
- **Los invitados son temporales.** No quedan en ninguna lista: «Invitados del servidor» solo muestra a quien espera o está en la sala y los enlaces que aún sirven. **Retirar a todos** (Fuentes → Participantes, con confirmación; `POST /api/v1/participants/clear`) y el **fin de cada sesión** (directo o grabación, vigilado sobre los eventos del estudio) retiran a todos, de la red local y del servidor: salen de la sala y del programa, se borran sus registros y se anulan todos los enlaces. En el servidor es `POST /api/v1/sessions/{sid}/cleanup` con `scope: "all"` (anunciado en `/meta` → `features: ["cleanup"]`; con un servidor anterior la app retira y revoca uno a uno). Un invitado borrado recibe su snapshot como «retirado» y deja de reconectar.
- **Lo que no cambia.** La composición, la emisión RTMP y las grabaciones siguen en el equipo del estudio. El vídeo de cada cámara sube al servidor y baja a cada participante y al compositor.

`scripts/media-server-e2e.mjs` prueba el servidor (permisos, aislamiento entre instalaciones, expulsión y cierre, también contra el compose real) y `scripts/remote-media-e2e.mjs` el estudio sin LiveKit local: anfitrión e invitado por el servidor, el invitado en el programa y en el fotograma del MP4.
