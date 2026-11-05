import type { Asset } from "./types";
export function uploadAsset(
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<Asset> {
  return new Promise((resolve, reject) => {
    const mime =
      file.type ||
      (
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          mp4: "video/mp4",
          webm: "video/webm",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
          wav: "audio/wav",
          m4a: "audio/mp4",
        } as Record<string, string>
      )[file.name.split(".").at(-1)?.toLowerCase() || ""];
    if (!mime) {
      reject(
        Error(
          "Usa imágenes PNG/JPG/WebP, videos MP4/WebM o audio MP3/OGG/WAV/M4A. Para manuales PDF, comparte su ventana.",
        ),
      );
      return;
    }
    if (file.size > (mime.startsWith("image/") ? 20 : mime.startsWith("audio/") ? 50 : 500) * 1024 * 1024) {
      reject(Error("Máximo 20 MB por imagen, 50 MB por audio y 500 MB por video"));
      return;
    }
    const request = new XMLHttpRequest();
    request.open("POST", "/api/v1/assets");
    request.setRequestHeader("Content-Type", mime);
    request.setRequestHeader(
      "X-File-Name",
      btoa(String.fromCharCode(...new TextEncoder().encode(file.name))),
    );
    request.upload.onprogress = (event) => {
      if (event.lengthComputable)
        onProgress(Math.round((event.loaded / event.total) * 100));
    };
    const abort = () => request.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    request.onload = () => {
      cleanup();
      let body;
      try {
        body = JSON.parse(request.responseText);
      } catch {
        reject(Error("Respuesta de subida inválida"));
        return;
      }
      if (request.status >= 200 && request.status < 300) resolve(body);
      else reject(Error(body.error || "No se pudo subir el archivo"));
    };
    request.onerror = () => {
      cleanup();
      reject(Error("La conexión se interrumpió durante la subida"));
    };
    request.onabort = () => {
      cleanup();
      reject(Error("Subida cancelada"));
    };
    request.send(file);
  });
}
