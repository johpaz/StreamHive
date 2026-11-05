<img src="frontend/public/branding/streamhive-logo.svg" alt="StreamHive" width="360" />

# StreamHive

Estudio web personal de streaming: backend Rust, interfaz React en español y motor LiveKit autohospedado. Preparado para desplegar con Docker Compose en un VPS Linux.

- Anfitrión e invitados admitidos por enlace, con sala de espera. El número de invitados lo limita el hardware en tiempo real (CPU, memoria, disco y velocidad del codificador), con un tope configurable `MAX_GUESTS` (10 por defecto); en pantalla caben 6 cámaras.
- Cámaras, micrófonos, selección de dispositivos y varias pantallas disponibles; una al aire.
- Cuadrícula, protagonista o pantalla con cámaras, nombres, logo y fondo de escenario.
- Efectos por participante: desenfoque y fondo de cámara personalizado con prueba privada.
- Emisión y grabación como servicios independientes: solo directo, solo grabación o ambos.
- Carpeta de grabaciones configurable en **Configuración → Grabaciones**; ahí también se ve la predeterminada.
- Hasta cinco salidas RTMP/RTMPS simultáneas y grabación MP4 opcional por formato activo (16:9 y 9:16).
- Biblioteca con descarga y borrado manual; configuración RTMP cifrada.
- Compositor independiente del panel: cerrar el navegador del productor no detiene el directo.

**Estado:** backend e interfaz compilan y tienen pruebas automatizadas. El arranque local, los permisos de dispositivos y la conexión anfitrión/invitado se verificaron en Chromium con cámara y micrófono simulados y LiveKit real. `bun run dev` puede iniciar LiveKit mediante su binario oficial local. La emisión RTMP, grabación, Docker y la prueba de dos horas siguen pendientes de validación; consulta [la matriz de aceptación](docs/acceptance.md).

## Instalación en un VPS

Necesitas Docker Engine con Compose v2, Python 3, una IP pública y tres subdominios. Punto de partida estimado: 8 vCPU, 16 GB RAM y 200 GB SSD. La prueba de carga determinará la capacidad real; no se necesita GPU.

1. Apunta registros DNS A de `studio.tudominio.com`, `rtc.tudominio.com` y `turn.tudominio.com` a la IP pública del VPS. Usa DNS directo, sin proxy HTTP/CDN. Si publicas AAAA, el servidor debe tener IPv6 funcional.
2. Habilita los puertos públicos de esta tabla en el firewall del VPS y del proveedor:

   | Puerto | Protocolo | Uso |
   | --- | --- | --- |
   | 80 | TCP | Emisión y renovación de certificados ACME |
   | 443 | TCP | Web, señalización WSS y TURN/TLS mediante SNI |
   | 7881 | TCP | Alternativa ICE/TCP |
   | 7882 | UDP | Medios WebRTC multiplexados |
   | 3478 | UDP | TURN/STUN |

   Conserva tu acceso SSH. **No publiques** 6379, 7880, 8080, 8081, 8443, 5349, 6789, 7980 ni 7981 en Internet. LiveKit y Egress usan red del host; sus puertos internos necesitan reglas explícitas de firewall. Permite el acceso al puerto 7880 desde la red bridge de Docker para backend y Caddy.
3. Desde esta carpeta genera la configuración. La contraseña se solicita sin mostrarla; los secretos se generan localmente:

   ```bash
   python3 scripts/configure.py \
     --app-domain studio.tudominio.com \
     --livekit-domain rtc.tudominio.com \
     --turn-domain turn.tudominio.com \
     --email tu@tudominio.com
   ```

   El script crea `.env`, `deploy/generated/` y los directorios de datos. Rechaza sobrescribir `.env`. Los contenedores de aplicación y Egress escriben como UID/GID 1000; si tu usuario tiene otro UID, ajusta la propiedad de `runtime/data` y `runtime/recordings` a `1000:1000`.
