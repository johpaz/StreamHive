# Verificación y aceptación

## Ejecutado en este entorno

- Compilación del backend Rust y pruebas unitarias/de API contra el router en memoria.
- TypeScript y construcción Vite de producción.
- Pruebas de selección de pistas: exclusión de participantes fuera del programa, micrófonos en protagonista y audio de pantalla habilitado explícitamente.
- Pruebas de generación de configuración y correspondencia de credenciales.

Se verificó el arranque local con `bun run dev`, la respuesta de salud y el acceso autenticado. Se descargaron y verificaron el SDK multimedia y el binario oficial de LiveKit v1.13.11.

La prueba `bun run dev --smoke` pasó en Chromium con dispositivos simulados: enumeración de micrófono/cámara, captura privada, cámara operativa con micrófono denegado, conexión real a LiveKit, espera sin token multimedia, admisión de invitado, dos cámaras WebRTC recibidas en el programa y distribución móvil sin desbordamiento horizontal. Se conservaron capturas en `runtime/review/` y se cerraron las fuentes de prueba al finalizar.

Faltan la comprobación de los dispositivos físicos del usuario, Safari/iOS, TURN/TLS, emisión RTMP, grabación Egress y carga de dos horas. Docker no está instalado y Podman no puede iniciar contenedores desde esta sesión. La prueba local de dos participantes no certifica el despliegue multimedia completo.

## Emisión simultánea y escenas por formato (2026-11-01)

Pasaron las pruebas de extremo a extremo `scripts/dual-format-e2e.mjs` (web con Chromium) y `scripts/multistream-e2e.mjs` (Electron real con cámara y micrófono simulados). Usan LiveKit y FFmpeg reales, servidores RTMP locales y datos aislados de la web del usuario.

- Dos compositores simultáneos: 1920×1080 y 1080×1920, con identidades LiveKit distintas.
- Tres destinos activos: dos reciben señal mientras el tercero permanece caído y se informa por separado.
- Recuperación automática del destino ausente; corte y recuperación manual de la salida vertical sin reiniciar la emisión ni interrumpir la horizontal.
- Cuatro archivos recibidos por RTMP, incluyendo las dos recuperaciones, con H.264/AAC y dimensiones correctas.
- Dos grabaciones MP4 reproducibles. En Electron ambas duraron aproximadamente 33 segundos y ocuparon aproximadamente 25 MB cada una.
- Escenas guardadas y cambio independiente de formato desde la interfaz; selección del formato y edición de credenciales de destinos.
- Escenas sin micrófonos también emiten: un generador de silencio mantiene la pista de audio activa.
- Los colores distintos de las escenas web se comprobaron por píxeles en ambos MP4, además de comprobar sus dimensiones.

La verificación automatizada del proyecto comprende 55 pruebas Rust, 40 de interfaz y 2 de configuración Python. La web local también pasó una comprobación de acceso, selección de ambos formatos y configuración de destinos en Chromium. Sigue pendiente comprobar recepción en plataformas externas y la composición doble en un despliegue Egress/VPS.

## Actualización de experiencia de producción

La prueba de Chromium verifica también subir una imagen de tutorial, mostrarla sin recortes, alternar contenido lateral/flotante/completo, mover la cámara flotante, subir un WebM real generado para la prueba, reproducirlo y pausarlo, retirarlo y regresar a dos cámaras 16:9. Hay pruebas de lectura de rangos autenticados, bloqueo de borrado de una fuente seleccionada y carga de datos SQLite anteriores a la biblioteca.

## Efectos de cámara y fondos de escenario

La galería verifica la decodificación de los cuatro fondos y miniaturas locales, conserva la selección al reabrir el diálogo y comprueba por píxeles que la oficina elegida llega al participante remoto solo después de Aplicar.

La prueba usa el modelo real de MediaPipe servido localmente: inicializa desenfoque, comprueba por píxeles que el fondo personalizado solo aparece en la vista privada antes de Aplicar y después llega a la cámara remota mediante WebRTC. Verifica Cancelar, restablecer Sin efecto, apagar/encender cámara con el fondo activo y efectos independientes de un invitado en una pantalla móvil. El fondo de escenario se carga desde la biblioteca, se sincroniza al invitado y queda protegido contra borrado mientras está seleccionado. Hay pruebas de rechazo de videos como fondo, acceso del renderer limitado a imágenes seleccionadas y exclusión del procesador para pantalla compartida.

