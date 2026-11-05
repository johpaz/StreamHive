// Fondos de las pantallas de inicio, pausa y fin. El compositor solo copia imágenes,
// así que el diseño se pinta aquí, en un canvas, y la pantalla lo muestra como <img>.
import type { SlateStyle } from "./types";

export type Rgb = [number, number, number];
export function hexToRgb(hex: string): Rgb {
  const n = parseInt(/^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : "101923", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgba = ([r, g, b]: Rgb, a = 1) => `rgba(${r},${g},${b},${a})`;
/** Mezcla lineal: t=0 da `a`, t=1 da `b`. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb =>
  a.map((v, i) => Math.round(v + (b[i] - v) * t)) as Rgb;
/** Gira el tono conservando saturación y luz: el segundo color de Aurora. */
export function shiftHue([r, g, b]: Rgb, degrees: number): Rgb {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2;
  const d = max - min;
  if (!d) return [r, g, b];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (((h * 60 + degrees) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [p, q, t] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [p, q, t].map((v) => Math.round((v + m) * 255)) as Rgb;
}
export const slateStyles: { key: SlateStyle; label: string }[] = [
  { key: "colmena", label: "Colmena" },
  { key: "aurora", label: "Aurora" },
  { key: "lineas", label: "Líneas" },
  { key: "liso", label: "Liso" },
];

function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: Rgb, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(color, alpha));
  g.addColorStop(0.45, rgba(color, alpha * 0.35));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}
/** Dibuja un motivo y lo desvanece desde un foco, sin tocar el fondo de debajo. */
function pattern(
  ctx: CanvasRenderingContext2D,
  focus: [number, number],
  reach: number,
  draw: (layer: CanvasRenderingContext2D) => void,
) {
  const { width, height } = ctx.canvas;
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const l = layer.getContext("2d")!;
  draw(l);
  l.globalCompositeOperation = "destination-in";
  const mask = l.createRadialGradient(focus[0], focus[1], 0, focus[0], focus[1], reach);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.55, "rgba(0,0,0,0.45)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  l.fillStyle = mask;
  l.fillRect(0, 0, width, height);
  ctx.drawImage(layer, 0, 0);
}
export function drawSlateBackground(
  ctx: CanvasRenderingContext2D,
  style: SlateStyle,
  background: string,
  accentHex: string,
) {
  const { width: w, height: h } = ctx.canvas;
  const base = hexToRgb(background), accent = hexToRgb(accentHex);
  const big = Math.max(w, h), unit = Math.min(w, h);
  const portrait = h > w;
  ctx.fillStyle = rgba(base);
  ctx.fillRect(0, 0, w, h);
  if (style === "liso") return;
  // Profundidad: centro algo más claro, bordes más oscuros.
  const light = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, big * 0.75);
  light.addColorStop(0, rgba(mix(base, [255, 255, 255], 0.07)));
  light.addColorStop(1, rgba(mix(base, [0, 0, 0], 0.35)));
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);
  if (style === "colmena") {
    const focus: [number, number] = portrait ? [w * 0.85, h * 0.08] : [w * 0.9, h * 0.12];
    glow(ctx, focus[0], focus[1], big * 0.55, accent, 0.22);
    glow(ctx, w * 0.05, h * 0.98, big * 0.4, accent, 0.08);
    pattern(ctx, focus, big * 0.75, (l) => {
      const r = unit * 0.06, dx = Math.sqrt(3) * r, dy = 1.5 * r;
      l.strokeStyle = rgba(mix(accent, [255, 255, 255], 0.15), 0.55);
      l.lineWidth = Math.max(1, unit * 0.0022);
      for (let row = -1; row * dy < h + r; row++)
        for (let col = -1; col * dx < w + dx; col++) {
          const cx = col * dx + (row % 2 ? dx / 2 : 0), cy = row * dy;
          l.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (Math.PI / 3) * i + Math.PI / 6;
            const px = cx + r * 0.92 * Math.cos(a), py = cy + r * 0.92 * Math.sin(a);
            if (i) l.lineTo(px, py); else l.moveTo(px, py);
          }
          l.closePath();
          l.stroke();
        }
    });
    // Unas pocas celdas rellenas marcan el acento sin distraer.
    pattern(ctx, focus, big * 0.42, (l) => {
      const r = unit * 0.06, dx = Math.sqrt(3) * r, dy = 1.5 * r;
      l.fillStyle = rgba(accent, 0.16);
      for (const [col, row] of [[-2, 1], [-3, 2], [-1, 2], [-2, 3], [-4, 1], [-5, 4]]) {
        const startCol = Math.floor(focus[0] / dx), startRow = Math.round(focus[1] / dy);
        const rr = startRow + row, cx = (startCol + col) * dx + (rr % 2 ? dx / 2 : 0), cy = rr * dy;
        l.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 3) * i + Math.PI / 6;
          const px = cx + r * 0.86 * Math.cos(a), py = cy + r * 0.86 * Math.sin(a);
          if (i) l.lineTo(px, py); else l.moveTo(px, py);
        }
        l.closePath();
        l.fill();
      }
    });
  } else if (style === "aurora") {
    const second = shiftHue(accent, 55), third = shiftHue(accent, -40);
    glow(ctx, w * 0.18, h * 0.2, big * 0.62, accent, 0.34);
    glow(ctx, w * 0.88, h * 0.78, big * 0.58, second, 0.28);
    glow(ctx, w * 0.6, portrait ? h * 0.45 : h * 0.05, big * 0.4, third, 0.14);
  } else if (style === "lineas") {
    const focus: [number, number] = [w * 0.92, h * 0.9];
    glow(ctx, focus[0], focus[1], big * 0.6, accent, 0.18);
    pattern(ctx, focus, big * 0.95, (l) => {
      l.strokeStyle = rgba(mix(accent, [255, 255, 255], 0.2), 0.42);
      l.lineWidth = Math.max(1, unit * 0.0018);
      const gap = unit * 0.028;
      for (let x = -h; x < w + h; x += gap) {
        l.beginPath();
        l.moveTo(x, h);
        l.lineTo(x + h * 0.8, 0);
        l.stroke();
      }
    });
    ctx.fillStyle = rgba(accent, 0.9);
    ctx.fillRect(0, h - unit * 0.012, w, unit * 0.012);
  }
  // Viñeta: el texto del centro siempre se lee.
  const v = ctx.createRadialGradient(w / 2, h / 2, unit * 0.3, w / 2, h / 2, big * 0.78);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.38)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, w, h);
}
const cache = new Map<string, string>();
/** Imagen del fondo para un formato. Se genera una vez por combinación. */
export function slateBackgroundUrl(
  style: SlateStyle,
  background: string,
  accent: string,
  width: number,
  height: number,
): string {
  const key = [style, background, accent, width, height].join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  drawSlateBackground(canvas.getContext("2d")!, style, background, accent);
  const url = canvas.toDataURL("image/jpeg", 0.92);
  if (cache.size > 24) cache.clear();
  cache.set(key, url);
  return url;
}