4. Valida y arranca:

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   docker compose ps
   docker compose logs --tail=50 web livekit egress backend
   ```

   La primera construcción descarga crates, paquetes, imágenes y el SDK LiveKit. Requiere acceso a Internet. Las versiones de imágenes están fijadas y las dependencias de Rust/Bun tienen archivos de bloqueo.

   Caddy obtiene los tres certificados mediante HTTP-01. Durante ese primer arranque, LiveKit puede reiniciarse hasta que exista el certificado TURN; `restart: unless-stopped` permite reintentarlo. Si no se emite, revisa DNS y TCP 80 antes de continuar.
5. Abre `https://studio.tudominio.com`. Comprueba que Configuración muestra el motor disponible y al menos 10 GB libres. Revisa también que Egress esté en ejecución: la disponibilidad de LiveKit no confirma por sí sola la de Egress.

## Primer directo

1. Introduce en Configuración la URL RTMP/RTMPS y la clave del evento creado en YouTube u otro servicio. La clave guardada no vuelve a mostrarse.
2. Conecta tu cámara y audio. Si rechazas un permiso, puedes activarlo después desde los controles.
3. Crea una invitación y envíala a tus invitados. Para probarla tú mismo, usa otro perfil del navegador: las sesiones de anfitrión e invitado usan la misma cookie.
4. Admite invitados y añade al programa las personas que deben salir al aire. Admitir a alguien no lo incorpora automáticamente al programa.
5. Selecciona composición y pantalla. El audio de pantalla está desactivado por defecto; en Chrome/Edge, compartir una pestaña permite solicitar su audio.
6. Pulsa **Iniciar directo** (y **Grabar** si también quieres el archivo; el directo no graba por sí solo) y verifica también la recepción en el panel de la plataforma de destino. StreamHive confirma el estado del motor, no la distribución final de YouTube.
7. Finaliza y espera a que el MP4 aparezca como finalizado antes de descargarlo.

Todos los participantes admitidos pueden conversar entre sí. Solo los micrófonos seleccionados para el programa y el audio de pantalla habilitado se reproducen en el compositor. Se recomienda utilizar auriculares.

El productor controla desde Chrome/Edge de escritorio. Los invitados móviles pueden utilizar cámara y micrófono y ver pantallas. La captura de pantalla desde un navegador móvil no forma parte de esta versión.

## Escenario para tutoriales y conversatorios

Las composiciones se eligen debajo de la vista del programa:

- **Conversación:** cámaras equilibradas en 16:9; también con dos o tres personas, sin convertirlas en columnas verticales.
- **Protagonista:** una cámara visible; los micrófonos seleccionados permanecen en el programa.
- **Tutorial técnico:** contenido completo y cámaras laterales. El texto no se recorta ni se estira.
- **Cámara flotante:** una cámara sobre el contenido, con cuatro posiciones para evitar tapar el código.
- **Solo contenido:** ocupa el escenario con el editor, presentación o manual; las voces seleccionadas siguen disponibles.

En **Participantes**, usa + para añadir, las flechas para ordenar y la estrella para destacar. La sala y el programa tienen estados separados. **Pantallas** permite seleccionar expresamente cuál se muestra. Los invitados no pueden cambiar la composición.

En **Archivos**, sube o arrastra imágenes PNG/JPG/WebP (hasta 20 MB) y videos MP4/WebM (hasta 500 MB). Se guardan en `DATA_DIR/assets`, dentro del volumen de datos existente. La subida se transmite por bloques y no carga el archivo completo en memoria. Solo los formatos con una firma inicial válida se aceptan; la reproducción depende de los codecs del navegador. Para videos se recomienda MP4 H.264/AAC o WebM compatible. Los manuales PDF se muestran compartiendo su ventana.

