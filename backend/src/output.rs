//! Motor de salida: compone, graba (MP4) y emite (RTMP) el programa.
//!
//! Todos los motores devuelven información con la forma de LiveKit `EgressInfo`
//! (`egress_id`, `status`, `stream_results`, `file_results`) para que la
//! reconciliación del backend sea idéntica sea cual sea el motor.
//! Egress y FFmpeg comparten estados de salida; FFmpeg publica cada destino por separado.
mod relay;
use crate::{livekit::LiveKit, model::ROOM};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Instant};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStdin, Command},
    sync::{Mutex, broadcast},
};

#[derive(Clone)]
pub enum Engine {
    Egress(LiveKit),
    Ffmpeg(Ffmpeg),
}

/// Motor de escritorio: recibe por stdin el WebM (vídeo+audio) que produce el
/// compositor del renderer y, con un único encode, escribe el MP4 y, si hay
/// destinos, reparte la codificación a publicadores RTMP independientes de la grabación.
#[derive(Clone)]
pub struct Ffmpeg {
    pub bin: String,
    pub recordings: PathBuf,
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    encoder: Arc<tokio::sync::OnceCell<String>>,
    progress: Arc<std::sync::Mutex<Option<Value>>>,
}
/// Fotogramas por segundo de salida (MP4 y RTMP).
const FPS: u32 = 30;
/// Codificadores H.264 por hardware (GPU), según el sistema: NVIDIA, Apple, Intel, VA-API (AMD/Intel en Linux), AMD en Windows.
const HARDWARE_ENCODERS: [&str; 5] = [
    "h264_nvenc",
    "h264_videotoolbox",
    "h264_qsv",
    "h264_vaapi",
    "h264_amf",
];
const SOFTWARE_ENCODERS: [&str; 2] = ["libx264", "libopenh264"];
/// Orden en que se prueban los codificadores según la política (`STREAMHIVE_ENCODER`):
/// `auto` (por defecto) usa la GPU si funciona y, si no, la CPU; `software` solo CPU; `hardware` solo GPU.
fn candidates_for(policy: &str) -> Vec<&'static str> {
    match policy {
        "software" => SOFTWARE_ENCODERS.to_vec(),
        "hardware" => HARDWARE_ENCODERS.to_vec(),
        _ => HARDWARE_ENCODERS
            .iter()
            .chain(SOFTWARE_ENCODERS.iter())
            .copied()
            .collect(),
    }
}
/// Dispositivo VA-API (Linux, GPU AMD/Intel). Configurable con STREAMHIVE_VAAPI_DEVICE.
fn vaapi_device() -> String {
    std::env::var("STREAMHIVE_VAAPI_DEVICE").unwrap_or_else(|_| "/dev/dri/renderD128".into())
}
/// Argumentos para comprobar que un codificador funciona de verdad (VA-API necesita subir el fotograma a la GPU).
fn probe_args(name: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-v", "error"].map(String::from).into();
    if name == "h264_vaapi" {
        a.extend(["-vaapi_device".into(), vaapi_device()]);
    }
    // Se prueba a la resolución real de salida: algunos codificadores de GPU aceptan 256x144 y fallan a 1080p.
    a.extend(["-f", "lavfi", "-i", "nullsrc=s=1920x1080:r=30"].map(String::from));
    if name == "h264_vaapi" {
        a.extend(["-vf", "format=nv12,hwupload"].map(String::from));
    }
    a.extend(
        [
            "-frames:v",
            "3",
            "-c:v",
            name,
            "-b:v",
            "6M",
            "-f",
            "null",
            "-",
        ]
        .map(String::from),
    );
    a
}
async fn detect_encoder(bin: &str) -> anyhow::Result<String> {
    let policy = std::env::var("STREAMHIVE_ENCODER").unwrap_or_else(|_| "auto".into());
    // Un nombre concreto (p. ej. `h264_vaapi`) se respeta sin probar; `auto|software|hardware` son políticas.
    if !matches!(policy.as_str(), "auto" | "software" | "hardware") {
        return Ok(policy);
    }
    for name in candidates_for(&policy) {
        let ok = Command::new(bin)
            .args(probe_args(name))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success());
        if ok {
            return Ok(name.into());
        }
    }
    anyhow::bail!("ffmpeg no incluye ningún codificador H.264 utilizable ({policy})")
}
struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    started: Instant,
    stopping: bool,
    relays: Vec<relay::Relay>,
}
fn parse_progress(key: &str, value: &str) -> Option<Value> {
    Some(match key {
        "frame" | "drop_frames" | "dup_frames" | "total_size" => json!(value.parse::<u64>().ok()?),
        "fps" => json!(value.parse::<f64>().ok()?),
        "speed" => json!(value.trim_end_matches('x').trim().parse::<f64>().ok()?),
        "bitrate" => json!(
            value
                .trim_end_matches("kbits/s")
                .trim()
                .parse::<f64>()
                .ok()?
        ),
        _ => return None,
    })
}
impl Ffmpeg {
    pub fn new(bin: impl Into<String>, recordings: PathBuf) -> Self {
        Self {
            bin: bin.into(),
            recordings,
            sessions: Default::default(),
            encoder: Default::default(),
            progress: Default::default(),
        }
    }
    fn args(&self, p: &StartParams<'_>, encoder: String) -> Vec<String> {
        let file = self.recordings.join(format!("{}.mp4", p.broadcast_id));
        let mut tee = format!(
            "[f=mp4:movflags=+frag_keyframe+empty_moov]{}",
            file.display()
        );
        // El transporte local se reparte a publicadores independientes sin recodificar.
        // Ninguna URL ni clave forma parte de la sintaxis tee.
        if !p.destinations.is_empty() {
            tee += "|[f=mpegts:mpegts_flags=+resend_headers]pipe:1";
        }
        let mut a: Vec<String> = [
            "-hide_banner",
            "-nostats",
            "-progress",
            "pipe:2",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
        ]
        .map(String::from)
        .into();
        let vaapi = encoder == "h264_vaapi";
        if vaapi {
            // El dispositivo se declara antes de la entrada.
            let at = a.iter().position(|x| x == "-i").unwrap();
            a.splice(at..at, ["-vaapi_device".to_string(), vaapi_device()]);
        }
        // El WebM del compositor tiene timestamps variables (base 1/1000): sin esto ffmpeg
        // rellena hasta ~1000 fps duplicando frames y el RTMP/MP4 salen con un framerate absurdo.
        a.extend([
            "-vf".into(),
            if vaapi {
                format!(
                    "scale={}:{},fps={FPS},format=nv12,hwupload",
                    p.format.dimensions().0,
                    p.format.dimensions().1
                )
            } else {
                format!(
                    "scale={}:{},fps={FPS}",
                    p.format.dimensions().0,
                    p.format.dimensions().1
                )
            },
            "-r".into(),
            FPS.to_string(),
        ]);
        // MP4 requires codec extradata even when sharing the encoder with MPEG-TS.
        a.extend([
            "-flags".into(),
            "+global_header".into(),
            "-c:v".into(),
            encoder,
        ]);
        if a.last().is_some_and(|e| e == "libx264") {
            a.extend([
                "-preset".into(),
                "veryfast".into(),
                "-x264-params".into(),
                "nal-hrd=cbr:force-cfr=1:scenecut=0:repeat-headers=1".into(),
            ]);
        }
        a.extend([
            "-b:v".into(),
            format!("{}k", p.video_bitrate),
            "-minrate".into(),
            format!("{}k", p.video_bitrate),
            "-maxrate".into(),
            format!("{}k", p.video_bitrate),
            "-bufsize".into(),
            format!("{}k", p.video_bitrate * 2),
            "-g".into(),
            (FPS * 2).to_string(),
        ]);
        if !vaapi {
            a.extend(["-pix_fmt".into(), "yuv420p".into()]);
        }
        a.extend([
            "-profile:v".into(),
            "main".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{}k", p.audio_bitrate),
            "-map".into(),
            "0:v".into(),
            "-map".into(),
            "0:a".into(),
            "-f".into(),
            "tee".into(),
            tee,
        ]);
        a
    }
    async fn start(&self, p: StartParams<'_>) -> anyhow::Result<Value> {
        let encoder = self
            .encoder
            .get_or_try_init(|| detect_encoder(&self.bin))
            .await?
            .clone();
        let mut child = Command::new(&self.bin)
            .args(self.args(&p, encoder))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take();
        *self.progress.lock().unwrap() = None;
        if let Some(out) = child.stderr.take() {
            // `-progress pipe:2` emite bloques clave=valor terminados en `progress=`.
            let shared = self.progress.clone();
            tokio::spawn(async move {
                use tokio::io::{AsyncBufReadExt, BufReader};
                let mut lines = BufReader::new(out).lines();
                let mut cur = serde_json::Map::new();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some((k, v)) = line.split_once('=') {
                        if k == "progress" {
                            *shared.lock().unwrap() = Some(Value::Object(cur.clone()));
                            cur.clear();
                        } else if let Some(parsed) = parse_progress(k, v.trim()) {
                            cur.insert(k.into(), parsed);
                        }
                    }
                }
            });
        }
        let (packets, _) = broadcast::channel::<Arc<[u8]>>(128);
        let relays = p
            .destinations
            .iter()
            .map(|url| relay::Relay::spawn(self.bin.clone(), url.clone(), packets.subscribe()))
            .collect();
        let mut out = child.stdout.take().unwrap();
        tokio::spawn(async move {
            let mut buffer = vec![0u8; 32768];
            while let Ok(n) = out.read(&mut buffer).await {
                if n == 0 {
                    break;
                }
                let _ = packets.send(Arc::from(&buffer[..n]));
            }
        });
        self.sessions.lock().await.insert(
            p.broadcast_id.to_owned(),
            Session {
                child,
                stdin,
                started: Instant::now(),
                stopping: false,
                relays,
            },
        );
        Ok(json!({"egress_id":p.broadcast_id,"status":"EGRESS_ACTIVE"}))
    }
    /// Entrega un fragmento WebM al encoder.
    pub async fn feed(&self, id: &str, chunk: &[u8]) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().await;
        let stdin = sessions
            .get_mut(id)
            .and_then(|s| s.stdin.as_mut())
            .ok_or_else(|| anyhow::anyhow!("no hay emisión activa"))?;
        stdin.write_all(chunk).await?;
        Ok(())
    }
    /// Último bloque de progreso del encoder (fps, speed, frames descartados...).
    pub fn progress(&self) -> Option<Value> {
        let mut p = self.progress.lock().unwrap().clone()?;
        if let (Some(name), Some(obj)) = (self.encoder.get(), p.as_object_mut()) {
            obj.insert("encoder".into(), json!(name));
        }
        Some(p)
    }
    async fn stop(&self, id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().await;
        if let Some(s) = sessions.get_mut(id) {
            s.stopping = true;
            if let Some(mut stdin) = s.stdin.take() {
                let _ = stdin.shutdown().await; // EOF: ffmpeg cierra el MP4 limpiamente
            }
        }
        Ok(())
    }
    async fn find(&self, id: &str) -> Option<Value> {
        let mut sessions = self.sessions.lock().await;
        let s = sessions.get_mut(id)?;
        let streams: Vec<_> = s
            .relays
            .iter()
            .map(|r| json!({"url":r.url,"status":*r.state.lock().unwrap()}))
            .collect();
        let mut info = match s.child.try_wait() {
            Ok(None) => {
                json!({"egress_id":id,"status":if s.stopping {"EGRESS_ENDING"} else {"EGRESS_ACTIVE"}})
            }
            Ok(Some(st)) if st.success() => {
                let ns = s.started.elapsed().as_nanos().to_string();
                json!({"egress_id":id,"status":"EGRESS_COMPLETE","file_results":[{"duration":ns}]})
            }
            _ => json!({"egress_id":id,"status":"EGRESS_FAILED"}),
        };
        info["stream_results"] = json!(streams);
        Some(info)
    }
}

