// Bundled with the application: no external image hosts or participant uploads.
export const cameraBackgrounds = [
  { id: "office-daylight", name: "Oficina luminosa", category: "Oficina" },
  { id: "office-warm", name: "Oficina cálida", category: "Oficina" },
  { id: "streamer-neon", name: "Streamer neón", category: "Streamer" },
  { id: "podcast-studio", name: "Estudio de podcast", category: "Streamer" },
].map((background) => ({
  ...background,
  url: `/backgrounds/${background.id}.webp`,
  thumbnail: `/backgrounds/${background.id}-thumb.webp`,
}));
export function isBundledCameraBackground(url: string): boolean {
  return cameraBackgrounds.some((background) => background.url === url);
}