Subir un archivo no lo pone en programa. Pulsa **Mostrar** para seleccionarlo y **Retirar** para volver a las cámaras. Los videos entran en pausa y tienen reproducción, pausa, reinicio, posición, repetición y volumen. Su posición se sincroniza con el reloj del servidor para la vista previa y el compositor. La escucha local del archivo es opcional; no altera el audio del programa.

En **Audio**, el control **Micrófonos en programa** permite retirarlos del audio de salida sin silenciar la conversación de la sala. El audio de pantalla exige permiso del navegador y habilitación explícita en el programa. Los archivos seleccionados no se pueden eliminar hasta retirarlos.

## Invitados y reparto de la pantalla

La entrada tiene dos pasos que decides tú. **Admitir** pasa a un invitado de la sala de espera a la sala, donde habla contigo pero el público no lo ve ni lo oye. El botón **+** de Fuentes › Participantes lo saca al aire, en el formato que estés editando.

En esa misma pestaña defines dos cupos: **invitados en sala** y **cámaras en pantalla** (de 1 a 6). Bajar un cupo no saca a nadie: solo impide admitir o añadir a más.

Composiciones: **Conversación** (todas iguales), **Protagonista** (una cámara), **Con acompañantes** (una grande y el resto en una tira), **Tutorial técnico** (contenido y cámaras), **Cámara flotante** (contenido y una cámara) y **Solo contenido**. Quien está en la lista suena aunque la composición no muestre su cámara; el estudio lo avisa con «1 cámara visible · 6 voces al aire».

## Modo foco y pantallas de inicio, pausa y fin

Al empezar una sesión, Mi estudio pasa a **modo foco**: se ocultan la barra lateral y los menús, y quedan el escenario, una franja de estado, un panel plegable (Escenas, Fuentes, Ajustes) y una barra inferior con las pantallas, la composición y los botones de emisión. **Salir del foco** dura hasta la siguiente sesión; **Modo foco** permite entrar a mano para ensayar. Fuera del foco, la barra lateral se puede plegar a un riel de iconos.

Las pantallas se configuran en **Configuración** y se activan desde la barra inferior. Mientras una está al aire, cámaras, micrófonos, pantallas compartidas y archivos quedan fuera de la emisión en los dos formatos; el programa se puede seguir preparando debajo, y **Volver al programa** lo recupera.

- **Inicio** se muestra sola al iniciar el directo. Se puede desactivar en su configuración.
- El temporizador es manual al llegar a cero, salvo que se active su casilla: Inicio y Pausa vuelven solas al programa, y Fin termina el directo **y la grabación**.
- Diseño de marca: fondo Colmena, Aurora, Líneas o Liso, teñido con tu color de fondo y el de tu marca; línea de marca y logo arriba o en la esquina. Una imagen propia sustituye al diseño, y **Aplicar este diseño a las tres pantallas** las iguala.
- Cada pantalla admite música de fondo (MP3, OGG, WAV o M4A, hasta 50 MB) o silencio. Emite solo música sobre la que tengas derechos.
- Las pantallas también quedan en la grabación. Un video del programa sigue avanzando mientras está cubierto.

## Datos, límites y recuperación