pub struct StartParams<'a> {
    pub broadcast_id: &'a str,
    pub render_url: &'a str,
    pub destinations: &'a [String],
    pub video_bitrate: u32,
    pub audio_bitrate: u32,
    pub format: crate::model::OutputFormat,
}

impl Engine {
    /// Motor local (escritorio): sin límite de 2 h y con requisitos de disco menores.
    pub fn stats(&self) -> Option<Value> {
        match self {
            Engine::Ffmpeg(f) => f.progress(),
            _ => None,
        }
    }
    pub fn is_local(&self) -> bool {
        matches!(self, Engine::Ffmpeg(_))
    }
    /// Inicia grabación + emisión. Devuelve la info del motor (con `egress_id`).
    pub async fn start(&self, p: StartParams<'_>) -> anyhow::Result<Value> {
        match self {
            Engine::Ffmpeg(f) => f.start(p).await,
            Engine::Egress(lk) => {
                let mut request = crate::livekit::egress_request(
                    &format!("/recordings/{}.mp4", p.broadcast_id),
                    p.render_url,
                    p.destinations,
                );
                request["advanced"]["video_bitrate"] = json!(p.video_bitrate);
                request["advanced"]["audio_bitrate"] = json!(p.audio_bitrate);
                let (width, height) = p.format.dimensions();
                request["advanced"]["width"] = json!(width);
                request["advanced"]["height"] = json!(height);
                // Garantiza que el estudio exista aunque no haya cámaras activas.
                lk.rpc(
                    "RoomService",
                    "CreateRoom",
                    json!({"name":ROOM,"empty_timeout":10800,"departure_timeout":10800}),
                )
                .await?;
                lk.rpc("Egress", "StartEgress", request).await
            }
        }
    }

