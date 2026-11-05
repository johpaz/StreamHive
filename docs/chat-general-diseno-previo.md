# Chat general del estudio

Diseño: 2026-11-05. Este documento describe el chat interno que se va a construir. Todavía no está implementado.

## Objetivo

Es un canal de administración y comunicación durante el directo, con tres participantes:
- **Anfitrión.**
- **Invitados admitidos.**
- **Invitados en sala de espera**, que también leen y escriben en el chat completo.

Sirve para coordinar la emisión y compartir materiales: archivos y enlaces.

**El chat nunca sale al aire ni queda en la grabación.**

## Decisiones

| Tema | Decisión |
| --- | --- |
| Moderación | El anfitrión siempre modera. Puede nombrar moderador a uno o más invitados de apoyo y retirarles el cargo. |
| Sala de espera | Los invitados en espera ven el chat completo y escriben en él. |
| Historial | Se guarda solo en memoria y se pierde al reiniciar el backend. Se conservan los últimos 300 mensajes. |
| Materiales | Admite adjuntos y enlaces `http(s)` clicables. |

## Transporte: backend local en lugar de LiveKit

LiveKit ofrece flujos de texto (`sendText` y `registerTextStreamHandler`; ver https://docs.livekit.io/home/client/data/text-streams/) y paquetes de datos. Sin embargo, solo los reciben quienes están conectados a la sala. Por eso no se usa:
- Los invitados en sala de espera no tienen token multimedia ni entran a la sala, a propósito.
- `backend/src/livekit.rs` concede `canPublishData: false`. Abrir ese permiso a invitados les permitiría enviar datos que no pasan por la moderación.
- La moderación (borrar, silenciar, vaciar) y el límite de frecuencia necesitan un punto central que haga cumplir las reglas.

El chat va por la API del backend, con la misma cookie de sesión que el resto del estudio.

**Avisos:** el WebSocket `/api/v1/events` ya existente avisa de los cambios con un mensaje tipado `chat`. Con ese aviso, el cliente pide solo el chat y no vuelve a cargar `/studio` entero. Los clientes que solo reconocen `refresh` siguen funcionando igual.

## Permisos

| Acción | Anfitrión | Moderador | Invitado (admitido o en espera) | Retirado |
| --- | --- | --- | --- | --- |
| Leer el chat | sí | sí | sí | no |
| Escribir y adjuntar | sí | sí | sí, salvo si está silenciado | no |
| Borrar un mensaje propio | sí | sí | sí | no |
| Borrar cualquier mensaje | sí | sí | no | no |
| Silenciar o reactivar a un invitado | sí | sí, salvo a otro moderador | no | no |
| Vaciar el chat | sí | sí | no | no |
| Nombrar o retirar moderadores | sí | no | no | no |

Otras reglas:
- Un invitado retirado pierde el acceso al instante, igual que en el resto de la API.
- Retirar a un invitado le quita también el cargo de moderador.

## API

| Método y ruta | Uso |
| --- | --- |
| `GET /api/v1/chat` | Mensajes, moderadores, silenciados y permisos propios |
| `POST /api/v1/chat` | `{text, attachment?}` envía un mensaje |
| `DELETE /api/v1/chat/{id}` | Borra un mensaje |
| `POST /api/v1/chat/clear` | Vacía el chat y sus adjuntos |
| `PUT /api/v1/chat/mute/{participant}` | `{muted}` silencia o reactiva |
| `PUT /api/v1/participants/{id}/moderator` | `{moderator}`, solo el anfitrión |
| `POST /api/v1/chat/files` | Sube un adjunto (cuerpo binario, nombre en `x-file-name` en base64) |
| `GET /api/v1/chat/files/{id}` | Descarga el adjunto |

**Límites de los mensajes:**
- Hasta 2000 caracteres, sin caracteres de control salvo el salto de línea.
- Como máximo 10 mensajes cada 10 segundos por persona.
- No se permiten mensajes vacíos sin adjunto.

## Adjuntos

**Tipos admitidos:**
- PDF.
- Imágenes PNG, JPG y WebP.
- Texto plano y CSV.
- ZIP.
- Documentos de Office (DOCX, XLSX, PPTX).
- ODF (ODT, ODS, ODP).

**Comprobación del tipo:** se mira la firma de los primeros bytes, no solo la extensión ni el `Content-Type` que manda el navegador. Los documentos de Office y ODF tienen la firma ZIP.

**Límites:**
- 25 MB por archivo.
- 200 MB en total; al pasarse, se descartan los adjuntos más antiguos junto con su mensaje.

**Almacenamiento:** los archivos se guardan en una carpeta temporal del backend que se vacía al arrancar y al vaciar el chat. No van a la biblioteca de archivos del estudio.

**Descarga:**
- Siempre como `Content-Disposition: attachment`, con `X-Content-Type-Options: nosniff` y una CSP restrictiva. Así, un archivo nunca se ejecuta dentro del origen del estudio.
- Las imágenes se muestran en miniatura.
- Solo pueden descargarlas quienes tienen acceso al chat.

**Borrado:** borrar un mensaje borra también su adjunto.

## Enlaces

- Solo se convierten en enlace las URL `http://` y `https://`. Se abren con `target="_blank" rel="noopener noreferrer"`.
- El texto se pinta como texto, nunca como HTML.
- Las URL `javascript:` y `data:` se quedan como texto.

## Interfaz

**Anfitrión, fuera del modo foco:** un botón **Chat** con un contador de mensajes no leídos abre un panel lateral.

**Anfitrión, en modo foco:** el chat es una pestaña más del panel lateral, junto a Escenas, Fuentes y Ajustes.

**Invitado:** el mismo panel, tanto en la página de sala de espera como dentro del estudio.

**En cada mensaje aparecen:**
- Autor, con la etiqueta *Anfitrión* o *Moderador* cuando corresponde.
- Hora.
- Texto con enlaces.
- Adjunto, si lo hay, con su nombre, tamaño y botón de descarga.

**Acciones de moderación:**
- En el mensaje, un menú permite borrarlo o silenciar al autor.
- En el menú ••• del participante: **Hacer moderador** / **Quitar moderador**.

**Avisos:**
- Un invitado silenciado ve un aviso en lugar del cuadro de texto.
- El panel recuerda que el chat no sale al aire ni se graba.

## Invitados por internet (servicio de sesiones)

Hoy, los invitados que entran por el servicio de sesiones del VPS (`sessions/`, `backend/src/remote.rs`) solo pasan por su sala de espera y su admisión. Todavía no se unen al estudio local: ver `docs/remote-guests.md` y `sessions/README.md`.

**Primera fase:** el chat cubre al anfitrión y a los invitados locales o de la red, que son quienes usan hoy la API del estudio.

**Para incluir a los invitados del VPS** hace falta un relé:
1. El servicio de sesiones expone `GET/POST /api/v1/guest/chat` al invitado.
2. Reenvía mensajes y adjuntos por el canal saliente que mantiene el escritorio.
3. El backend local sigue siendo la única fuente de verdad y de moderación.

Esta fase se hará cuando los invitados remotos se conecten al estudio con audio y vídeo.

## Verificación

**Pruebas de Rust:**
- Permisos de cada rol, incluidos el invitado en espera y el retirado.
- Silenciar.
- Moderador nombrado y retirado.
- Borrar y vaciar el chat, incluidos sus adjuntos.
- Límites de longitud y de frecuencia.
- Tipos de adjunto con firma falsa.
- Cabeceras de descarga.
- Tope de 300 mensajes y de tamaño total de adjuntos.

**`bun test`:** detección de enlaces y contador de no leídos.

**E2E con navegador:**
- Conversación entre anfitrión, invitado admitido e invitado en espera.
- Material compartido y descargado.
- Moderación por un invitado moderador.
- Comprobación de que el chat no aparece en los fotogramas del MP4 grabado.