- `runtime/data/assets`: biblioteca de imágenes y videos; inclúyela en los respaldos del volumen de datos.
- `runtime/data/studio.sqlite`: estado, hash de contraseña, invitaciones y destino cifrado. SQLite usa WAL. La implementación utiliza `rusqlite` para transacciones pequeñas en una única instancia, en lugar de SQLx.
- `runtime/recordings`: archivos MP4; el catálogo está en SQLite.
- `.env`: credenciales y clave maestra AES-256-GCM. **Conserva MASTER_KEY** para poder recuperar el destino cifrado. El backend rechaza una clave distinta de la que cifra los datos existentes.
- Volúmenes `caddy_data`, `caddy_config` y `redis_data`: certificados y coordinación multimedia.
- Invitaciones válidas 24 horas, revocables; revocar bloquea nuevas entradas/admisiones. Para retirar a alguien ya admitido usa los controles de participantes.
- Cookie de sesión de 12 horas, HttpOnly y SameSite=Strict, con Secure sobre HTTPS. Tokens iniciales de sala de tres minutos; LiveKit gestiona sus reconexiones y renovaciones. El backend vuelve a retirar clientes no admitidos durante la reconciliación.
- Salida 1080p30, video a 6 Mbps y audio a 160 kbps: aproximadamente 6 GB por dos horas. Puedes ajustar `VIDEO_BITRATE_KBPS` (1000–12000) y `AUDIO_BITRATE_KBPS` (64–320) en `.env` y recrear backend; la reserva inicial de disco aumenta con el bitrate.
- Se finaliza automáticamente al alcanzar dos horas desde la solicitud de inicio o al bajar de 1 GB libre. El control se ejecuta cada cinco segundos mientras LiveKit responde.
- Las operaciones de inicio/parada están serializadas. Un inicio ambiguo bloquea otro mientras se consulta Egress; se recupera por identificador o por el nombre único del archivo solicitado.
- Si el destino RTMP falla y hay una grabación activa, esta se mantiene mientras el motor siga operativo; el panel permite reintentar la salida.
- Reiniciar backend conserva el directo y recupera su estado. Un fallo de Egress puede dejar un MP4 incompleto: se marca interrumpido y se conserva el archivo; la aplicación no garantiza repararlo ni ofrece descargarlo como si estuviera finalizado.
- Si el compositor pierde acceso al estado del programa, deja de reproducir pistas y muestra un fondo neutro, evitando mantener una selección obsoleta al aire. Puede continuar brevemente el contenido anterior hasta que venza la petición de estado de 1,5 segundos.

### Respaldo y restauración

Haz los respaldos sin un directo activo. Detén backend para copiar SQLite junto con sus archivos WAL/SHM o usa la herramienta de respaldo de SQLite. Guarda `runtime/recordings`, `.env`, `deploy/generated` y los volúmenes Caddy/Redis mediante tu sistema de backups. Los respaldos contienen secretos: restringe acceso y cífralos.

Para restaurar, repón estos archivos en la misma estructura, conserva las claves originales y la propiedad UID/GID 1000 y arranca con las mismas versiones de imágenes. Comprueba catálogo, descargas y destino antes del siguiente directo.

### Cambiar la contraseña

Cambia `ADMIN_PASSWORD` en `.env` y, sin emisión activa, ejecuta:

```bash
docker compose run --rm backend --reset-admin-password
docker compose up -d backend
```

La contraseña no se restablece automáticamente al editar `.env`. Para invalidar también cookies existentes, rota `SESSION_SECRET` por otro valor aleatorio de al menos 32 caracteres y recrea backend. No cambies `MASTER_KEY` al hacer esto.

### Actualizaciones y certificados

Actualiza versiones de forma explícita y vuelve a ejecutar la aceptación multimedia; evita actualizaciones automáticas durante una emisión. Caddy renueva certificados, pero LiveKit carga el certificado TURN al iniciar: programa un reinicio de LiveKit tras una renovación y fuera de los directos. `docker compose down` conserva datos; `down -v` elimina los volúmenes nombrados.

Egress usa Chrome y necesita memoria compartida y `SYS_ADMIN` según el despliegue estándar del motor. En esta configuración Chrome utiliza el comportamiento predeterminado de sandbox de Egress. El renderer solo carga la aplicación propia, el SDK servido localmente y logos PNG/JPEG; no admite URLs arbitrarias de páginas o medios.

## Revisión local rápida

Desde la raíz del proyecto:

```bash
bun run dev
```

El comando construye el backend, intenta preparar el SDK y arranca API e interfaz en `http://localhost:5173`. Las credenciales de revisión están en `runtime/review/login.txt`; los datos y secretos de revisión se guardan aparte de producción. Ctrl+C detiene ambos procesos. Requiere poder abrir sockets locales y tener instaladas las dependencias o acceso para descargarlas.