Estas pruebas usan cámara sintética sin una persona; la calidad del recorte de cabello/cuerpo y el rendimiento con cámaras físicas deben revisarse en los equipos de los participantes.

## Procedimiento obligatorio en VPS antes de producción

Realiza primero una emisión de prueba no pública. Anota fecha, versiones, CPU, RAM, ancho de banda y dispositivos utilizados. Guarda el MP4 y métricas de carga para contrastar cada actualización.

| Escenario | Resultado esperado |
| --- | --- |
| Instalación limpia | Compose valida; certificados emitidos; backend sano; LiveKit y Egress activos |
| Acceso | Contraseña incorrecta rechazada; invitado sin cuenta entra en espera; no recibe audio/video antes de ser admitido |
| Seis personas | Un anfitrión y cinco invitados admitidos; sexta admisión de invitado rechazada, incluso concurrentemente |
| Dos pantallas | Dos participantes publican pantalla; solo la seleccionada aparece; al finalizarla se vuelve a cuadrícula |
| Audio del programa | Invitado en sala fuera del programa conversa, pero no se escucha ni aparece en RTMP ni MP4 |
| Protagonista | Se ve la cámara elegida; continúan los micrófonos de las personas seleccionadas para el programa |
| Audio compartido | Desactivado por defecto; habilitado con pestaña compatible; al cambiar de composición deja de salir |
| Sin permisos | Rechazo de cámara/micrófono explicado; se puede reintentar sin recargar el estudio |
| Dispositivos | Cambio de micrófono/cámara; selección de altavoz donde el navegador lo soporte |
| Navegadores | Productor Chrome y Edge; invitados Chrome Android y Safari iOS con cámara y micrófono |
| TURN/TLS | En un equipo de prueba con UDP y TCP 7881 bloqueados, conexión relay sobre turn.dominio:443; confirmar estadísticas ICE |
| Emisión + MP4 | Recepción RTMP confirmada en la plataforma; MP4 reproducible con H.264/AAC y audio sincronizado |
| Pérdida de destino | Estado de destino fallido; archivo continúa creciendo si Egress sigue activo; reintento recupera la salida |
| Panel cerrado | La emisión y la grabación continúan; al volver se recuperan estado y controles |
| Backend reiniciado | Egress continúa; al volver se reconcilia el mismo identificador; no crea un segundo trabajo |
| Egress interrumpido | Estado de error/interrumpido; ningún archivo parcial se presenta como finalizado |
| Backend inaccesible al compositor | Imagen neutra y sin reproducción de audio mientras no puede verificar la selección |
| Poco disco | Sin reserva inicial se rechaza inicio; por debajo de 1 GB se solicita parada y finalización |
| Biblioteca | Descargar solo archivos completos; no borrar una grabación activa; borrado manual libera espacio |
| Restauración | Catálogo, archivo descargado y destino cifrado se recuperan con las claves originales |

### Prueba continua de dos horas

1. Conecta seis personas y publica dos pantallas simultáneamente.
2. Emite 1080p30 y graba en disco durante dos horas, alternando escenas, protagonista y pantalla.
3. Realiza al menos una desconexión/reconexión de invitado, una pérdida breve de red del productor y cierre/reapertura del panel.
4. Mide latencia conversacional: objetivo inferior a 500 ms bajo la red de prueba. Cambios de programa: objetivo inferior a un segundo hasta el compositor. La plataforma RTMP añadirá su propia latencia.
5. Comprueba CPU/RAM, disco y pérdidas de cuadros; no debe haber agotamiento de recursos ni crecimiento descontrolado de memoria.
6. Valida parada automática a las dos horas desde la solicitud, finalización del MP4, duración, sincronización y ausencia de participantes fuera del programa.
7. Si falla capacidad o sincronización, no declares aprobado el perfil: ajusta recursos o bitrate y repite el ensayo afectado.
