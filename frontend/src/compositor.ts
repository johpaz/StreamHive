// Compositor de escritorio: dibuja el DOM de <Stage> en un canvas 1920x1080,
// mezcla el audio y envía el resultado (WebM/MP4 fragmentado) al backend, que lo
// codifica con ffmpeg. Reutiliza el CSS del Stage midiendo el DOM en cada frame,
// de modo que el programa emitido es idéntico a la vista previa sin duplicar layouts.

export type Box = { left: number; top: number; width: number; height: number };
export type Fit = "cover" | "contain" | "fill";

/** Cálculo de object-fit: rectángulo origen (sx..) y destino (dx..) para drawImage. */
export function fitRect(fit: Fit, srcW: number, srcH: number, box: Box) {
  const dest = { dx: box.left, dy: box.top, dw: box.width, dh: box.height };
  if (fit === "fill" || !srcW || !srcH)
    return { sx: 0, sy: 0, sw: srcW, sh: srcH, ...dest };
  const scale =
    fit === "cover"
      ? Math.max(box.width / srcW, box.height / srcH)
      : Math.min(box.width / srcW, box.height / srcH);
  if (fit === "cover") {
    const sw = box.width / scale,
      sh = box.height / scale;
    return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh, ...dest };
  }
  const dw = srcW * scale,
    dh = srcH * scale;
  return {
    sx: 0,
    sy: 0,
    sw: srcW,
    sh: srcH,
    dx: box.left + (box.width - dw) / 2,
    dy: box.top + (box.height - dh) / 2,
    dw,
    dh,
  };
}

const px = (v: string) => parseFloat(v) || 0;
const transparent = (c: string) =>
  !c || c === "transparent" || /rgba\(.*,\s*0\)$/.test(c);

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