En Linux x86-64, el comando instala el binario oficial de LiveKit si falta, verifica su SHA-256 e inicia una sala local en `ws://localhost:7880`. Si defines `LIVEKIT_INTERNAL_URL`, usa tu motor existente. La web local usa FFmpeg por defecto para grabar y transmitir mediante RTMP/RTMPS, sin Redis ni Egress. Requiere FFmpeg instalado (`FFMPEG_BIN` permite indicar su ruta). El navegador ejecuta el compositor: mantén la pestaña abierta durante el directo. Las grabaciones quedan en `runtime/review/recordings`. `ENGINE=egress` permite usar un despliegue Egress externo si ya está configurado.

Abre `http://localhost:5173` desde el mismo equipo. Antes de conectar puedes probar cámara y micrófono por separado, seleccionar dispositivos y ver el nivel del micrófono. Permite el acceso cuando lo solicite el navegador. HTTP mediante una IP de red no habilita captura: para otro equipo necesitas HTTPS y direcciones de medios accesibles.

Prueba del modo foco y las pantallas: `CHROMIUM_PATH=/ruta/a/chrome bun scripts/slates-e2e.mjs`. Usa dos compositores y receptores RTMP locales, y mide en los MP4 el temporizador, el silencio del micrófono y la música.

Prueba del envío local: `CHROMIUM_PATH=/ruta/a/chrome bun scripts/local-stream-e2e.mjs`. Arranca el lanzador con datos aislados, comprueba el compositor del navegador, la recepción RTMP de H.264/AAC y la grabación MP4; no usa tu clave ni publica en plataformas reales.

Prueba de navegador: `bun run dev --smoke` (con puertos libres y Chromium instalado). `BUN_CHROME_PATH` o `CHROMIUM_PATH` permiten seleccionar el ejecutable. Usa dispositivos simulados; no abre los dispositivos físicos. Comprueba acceso, previsualización, permisos independientes y dos participantes WebRTC. Las capturas se guardan en `runtime/review/smoke-desktop.png` y `smoke-mobile.png`.

## Desarrollo y pruebas

```bash
cargo test --locked
cd frontend
bun install --frozen-lockfile
bun run sdk
bun run build
bun test
```

`bun run sdk` descarga el bundle UMD de `livekit-client@2.23.0`, verifica su integridad SHA-512 contra el registro npm y lo copia a `public/`. La imagen web lo hace automáticamente. El navegador carga ese archivo desde el propio servidor; no usa CDN, fuentes remotas ni servicios multimedia de pago.

Para desarrollo del panel, inicia backend con las variables de `.env`, `PUBLIC_ORIGIN=http://localhost:5173`, `LISTEN_ADDR=127.0.0.1:8080`, `DATA_DIR=runtime/data` y `RECORDINGS_DIR=runtime/recordings`. Después ejecuta `bun run dev` en `frontend/`. Para medios reales configura además un LiveKit accesible y `RENDERER_URL` alcanzable desde Egress. `MASTER_KEY` debe seguir siendo la misma para una base existente.

Verificación conjunta: `bash scripts/check.sh`. Las pruebas de backend usan el router en memoria, por lo que no requieren sockets ni Docker. La selección de pistas se prueba también desde frontend. La aceptación en navegador y con servicios reales se describe por separado.

Contrato API: [docs/openapi.json](docs/openapi.json), disponible también en `/api/v1/openapi.json`. Arquitectura y decisiones: [docs/architecture.md](docs/architecture.md).

## Calidad de la cámara