    pub async fn stop(&self, id: &str) -> anyhow::Result<()> {
        match self {
            Engine::Ffmpeg(f) => f.stop(id).await,
            Engine::Egress(lk) => {
                lk.rpc("Egress", "StopEgress", json!({"egress_id":id}))
                    .await?;
                Ok(())
            }
        }
    }

    /// Reintenta/añade la salida RTMP de una emisión en curso.
    pub async fn add_stream_output(&self, id: &str, urls: &[String]) -> anyhow::Result<()> {
        match self {
            Engine::Ffmpeg(f) => {
                let sessions = f.sessions.lock().await;
                let session = sessions
                    .get(id)
                    .ok_or_else(|| anyhow::anyhow!("No hay emisión activa"))?;
                for relay in &session.relays {
                    if urls.contains(&relay.url) && *relay.state.lock().unwrap() != "ACTIVE" {
                        relay.retry.send_modify(|n| *n += 1);
                    }
                }
                Ok(())
            }
            Engine::Egress(lk) => {
                lk.rpc(
                    "Egress",
                    "UpdateStream",
                    json!({"egress_id":id,"add_output_urls":urls}),
                )
                .await?;
                Ok(())
            }
        }
    }

    /// Busca la información de la emisión activa: por id, o por emisión si aún no hay id.
    pub async fn find(
        &self,
        egress_id: Option<&str>,
        broadcast_id: &str,
    ) -> anyhow::Result<Option<Value>> {
        match self {
            Engine::Ffmpeg(f) => Ok(f.find(egress_id.unwrap_or(broadcast_id)).await),
            Engine::Egress(lk) => {
                let response = lk
                    .rpc(
                        "Egress",
                        "ListEgress",
                        match egress_id {
                            Some(id) => json!({"egress_id":id}),
                            None => json!({"room_name":ROOM}),
                        },
                    )
                    .await?;
                let suffix = format!("/{broadcast_id}.mp4");
                Ok(response["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .find(|x| match egress_id {
                        Some(id) => x["egress_id"].as_str() == Some(id),
                        None => {
                            x["room_name"] == ROOM
                                && (x["egress"]["outputs"].as_array().into_iter().flatten().any(
                                    |o| {
                                        o["file"]["filepath"]
                                            .as_str()
                                            .is_some_and(|p| p.ends_with(&suffix))
                                    },
                                ) || x["file_results"].as_array().into_iter().flatten().any(
                                    |f| {
                                        f["filename"]
                                            .as_str()
                                            .is_some_and(|p| p.ends_with(&suffix[1..]))
                                    },
                                ))
                        }
                    })
                    .cloned())
            }
        }
    }
}

