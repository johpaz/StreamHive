# Invitados remotos en StreamHive Desktop

Investigación: 2026-11-01. Propuesta de arquitectura; no se han desplegado servicios ni cambiado las conexiones de la app.

## Estado del código

- `desktop/electron/main.js` arranca backend y LiveKit en el PC del anfitrión. Su origen predeterminado es `http://localhost:<puerto>` y los candidatos multimedia locales usan `127.0.0.1`.
- `backend/src/main.rs::invite` genera `/join/<token>` sobre `INVITE_ORIGIN`. El enlace caduca a las 24 horas; existen revocación, sala de espera y admisión.
- Compartir una URL de localhost con otro PC apunta al PC del invitado, no al anfitrión.
- `STREAMHIVE_LAN=1` configura una IP privada, HTTPS y un enlace LAN. Su CA propia requiere instalar confianza en cada dispositivo. Falta una experiencia de configuración desde la interfaz y validación entre equipos físicos.
- `/lk` permite publicar la señalización HTTP/WebSocket bajo el origen de la aplicación. No transporta automáticamente el audio/vídeo WebRTC ni convierte candidatos locales en rutas accesibles desde internet.
- El lanzador fuerza un LiveKit local: para conectar a un servicio remoto hay que añadir selección explícita de infraestructura y credenciales, no solo un enlace público.
- La sala LiveKit y las identidades `host`, `EG_recorder` y `EG_recorder_portrait` son fijas. Un servicio compartido por instalaciones necesita aislamiento por estudio/sesión y participantes únicos.

## Alternativas

| Alternativa | Uso | Limitación |
| --- | --- | --- |
| LAN con HTTPS local | Participantes en la misma red | Confianza del certificado, firewall e IP local; no resuelve invitados por internet |
| LiveKit en el PC expuesto a internet | Instalación autogestionada | Dominio, certificados, puertos de router, dirección pública, NAT/CGNAT y TURN; exige mantenimiento de red |
| Túnel HTTPS al backend + LiveKit público | Prototipo remoto sobre el flujo existente | Hay que integrar el túnel y configurar un servidor multimedia accesible; publicar la web no publica WebRTC |
| Portal público de invitados + API de salas + LiveKit público | Producto distribuido recomendado | Infraestructura compartida, autenticación por instalación y coste de tráfico |

## Diseño recomendado

La app de escritorio conserva escenas, composición 16:9/9:16, FFmpeg, grabaciones y salidas RTMP. Un servicio público atiende la entrada de invitados y el transporte de audio/vídeo.

1. El anfitrión abre una sesión remota autenticada desde la app. La app mantiene una conexión WSS saliente al servicio de coordinación, con reconexión y latidos.
2. El servicio crea una sala exclusiva y una invitación HTTPS con token opaco, vencimiento y revocación. Las credenciales administrativas de LiveKit permanecen en el servidor.
3. El invitado abre el enlace en su navegador, escribe su nombre y prueba cámara/micrófono. No instala la app ni recibe la contraseña del anfitrión.
4. La solicitud llega al escritorio por el canal de control. La admisión permite solicitar un JWT breve limitado a esa sala y a sus permisos.
5. Invitado, anfitrión y compositores se conectan al mismo LiveKit público mediante WebRTC. TURN/TLS ofrece una ruta alternativa en redes que bloquean UDP.
6. El anfitrión selecciona quién entra a cada programa. La codificación, grabación y publicación siguen realizándose en su PC.
7. Al retirar un invitado o cerrar la sesión se revoca la autorización, se impide renovar tokens y se desconectan los participantes que corresponda. Un corte de red se distingue de un cierre explícito para permitir recuperación sin conceder acceso indefinido.

La nube no necesita codificar ni grabar el programa. LiveKit sí procesa y distribuye medios: hay consumo de ancho de banda y dependencia de conectividad. No debe prometerse cifrado de extremo a extremo sin implementar y comprobar E2EE.

## Trabajo necesario

- Selector de modo local / misma red / invitados por internet en Electron.
- Registro y autenticación del escritorio; sesiones y salas únicas por estudio.
- Portal de invitados con HTTPS confiable, sala de espera y estados de anfitrión disponible/desconectado.
- Canal de control saliente escritorio-servidor; admisiones, expulsiones, revocaciones y recuperación.
- Servicio de emisión de tokens limitado por sesión; claves administrativas fuera del instalador y del navegador.
- Configuración remota de LiveKit para anfitrión y ambos compositores; conservar el modo local.
- LiveKit público propio o administrado, con TURN/TLS accesible. Comprobar capacidad y tráfico con participantes reales antes de escoger un plan.
- Pruebas desde dos redes distintas: móvil, router doméstico, redes restrictivas, anfitrión tras CGNAT, desconexión/reconexión, revocación y aislamiento entre estudios.

Para una primera prueba técnica puede utilizarse un túnel HTTPS hacia el backend local más un LiveKit público. Para distribuir la app conviene el portal y el canal saliente, sin exponer el panel administrativo local del usuario.

## Fuentes oficiales

- HTTPS y permisos de cámara/micrófono: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Despliegue, dirección pública y TURN de LiveKit: https://docs.livekit.io/transport/self-hosting/deployment/
- Puertos de señalización, ICE y TURN: https://docs.livekit.io/transport/self-hosting/ports-firewall/
- Tokens limitados a sala y permisos: https://docs.livekit.io/frontends/reference/tokens-grants/
- Generación de tokens en backend: https://docs.livekit.io/frontends/build/authentication/
- Modelo de conexión saliente de Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/
- Protocolos de aplicaciones publicadas: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- Quick Tunnels son temporales y para pruebas: https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/