La calidad de cámara y de audio se elige ya en **Probar cámara y micrófono** (antes de conectar) y se guarda para la sesión y la conexión; la vista previa se rehace al cambiarla y muestra lo que entrega la cámara. Audio: **Voz clara** (cancelación de eco, supresión de ruido y ganancia automática, 48 kb/s) o **Estudio** (sin procesado, 96 kb/s; usa auriculares para evitar eco). El botón **Calidad de cámara** (debajo del programa) muestra lo que entrega el dispositivo y deja elegir Automática (1080p), 720p30, 1080p30, 1080p60, 1440p30 o 4K30; las que la cámara no soporta aparecen desactivadas. La elección se guarda en el navegador y se vuelve a publicar la cámara al aplicarla. Antes la app pedía siempre 1280×720, que luego se ampliaba dentro de la escena de 1080p (aspecto pixelado); además el compositor reescala ahora con suavizado de alta calidad. Más calidad = más subida de red y más CPU: con 4K no se ha medido el coste, y con los efectos de fondo conviene 1080p o menos.

## Emisión a varias plataformas

En **Configuración → Destinos de transmisión** se añaden hasta **5 destinos simultáneos**. Plataformas: YouTube, Twitch, Facebook, Kick, X, Instagram, TikTok, LinkedIn y Personalizado. YouTube, Twitch y Facebook incluyen servidor predeterminado; puedes sustituirlo por el que indique el panel de la plataforma. Los demás requieren URL y clave. Cada destino permite elegir **16:9 (1920×1080)** o **9:16 (1080×1920)** y editar nombre, servidor, clave y formato con el directo parado. Las credenciales se cifran con `MASTER_KEY` y nunca vuelven a mostrarse.

En el estudio, **Composición** cambia entre el programa horizontal y el vertical, que tienen cámaras, contenido, fondo y revisiones independientes. Puedes copiar una composición a la otra, guardar hasta **20 escenas** y volver a cualquiera con **Usar escena**, también durante el directo (el público ve el cambio al instante). Cada escena guarda cámaras, diseño, contenido, logo y fondo; el panel muestra un esquema y un resumen de cada una, y **Actualizar** la reemplaza por el programa actual. Al retirar un participante, se elimina de ambos programas y de las escenas guardadas. Los archivos utilizados por cualquiera de ellos quedan protegidos contra borrado.

Se codifica **una vez por formato activo**, no por plataforma. Usar ambos formatos crea dos compositores (y dos MP4 si grabas), y aumenta CPU, memoria y subida de red. Con el motor local la grabación copia esa misma codificación: añade escritura en disco, no otra codificación. Grabar sin emitir evita la subida de red y los publicadores RTMP. Solo grabar sin destinos usa 16:9; con destinos activos usa sus formatos. La salida usa H.264/AAC a 30 fps y fotogramas clave cada 2 segundos. Con Facebook activo se limita a 6000 kbps de vídeo y 128 kbps de audio; con Twitch activo se limita el vídeo a 6000 kbps. Los límites se calculan por formato. La calidad de captura de la cámara sigue siendo independiente de la salida.

Cada destino muestra Preparado, Conectando, Enviando señal, Reconectando o Sin señal. En escritorio, cada publicador RTMP copia el vídeo y audio codificados a través de una cola limitada, con plazos de escritura y reconexión automática. Una conexión caída no bloquea las demás ni el MP4. **Reintentar** actúa sobre el destino seleccionado; en servidor utiliza `UpdateStream` de Egress sin volver a añadir las salidas sanas. «Enviando señal» confirma actividad del publicador; la recepción pública final se comprueba en el panel de la plataforma.

API: `GET/POST /api/v1/destinations`, `PATCH/DELETE /api/v1/destinations/{id}`, `PUT /api/v1/program?format=landscape|portrait`, `POST /api/v1/scenes`, `POST /api/v1/scenes/{id}/activate`, `PUT /api/v1/scenes/{id}` (reemplaza por el programa actual), `DELETE /api/v1/scenes/{id}`, `POST /api/v1/broadcast/retry?destination_id={id}`. Los estudios anteriores conservan sus destinos como horizontales.