export function drawStage(
  ctx: CanvasRenderingContext2D,
  stage: HTMLElement,
  width: number,
  height: number,
) {
  const origin = stage.getBoundingClientRect();
  if (!origin.width || !origin.height) return;
  const k = width / origin.width;
  const rectOf = (r: DOMRect | DOMRectReadOnly): Box => ({
    left: (r.left - origin.left) * k,
    top: (r.top - origin.top) * k,
    width: r.width * k,
    height: r.height * k,
  });
  const visit = (el: Element, isRoot = false) => {
    if (el.tagName === "AUDIO") return;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0")
      return;
    const box = rectOf(el.getBoundingClientRect());
    const radius = px(cs.borderTopLeftRadius) * k;
    ctx.save();
    ctx.globalAlpha *= Number(cs.opacity) || 1;
    if (!isRoot && cs.overflow !== "visible" && radius) {
      roundRect(ctx, box.left, box.top, box.width, box.height, radius);
      ctx.clip();
    }
    if (el.classList.contains("avatar")) {
      ctx.fillStyle = "#223036";
      ctx.fillRect(box.left, box.top, box.width, box.height);
    } else if (!transparent(cs.backgroundColor)) {
      ctx.fillStyle = cs.backgroundColor;
      if (radius) {
        roundRect(ctx, box.left, box.top, box.width, box.height, radius);
        ctx.fill();
      } else ctx.fillRect(box.left, box.top, box.width, box.height);
    }
    const bl = px(cs.borderLeftWidth) * k;
    if (bl && cs.borderLeftStyle !== "none") {
      ctx.fillStyle = cs.borderLeftColor;
      ctx.fillRect(box.left, box.top, bl, box.height);
    }
    if (el instanceof HTMLVideoElement) {
      if (el.readyState >= 2 && el.videoWidth)
        drawMedia(ctx, el, el.videoWidth, el.videoHeight, cs, box);
    } else if (el instanceof HTMLImageElement) {
      if (el.complete && el.naturalWidth)
        drawMedia(ctx, el, el.naturalWidth, el.naturalHeight, cs, box);
    } else if (el instanceof SVGElement) {
      // Iconos decorativos: se omiten en la emisión.
    } else {
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const r = range.getBoundingClientRect();
          const t = rectOf(r);
          ctx.fillStyle = cs.color;
          ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${px(cs.fontSize) * k}px ${cs.fontFamily}`;
          ctx.textBaseline = "middle";
          ctx.fillText(
            node.textContent.trim(),
            t.left,
            t.top + t.height / 2,
            box.width,
          );
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          visit(node as Element);
        }
      }
    }
    ctx.restore();
  };
  visit(stage, true);
}

function drawMedia(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  w: number,
  h: number,
  cs: CSSStyleDeclaration,
  box: Box,
) {
  const fit: Fit =
    cs.objectFit === "cover" || cs.objectFit === "contain" ? cs.objectFit : "fill";
  const f = fitRect(fit, w, h, box);
  ctx.drawImage(source, f.sx, f.sy, f.sw, f.sh, f.dx, f.dy, f.dw, f.dh);
}

/** Mezcla de audio: engancha cada <audio>/<video> del stage a un único destino. */
class AudioMixer {
  private ctx = new AudioContext();
  private dest = this.ctx.createMediaStreamDestination();
  private silence = this.ctx.createConstantSource();
  private seen = new WeakSet<object>();
  constructor() {
    // MediaRecorder needs audio samples even for a scene with no microphones.
    // Keep a silent clock so background-only scenes also produce WebM/AAC.
    this.silence.offset.value = 0;
    this.silence.connect(this.dest);
    this.silence.start();
  }
  get stream() {
    return this.dest.stream;
  }
  scan(root: HTMLElement) {
    void this.ctx.resume();
    root.querySelectorAll("audio, video").forEach((el) => {
      const media = el as HTMLMediaElement;
      const src = media.srcObject as MediaStream | null;
      if (src instanceof MediaStream) {
        if (!src.getAudioTracks().length || this.seen.has(src)) return;
        this.seen.add(src);
        this.ctx.createMediaStreamSource(src).connect(this.dest);
      } else if (media.currentSrc) {
        if (this.seen.has(media)) return;
        this.seen.add(media);
        try {
          this.ctx.createMediaElementSource(media).connect(this.dest);
        } catch {
          /* ya conectado */
        }
      }
    });
  }
  close() {
    this.silence.stop();
    void this.ctx.close();
  }
}

/** Reloj estable: un Worker no se frena cuando la ventana está oculta. */
export function ticker(ms: number, fn: () => void): () => void {
  try {
    const url = URL.createObjectURL(
      new Blob([`setInterval(()=>postMessage(0),${ms})`], {
        type: "text/javascript",
      }),
    );
    const worker = new Worker(url);
    worker.onmessage = fn;
    return () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

export function pickMime(
  supported: (m: string) => boolean = (m) => MediaRecorder.isTypeSupported(m),
  preferred: string | null = new URLSearchParams(globalThis.location?.search ?? "").get("codec"),
): string {
  // `?codec=vp8` fuerza otro códec intermedio (diagnóstico).
  const forced = preferred && `video/webm;codecs=${preferred},opus`;
  if (forced && supported(forced)) return forced;
  return (
    [
      // H.264 cuesta la mitad de CPU que VP8 en este Chromium (medido: 0,31 vs 0,68 núcleos a 1080p30);
      // ffmpeg recodifica de todos modos, así que solo importa el coste de este paso intermedio.
      "video/webm;codecs=h264,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9,opus",
      "video/webm",
      "video/mp4;codecs=avc1,mp4a.40.2",
      "video/mp4",
    ].find(supported) || ""
  );
}

export type CaptureOptions = {
  stage: HTMLElement;
  url: string; // ws(s)://.../api/v1/ingest?render_token=...
  width?: number;
  height?: number;
  fps?: number;
  videoBitsPerSecond?: number;
  onError?: (message: string) => void;
};

export function startProgramCapture(o: CaptureOptions): () => void {
  const width = o.width ?? 1920,
    height = o.height ?? 1080,
    fps = o.fps ?? 30;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  // El valor por defecto ("low") ablanda y pixela el vídeo al escalarlo a la escena.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  const mixer = new AudioMixer();
  const mime = pickMime();
  const video = canvas.captureStream(fps);
  const stream = new MediaStream([
    ...video.getVideoTracks(),
    ...mixer.stream.getAudioTracks(),
  ]);
  const recorder = new MediaRecorder(stream, {
    mimeType: mime || undefined,
    videoBitsPerSecond: o.videoBitsPerSecond ?? (mime.includes("h264") ? 16_000_000 : 8_000_000),
    audioBitsPerSecond: 192_000,
  });
  const ws = new WebSocket(o.url);
  ws.binaryType = "arraybuffer";
  let frames = 0;
  // Métricas del compositor (las lee el monitor/banco de pruebas): coste de dibujo por frame.
  const stats = { frames: 0, avgMs: 0, maxMs: 0, slow: 0, target: fps, startedAt: performance.now() };
  (window as unknown as { __streamhiveCapture?: typeof stats }).__streamhiveCapture = stats;
  const budget = 1000 / fps;
  const stopDraw = ticker(Math.round(budget), () => {
    const t0 = performance.now();
    drawStage(ctx, o.stage, width, height);
    const ms = performance.now() - t0;
    stats.frames++;
    stats.avgMs += (ms - stats.avgMs) * 0.05;
    stats.maxMs = Math.max(stats.maxMs, ms);
    if (ms > budget) stats.slow++;
    // Cada 100 ms: un audio sin enganchar sonaría por los altavoces del equipo.
    if (++frames % 3 === 0) mixer.scan(o.stage);
  });
  mixer.scan(o.stage);
  recorder.ondataavailable = (e) => {
    if (e.data.size && ws.readyState === WebSocket.OPEN)
      void e.data.arrayBuffer().then((b) => ws.send(b));
  };
  recorder.onerror = () => o.onError?.("Falló la captura del programa");
  ws.onopen = () => recorder.start(250);
  ws.onerror = () => o.onError?.("No se pudo abrir la ingesta local");
  ws.onclose = () => {
    if (recorder.state !== "inactive") recorder.stop();
  };
  return () => {
    stopDraw();
    if (recorder.state !== "inactive") recorder.stop();
    video.getTracks().forEach((t) => t.stop());
    mixer.close();
    setTimeout(() => ws.close(), 500);
  };
}
