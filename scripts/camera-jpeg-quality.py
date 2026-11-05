#!/usr/bin/env python3
"""Calidad de compresión MJPEG que ENVÍA la cámara (se mide el paquete crudo, sin decodificar ni recomprimir).
Sirve para comparar la misma cámara entre Linux y Windows: si el número es igual, el sistema no influye.

Linux:    python3 scripts/camera-jpeg-quality.py /dev/video2
Windows:  python scripts\\camera-jpeg-quality.py "video=Web Camera"      (nombre tal como lo lista: ffmpeg -list_devices true -f dshow -i dummy)
Opciones: --size 1920x1080 --fps 30   (requiere ffmpeg en el PATH)
macOS: avfoundation entrega vídeo ya decodificado, así que esta prueba no es posible ahí.
"""
import argparse, os, platform, struct, subprocess, sys, tempfile

STD = [16,11,10,16,24,40,51,61,12,12,14,19,26,58,60,55,14,13,16,24,40,57,69,56,14,17,22,29,51,87,80,62,18,22,37,56,68,109,103,77,24,35,55,64,81,104,113,92,49,64,78,87,103,121,120,101,72,92,95,98,112,100,103,99]
ZZ = [0,1,8,16,9,2,3,10,17,24,32,25,18,11,4,5,12,19,26,33,40,48,41,34,27,20,13,6,7,14,21,28,35,42,49,56,57,50,43,36,29,22,15,23,30,37,44,51,58,59,52,45,38,31,39,46,53,60,61,54,47,55,62,63]

def quality(data: bytes):
    i, tables = 2, {}
    while i < len(data) - 4:
        if data[i] != 0xFF:
            i += 1
            continue
        m, l = data[i + 1], struct.unpack_from(">H", data, i + 2)[0]
        if m == 0xDB:
            j = i + 4
            while j < i + 2 + l:
                pq, tq = data[j] >> 4, data[j] & 15
                n = 64 * (2 if pq else 1)
                vals = list(struct.unpack_from(">64H", data, j + 1)) if pq else list(data[j + 1:j + 1 + n])
                t = [0] * 64
                for k, v in enumerate(vals):
                    t[ZZ[k]] = v
                tables[tq] = t
                j += 1 + n
        if m == 0xDA:
            break
        i += 2 + l
    t = tables[0]
    s = 100 * sum(t[k] / STD[k] for k in range(64)) / 64
    return ((200 - s) / 2 if s <= 200 else 5000 / s), t[:8]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("device")
    ap.add_argument("--size", default="1920x1080")
    ap.add_argument("--fps", default="30")
    a = ap.parse_args()
    out = os.path.join(tempfile.mkdtemp(), "f_%02d.jpg")
    src = ["-f", "v4l2", "-input_format", "mjpeg"] if platform.system() == "Linux" else ["-f", "dshow", "-vcodec", "mjpeg"]
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *src, "-video_size", a.size, "-framerate", a.fps, "-i", a.device, "-frames:v", "12", "-c:v", "copy", "-f", "image2", out]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    last = out % 12
    if not os.path.exists(last):
        sys.exit(f"No se pudo capturar (¿cámara en uso por otra app?):\n{r.stderr.strip()}")
    data = open(last, "rb").read()
    q, t = quality(data)
    print(f"{a.device} {a.size}: calidad JPEG estimada ≈ {q:.1f}/100 · {len(data)/1024:.0f} KB por fotograma · tabla {t}")

if __name__ == "__main__":
    main()
