# Diagnóstico de YouTube en la web local

Revisión: 2026-11-03.

El lanzador `scripts/dev.mjs` no seleccionaba motor de salida: el backend utilizaba su valor predeterminado `egress`. Sin embargo, el lanzador solo iniciaba API, Vite y LiveKit; no iniciaba Egress ni Redis. Guardar una clave no podía resolver esa dependencia. Ahora el lanzador elige `ENGINE=ffmpeg` por defecto, comprueba que FFmpeg esté disponible y conserva `ENGINE=egress` como opción explícita para un motor externo.

El compositor de navegador ya estaba implementado en `frontend/src/desktop.tsx`: abre un iframe por formato y envía el programa al backend mediante WebSocket. Con el motor correcto, FFmpeg produce H.264/AAC y publica los destinos habilitados. En este modo el estudio debe mantenerse abierto. Los datos y las claves previamente guardadas no se modifican.

## Comparación con OBS

El preset RTMPS de YouTube en OBS utiliza `rtmps://a.rtmps.youtube.com:443/live2`, igual que StreamHive. La clave se añade a la ruta. YouTube exige TLS en el puerto 443 y SNI del servidor. La copia de FFmpeg examinada incluye salida RTMPS y TLS. La codificación local usa H.264/AAC, CBR y un GOP de dos segundos, compatibles con las indicaciones de YouTube.

Hay dos acciones distintas: guardar servidor/clave y enviar señal. El inicio del envío se hace con **Iniciar directo**. La sala de control de YouTube debe mostrar la vista previa. Si el inicio automático no está activado, también hay que pulsar **Emitir en directo** en YouTube Studio. OAuth no es un requisito para emitir mediante una clave; la creación y gestión de eventos con la API de YouTube no están implementadas.

## Comprobación

`CHROMIUM_PATH=/ruta/a/chrome bun scripts/local-stream-e2e.mjs` inicia el lanzador real sin definir ENGINE, con datos y puertos aislados. Verifica compositor del navegador, recepción RTMP H.264/AAC a 1920×1080 y grabación MP4. Se ejecutó satisfactoriamente sin desactivar las restricciones normales de autoplay de Chromium. Evidencia: `/tmp/sh-local-stream-kz0Bvd`.

La prueba no utiliza la clave guardada del usuario ni publica en su canal. No confirma su clave, habilitación de directos, recepción de YouTube o conectividad del puerto 443 desde su equipo. Si YouTube sigue sin mostrar vista previa tras iniciar, hace falta identificar el estado del destino (conectando/reconectando/emitiendo) y el mensaje de la sala de control. El publicador actual descarta stderr de FFmpeg, por lo que todavía falta un diagnóstico detallado por destino que filtre secretos antes de mostrarlos; no se afirma que el fallo remoto esté resuelto solo por esta prueba local.

Fuentes primarias consultadas:

- [Presets del código de OBS](https://github.com/obsproject/obs-studio/blob/master/plugins/rtmp-services/data/services.json).
- [Ingesta RTMPS de YouTube](https://developers.google.com/youtube/data/live/guides/rtmps-ingestion).
- [Configuración del codificador](https://support.google.com/youtube/answer/2853702?hl=es).
- [Emisión mediante codificador](https://support.google.com/youtube/answer/2907883?hl=es).
