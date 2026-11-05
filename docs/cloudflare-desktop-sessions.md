# Sesiones desde una app descargable mediante Cloudflare

Investigación: 2026-11-01. Diseño propuesto, sin cambios en DNS, túneles ni facturación.

## Respuesta a la idea

Sí: cada instalación puede abrir una conexión saliente y recibir un enlace bajo nuestro dominio. No hace falta registrar la IP doméstica en DNS. Una IP privada no es enrutable desde internet y una IP pública no garantiza entrada si hay NAT, CGNAT o firewall. El identificador estable debe ser la instalación autenticada y su conexión activa, no la IP.

Cloudflare Tunnel permite publicar HTTP y WebSocket de un proceso local. Un túnel administrado remotamente se ejecuta con su propio token. El servicio de registro, nunca el instalador, conserva las credenciales administrativas de Cloudflare.

## Aprovisionamiento por instalación

1. La app se registra ante un Worker con identidad de instalación y autenticación del propietario.
2. El Worker crea o reutiliza un túnel para esa instalación y configura su ruta a una pasarela local de invitados.
3. El DNS del subdominio apunta al destino del túnel, no a la IP del usuario. Ejemplo propuesto: `s-7fa9.tudominio.com`.
4. La app ejecuta un `cloudflared` empaquetado y verificado como proceso hijo, usando solo el token de ese túnel.
5. Crear una sesión produce una URL como `https://s-7fa9.tudominio.com/join/<token-opaco>`; las sesiones no requieren crear otro túnel ni otro registro DNS.
6. La pasarela local permite únicamente las rutas de invitado, con caducidad, revocación y autorización. No debe publicar toda la interfaz administrativa ni la entrada automática del escritorio.
7. La app supervisa el proceso, reconecta y comunica disponibilidad. Si se cierra, el invitado ve que el anfitrión no está disponible; el Worker puede servir esa página antes de reenviar al túnel.
8. Se revocan o rotan tokens de túnel y se eliminan instalaciones abandonadas. Un token de túnel no caduca automáticamente por terminar una invitación.

Un subdominio compartido con rutas `/s/<instalacion>/join/<token>` también es viable, pero necesita un Worker que resuelva las rutas hacia conexiones/túneles. DNS por sí solo no enruta por paths. Para el prototipo, un hostname de primer nivel por instalación evita requisitos de certificados de comodín de segundo nivel.

## El transporte de cámara y audio sigue siendo una decisión aparte

### Opción A: WebRTC entre invitado y escritorio, con TURN de respaldo

La página y las ofertas/respuestas de conexión viajan por HTTPS/WebSocket del túnel. Los medios se intentan enviar directamente entre el navegador del invitado y un `RTCPeerConnection` en Electron. ICE/STUN encuentra rutas; Cloudflare TURN retransmite cuando la conexión directa falla.

- Conserva composición, codificación, grabación y RTMP locales.
- No requiere un SFU nuestro ni un VPS público por usuario.
- Necesita sustituir o complementar el transporte remoto basado actualmente en LiveKit; no es una configuración de una variable.
- Para que los invitados se escuchen entre sí, hace falta implementar y probar el retorno de audio sin devolver a cada participante su propia voz. El vídeo de retorno y la subida del anfitrión deben presupuestarse.
- La prueba debe usar TURN forzado además de conexión directa y medir 1, 3 y 6 invitados reales. Que funcione con un invitado no certifica una conversación con varios.

Cloudflare TURN no hace que el servidor LiveKit local actual sea automáticamente accesible detrás de CGNAT. La opción A supone extremos WebRTC capaces de negociar y utilizar TURN; el servidor local actual necesita otro diseño de conectividad.

### Opción B: Cloudflare Workers + Durable Objects + Realtime SFU

El dominio sirve la página de invitados y un Worker atiende autenticación y operaciones multimedia. Un Durable Object mantiene los miembros y permisos de cada sesión. Invitados y escritorio abren conexiones WebRTC salientes a Cloudflare Realtime SFU.

- No necesitamos operar un VPS multimedia ni abrir puertos en routers domésticos.
- El programa y sus dos formatos se siguen produciendo en el PC; Cloudflare distribuye las pistas de los participantes.
- Para este flujo el túnel es opcional: la app puede sincronizar admisiones por WebSocket saliente y recibir pistas mediante la SFU.
- Requiere un adaptador multimedia diferente de LiveKit, con descubrimiento de pistas, suscripciones autorizadas, negociación, desconexión y reconexión.
- Cloudflare no concede permisos por conocer un `sessionId` o un nombre de pista: nuestro Worker debe autorizar cada operación y guardar el App Secret fuera de la app y del navegador.

## Recomendación de prueba

Probar primero la idea concreta del usuario: registro de instalación, túnel propio, hostname y enlace con invitación limitada; después, una conexión invitado-escritorio P2P con TURN forzado. Conservar el modo local existente. Si las mediciones de conversación grupal y subida del anfitrión no son suficientes, usar Realtime SFU sin cambiar la experiencia de enlaces ni la producción local.

No dar por completada la función hasta verificar desde otra conexión a internet, detrás de CGNAT, con UDP bloqueado y con dos instalaciones simultáneas sin cruce de participantes.

## Límites y costes consultados

- Tunnels for Platforms documenta 1.000 túneles incluidos por cuenta; los túneles adicionales cuestan 4,50 USD/mes cada uno. Los túneles inactivos también cuentan. Esta cuota es de la cuenta compartida, no de cada usuario de StreamHive.
- Realtime SFU y TURN comparten una franquicia de 1.000 GB/mes de salida y después cuestan 0,05 USD/GB según la tarifa consultada. Workers y Durable Objects tienen su propia facturación.
- El modo P2P directo reduce el tráfico multimedia retransmitido, pero TURN no puede suponerse innecesario ni gratuito a cualquier escala.

## Documentación oficial consultada

- https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/
- https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/
- https://developers.cloudflare.com/tunnel/get-started/
- https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- https://developers.cloudflare.com/realtime/turn/
- https://developers.cloudflare.com/realtime/turn/generate-credentials/
- https://developers.cloudflare.com/realtime/sfu/concepts/architecture/
- https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/
- https://developers.cloudflare.com/realtime/sfu/platform/pricing/
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/
- https://developers.cloudflare.com/ssl/edge-certificates/advanced-certificate-manager/
