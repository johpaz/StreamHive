# Codificación H.264 por GPU en Fedora (opcional)

StreamHive codifica con CPU (`libx264`) por defecto. En Fedora, el driver de vídeo de Mesa no incluye H.264/HEVC por patentes,
así que la GPU (p. ej. Radeon 8060S / Strix Halo) solo ofrece decodificar JPEG, VP9 y AV1 y codificar AV1.
Con el driver "freeworld" de RPM Fusion la GPU puede codificar H.264, lo que baja el uso de CPU al emitir.

> **Estado en esta máquina (Radeon 8060S / Strix Halo, Fedora 44, Mesa 26.2.6): instalado y probado el 2026-11-01.**
> `vainfo` muestra H.264 y HEVC con `VAEntrypointEncSlice`; `h264_vaapi` codifica 1080p con ~6x menos CPU que x264 y SSIM equivalente (0,994 frente a 0,995);
> StreamHive lo elige solo (`auto`) y en directo ahorra ≈0,2 núcleos (host + 5 invitados: 1,48 frente a 1,66 con x264, medidos en la misma sesión).
> Añade un repositorio de terceros y software con patentes: decisión del usuario.

## Pasos
```bash
# 1) Repositorio RPM Fusion (free)
sudo dnf install https://mirrors.rpmfusion.org/free/fedora/rpmfusion-free-release-$(rpm -E %fedora).noarch.rpm

# 2) Driver de vídeo con H.264/HEVC
# Si tienes updates-testing activo (Mesa 26.2.x de pruebas), el paquete que coincide está en el repo de pruebas de RPM Fusion:
sudo dnf install --enablerepo=rpmfusion-free-updates-testing mesa-va-drivers-freeworld
# (con Mesa estable: sudo dnf install mesa-va-drivers-freeworld)

# 3) Comprobar: debe aparecer VAProfileH264... con VAEntrypointEncSlice
vainfo --display drm --device /dev/dri/renderD128
```

## Avisos
- **Versión de Mesa:** el paquete visto en RPM Fusion para Fedora 44 era `26.0.3` y el Mesa instalado era `26.2.6`. Si `dnf` propone **bajar la
  versión de Mesa**, cancela (`n`) y espera a que RPM Fusion publique la versión que coincida.
- Si no aparece el perfil H.264 en `vainfo`, StreamHive seguirá usando `libx264` sin cambios.
- StreamHive detecta la GPU solo: prueba NVENC, VideoToolbox, QSV, **VA-API** y AMF a 1080p30 y, si ninguno funciona, usa `libx264` (solo si el ffmpeg es GPL) y luego **OpenH264**, el respaldo por CPU del ffmpeg LGPL que se empaqueta por defecto.
  `STREAMHIVE_ENCODER` lo controla: `auto` (por defecto), `software` (solo CPU), `hardware` (solo GPU) o un nombre concreto como `h264_vaapi`
  (dispositivo VA-API con `STREAMHIVE_VAAPI_DEVICE`, por defecto `/dev/dri/renderD128`).
- El monitor de recursos muestra el codificador en uso junto a los fps.