La conexión sigue siendo por URL y clave; OAuth y gestión de eventos mediante las APIs de YouTube/Twitch no están implementados. Las pruebas locales no certifican recepción en plataformas reales. Algunas cuentas necesitan acceso a emisión por RTMP. La composición doble en servidor requiere capacidad para dos trabajos de Egress y sigue pendiente de validación en VPS.

## Modo escritorio (Electron)

La app de escritorio (`desktop/electron`) lleva Chromium, así que WebRTC, `MediaRecorder` y captura de pantalla funcionan igual en Linux, Windows y macOS. (Se descartó Tauri: la webview WebKitGTK de Fedora no expone `RTCPeerConnection`.)

- Arranca `livekit-server` y el backend (`ENGINE=ffmpeg`) en localhost; cada formato activo tiene una ventana oculta de composición y una codificación ffmpeg a MP4 + RTMP. Sin Egress, Redis ni nube.
- **Cuenta de esta app.** Cada instalación crea al primer arranque su propia clave de acceso (en `secrets.json`) y en cada arranque un token aleatorio que el proceso principal canjea por la sesión de administrador: en la app no se escribe ninguna clave. La primera vez aparece una **bienvenida** que pide nombre, estudio o canal y rol, y muestra la clave. El botón de la barra lateral abre **Configuración → Tu perfil**, donde se editan esos datos y se ve, copia o regenera la clave (regenerarla cierra las sesiones de administrador abiertas en otros navegadores; la app sigue dentro). En la app no existe «Cerrar sesión»: si la sesión se pierde, vuelve a entrar sola con su token. La clave solo hace falta para abrir el estudio desde otro navegador o equipo (también en el menú *StreamHive → Mostrar clave de acceso de esta app*). En navegador o servidor la bienvenida no es obligatoria y se mantiene «Cerrar sesión».
- Desarrollo: `bun scripts/desktop-sidecars.mjs && cd desktop/electron && npm install && npm run pack`; prueba E2E: `bun scripts/electron-e2e.mjs` (con `E2E_PACKAGED=<ejecutable>` para la app empaquetada).
- Invitados en la LAN: `STREAMHIVE_LAN=1`. **Limitación:** sin HTTPS los navegadores no dan cámara/micrófono fuera de `localhost`.
- **ffmpeg y licencias:** el script empaqueta por defecto un ffmpeg **LGPL** estático (BtbN, verificado por SHA-256, sin x264) con codificación por GPU (VA-API, NVENC, QSV, AMF) y **OpenH264** de respaldo por CPU; comprueba al empaquetar que el binario no sea GPL. `FFMPEG_FLAVOR=gpl` elige el build con libx264 (obliga a cumplir la GPL al redistribuir). **macOS no tiene aún un build LGPL verificado** (se rechaza el ffmpeg del sistema si es GPL). Detalle y avisos de patentes H.264 en `packaging/THIRD_PARTY_NOTICES.md`.
- Iconos de distribución: una única fuente (`frontend/public/branding/icon-512.png`) genera PNG de 16–512 px para Linux, ICO multirresolución para Windows e ICNS para macOS. Se incluyen en el repositorio y se seleccionan explícitamente en `electron-builder.yml`. Para regenerarlos: `python3 -m pip install Pillow` y `python3 scripts/desktop-icons.py`. `bun scripts/check-desktop-icons.mjs` verifica que estén presentes y actualizados antes del empaquetado y en CI. La ventana usa el PNG incluido en `resources`; Windows comparte el AppUserModelId con el instalador y Linux comparte `streamhive-desktop` con su archivo `.desktop`.
- Sin firmar: macOS y Windows mostrarán avisos de seguridad hasta configurar firma/notarización.
- `.github/workflows/desktop.yml` genera los instaladores; solo se ha probado Linux. Con una etiqueta `vX.Y.Z` publica además la Release de GitHub con ellos (macOS es experimental: si falla, la Release sale sin él).
- **Publicar una versión:** `bun run release 1.0.0` (o `bun scripts/release.mjs 1.0.0`). Comprueba que `master` esté limpio, al día con GitHub y con el CI en verde; pone el número en `desktop/electron`, `frontend`, `backend` y `sessions` (con `package-lock.json` y `Cargo.lock`); pide confirmación; crea el commit `release: v1.0.0` y la etiqueta, y lo sube. `--sessions` publica también la imagen del servidor de sesiones (`sessions-v1.0.0`), `--dry-run` solo muestra lo que haría. Si algo falla antes de subir, deja el repositorio como estaba.

