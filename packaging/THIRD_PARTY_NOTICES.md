# Avisos de terceros

StreamHive es software libre bajo la **licencia MIT** (ver `LICENSE`). Lo que sigue son los componentes de terceros que se distribuyen con él, cada uno con su propia licencia.

StreamHive incluye y ejecuta, como **procesos independientes**, los siguientes programas de terceros.

## FFmpeg (LGPL v3)
- Build incluido por defecto: *ffmpeg-master-latest-{linux64,win64}-lgpl* de https://github.com/BtbN/FFmpeg-Builds, compilado **sin `--enable-gpl` ni x264**
  (`scripts/desktop-sidecars.mjs` lo verifica al empaquetar y se niega a continuar si el binario resulta ser GPL).
- Licencia: LGPL v3 (https://www.gnu.org/licenses/lgpl-3.0.html). FFmpeg: https://ffmpeg.org.
- **Código fuente:** https://github.com/FFmpeg/FFmpeg y los scripts de compilación exactos en https://github.com/BtbN/FFmpeg-Builds. Puedes pedir una copia
  del código correspondiente a la versión distribuida abriendo un issue en el repositorio de StreamHive. StreamHive lo ejecuta como proceso aparte (no lo enlaza).
- Componentes incluidos con otras licencias: OpenSSL 3 (Apache-2.0, RTMPS), **OpenH264** (BSD-2, codificador H.264 de respaldo por CPU),
  libvpl (MIT), SVT-AV1/libaom (BSD), libopus (BSD).
- **Patentes H.264:** la licencia de patentes gratuita de Cisco solo cubre los binarios de OpenH264 compilados y distribuidos por Cisco; el OpenH264 integrado
  en este ffmpeg está compilado por terceros. Los codificadores por hardware (VA-API, NVENC, QSV, AMF, VideoToolbox) usan los controladores del sistema.
  Este aviso no es asesoría legal: si distribuyes comercialmente, consulta tu situación de patentes H.264.
- *Opcional (no es el valor por defecto):* con `FFMPEG_FLAVOR=gpl` se empaqueta el build con **libx264 (GPL v3)**. Si lo distribuyes, quedas obligado a
  cumplir la GPL para ese binario (aviso, texto de la licencia y oferta de código fuente).

## LiveKit Server (Apache-2.0)
- https://github.com/livekit/livekit — release oficial, verificada por SHA-256.

## Electron / Chromium
- https://www.electronjs.org — MIT; Chromium y sus componentes mantienen sus propias licencias (`LICENSES.chromium.html` dentro de la app).

## Imágenes y recursos gráficos (generadas con IA)
- **Origen:** el logotipo de StreamHive y los fondos de escenario (`backgrounds/*.webp`) fueron **generados con inteligencia artificial por el autor, con Codex
  (herramienta de generación de imágenes de OpenAI) y su propia suscripción**. Las propuestas de logotipo y sus indicaciones (prompts) están en `output/branding/prompts.md`;
  los símbolos SVG de `frontend/public/branding/` son una reconstrucción vectorial de la propuesta 1 (Hive Play). Los prompts de los fondos no se conservaron.
- **Licencia:** se publican junto al resto del proyecto bajo la licencia MIT **en la medida en que el autor tenga derechos sobre ellas**. Ten en cuenta que el material
  generado únicamente con IA puede no estar protegido por derechos de autor en algunas jurisdicciones (la Oficina de Derechos de Autor de EE. UU. concluyó en 2025 que los
  prompts por sí solos no bastan para constituir autoría), de modo que el autor no reclama exclusividad sobre esas imágenes.
- **Condiciones del proveedor:** el uso de lo generado está sujeto a las condiciones de OpenAI vigentes en el momento de generarlo. Según los resúmenes consultados,
  OpenAI cede al usuario sus derechos sobre el *output* en la medida que permita la ley y permite su uso comercial, sujeto a su política de contenidos; esto **no está
  verificado en los documentos oficiales**, así que conviene confirmarlo en https://openai.com/policies antes de redistribuir las imágenes de forma comercial.
- Las imágenes que cada productor sube a su estudio (fondos, logo, vídeos) son suyas y no forman parte de este proyecto.