#[cfg(test)]
pub(crate) async fn test_webm_sample() -> Option<Vec<u8>> {
    let out = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=320x180:rate=30:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=duration=2",
            "-c:v",
            "libvpx",
            "-c:a",
            "libopus",
            "-f",
            "webm",
            "pipe:1",
        ])
        .output()
        .await
        .ok()?;
    out.status.success().then_some(out.stdout)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gpu_encoders_are_preferred_when_they_work_and_the_policy_is_respected() {
        let auto = candidates_for("auto");
        let pos = |n: &str| auto.iter().position(|e| *e == n).unwrap();
        assert!(
            pos("h264_nvenc") < pos("libx264") && pos("h264_vaapi") < pos("libx264"),
            "la GPU se prefiere si funciona"
        );
        assert!(pos("libx264") < pos("libopenh264"));
        assert!(
            candidates_for("software")
                .iter()
                .all(|e| !e.starts_with("h264_"))
        );
        assert!(
            candidates_for("hardware")
                .iter()
                .all(|e| e.starts_with("h264_"))
        );
        assert_eq!(
            candidates_for("otra-cosa"),
            auto,
            "una política desconocida cae en auto"
        );
        // La prueba usa la resolución real de salida, y VA-API sube el fotograma a la GPU.
        assert!(
            probe_args("libx264")
                .iter()
                .any(|x| x.contains("1920x1080"))
        );
        assert!(
            probe_args("h264_vaapi")
                .iter()
                .any(|x| x == "format=nv12,hwupload")
        );
    }
    #[test]
    fn shared_transport_has_no_secrets_and_portrait_has_its_own_dimensions() {
        let f = Ffmpeg::new("ffmpeg", std::env::temp_dir());
        let urls = vec!["rtmps://a/live/secret|with:syntax".into()];
        let p = StartParams {
            broadcast_id: "b",
            render_url: "",
            destinations: &urls,
            video_bitrate: 6000,
            audio_bitrate: 128,
            format: crate::model::OutputFormat::Portrait,
        };
        let args = f.args(&p, "libx264".into());
        assert!(args.iter().any(|a| a.contains("scale=1080:1920")));
        let tee = args.last().unwrap();
        assert!(tee.contains("f=mpegts"));
        assert!(!tee.contains("secret"));
        let none = StartParams {
            destinations: &[],
            ..p
        };
        assert!(
            !f.args(&none, "libx264".into())
                .last()
                .unwrap()
                .contains("mpegts")
        );
    }
    #[test]
    fn progress_values_are_parsed_and_unknown_keys_ignored() {
        assert_eq!(parse_progress("speed", "0.98x"), Some(json!(0.98)));
        assert_eq!(parse_progress("speed", "N/A"), None);
        assert_eq!(
            parse_progress("bitrate", "5821.4kbits/s"),
            Some(json!(5821.4))
        );
        assert_eq!(parse_progress("drop_frames", "3"), Some(json!(3)));
        assert_eq!(parse_progress("out_time", "00:00:01"), None);
    }
    #[tokio::test]
    async fn ffmpeg_records_valid_mp4_even_when_a_parallel_rtmp_destination_is_unreachable() {
        let Some(sample) = test_webm_sample().await else {
            eprintln!("ffmpeg con libvpx/libopus no disponible; prueba omitida");
            return;
        };
        let dir = std::env::temp_dir().join(format!("sh-ffmpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let engine = Engine::Ffmpeg(Ffmpeg::new("ffmpeg", dir.clone()));
        let info = engine
            .start(StartParams {
                broadcast_id: "b1",
                render_url: "",
                destinations: &["rtmp://127.0.0.1:1/live/test".into()],
                video_bitrate: 800,
                audio_bitrate: 64,
                format: Default::default(),
            })
            .await
            .unwrap();
        assert_eq!(info["egress_id"], "b1");
        let Engine::Ffmpeg(f) = &engine else {
            unreachable!()
        };
        f.feed("b1", &sample).await.unwrap();
        engine.stop("b1").await.unwrap();
        let mut status = Value::Null;
        for _ in 0..100 {
            status = engine.find(Some("b1"), "b1").await.unwrap().unwrap();
            if status["status"] == "EGRESS_COMPLETE" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(status["status"], "EGRESS_COMPLETE");
        assert!(std::fs::metadata(dir.join("b1.mp4")).unwrap().len() > 1000);
        // Regresión: la salida debe ser de 30 fps constantes, no ~1000 por la base de tiempo del WebM.
        let probe = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=r_frame_rate",
                "-of",
                "default=nw=1:nk=1",
            ])
            .arg(dir.join("b1.mp4"))
            .output();
        if let Ok(out) = probe {
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "30/1");
        }
        std::fs::remove_dir_all(dir).ok();
    }
}