### Monitor de recursos y banco de pruebas

- El estudio muestra un indicador `CPU x% · RAM y%` (solo administrador) que abre un panel con CPU, memoria, disco libre, estado del codificador (fps, velocidad, frames perdidos), quién consume qué (app, servidor, LiveKit, ffmpeg) y un consejo de capacidad ("puedes invitar a unas N personas más", estimación orientativa). API: `GET /api/v1/resources`.
- `bun scripts/electron-bench.mjs [segundos]` mide la app empaquetada con 0-5 invitados sintéticos (`BENCH_CPUS=0-3` limita núcleos, `BENCH_VIDEO=<y4m>` usa vídeo con movimiento, `BENCH_SOAK=<s>` añade una prueba de resistencia). Los invitados corren en la misma máquina; el coste de StreamHive se mide aparte del total.
- Resultados en una máquina de 32 hilos / 126 GB (Linux, libx264 `veryfast`, 1080p30, vídeo con movimiento): ≈1,0-1,5 núcleos y ≈1,9 GB de RAM de StreamHive con 5 invitados, codificador a 1,0x, 0 frames perdidos, MP4 y RTMP a 30 fps exactos, sin crecimiento de memoria en 4 min. Limitada a 4 núcleos el resultado fue el mismo. **No se ha medido en equipos modestos reales, con webcams reales, compartir pantalla ni directos de horas.**

## Licencia

StreamHive es software libre bajo la **licencia MIT** — ver [`LICENSE`](LICENSE). Copyright © 2026 Johpaz/StreamHive contributors.

Los componentes de terceros que se distribuyen con la app (ffmpeg LGPL, LiveKit, Electron/Chromium, OpenH264, etc.) tienen sus propias licencias: ver
[`packaging/THIRD_PARTY_NOTICES.md`](packaging/THIRD_PARTY_NOTICES.md). Si empaquetas el ffmpeg GPL opcional (`FFMPEG_FLAVOR=gpl`), ese binario queda
sujeto a la GPL aunque el resto del proyecto sea MIT.

El logotipo y los fondos de escenario se generaron con IA (Codex): su origen y las salvedades sobre derechos de autor están en la sección "Imágenes y recursos gráficos" de ese mismo archivo.

## Servidor de sesiones propio (VPS)

La app permite configurar **solo la URL** de un servicio `streamhive-sessions` desplegado por el usuario. Ofrece invitaciones HTTPS, sala de espera y admisión con credenciales automáticas por instalación. Es independiente del transporte de audio/vídeo; esta versión del servicio no añade cámaras remotas ni guarda grabaciones.

Consulta [el despliegue con Traefik o Caddy](deploy/sessions/README.md), [la especificación de API](sessions/openapi.json) y [las mediciones y pruebas](docs/session-service-validation.md). La variante Traefik utiliza por defecto la red externa `n8n_evoapi` y el resolver `mytlschallenge`. Incluye construcción local de imagen y workflow de publicación en Docker Hub; no requiere instalar otra base de datos ni un proxy adicional cuando ya existe Traefik.

### Chat del estudio

El anfitrión y los invitados admitidos disponen de un chat flotante con una abejita animada: burbuja con no leídos, ventana mediana y vista completa. Conserva el historial al reconectar y permite al anfitrión borrar mensajes. Funciona en modo local y en el portal de sesiones remotas; consulta [uso, arquitectura y validación](docs/chat-general.md). Prueba aislada de navegador: `bun run test:chat`.
