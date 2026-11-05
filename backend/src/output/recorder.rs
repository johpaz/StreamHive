//! Grabación como servicio independiente: copia a MP4 el H.264/AAC ya codificado.
//! Se suscribe al mismo canal que los publicadores RTMP, sin codificar ni frenar al encoder.
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    process::Command,
    sync::{broadcast, watch},
};

/// Margen para que FFmpeg cierre el MP4 antes de darlo por interrumpido.
const FINISH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, PartialEq)]
enum State {
    Recording,
    Complete,
    Failed,
}

pub(super) struct Recorder {
    id: String,
    state: Arc<Mutex<State>>,
    started: Instant,
    ended: Arc<Mutex<Option<Instant>>>,
    stop: watch::Sender<bool>,
}

impl Recorder {
    pub fn spawn(
        bin: String,
        id: String,
        file: PathBuf,
        mut input: broadcast::Receiver<Arc<[u8]>>,
    ) -> Self {
        let state = Arc::new(Mutex::new(State::Recording));
        let ended = Arc::new(Mutex::new(None));
        let (stop, mut stopped) = watch::channel(false);
        let (task_state, task_ended) = (state.clone(), ended.clone());
        tokio::spawn(async move {
            let child = Command::new(&bin)
                .args([
                    "-hide_banner",
                    "-loglevel",
                    "quiet",
                    "-nostats",
                    "-probesize",
                    "4194304",
                    "-analyzeduration",
                    "3000000",
                    "-f",
                    "mpegts",
                    "-i",
                    "pipe:0",
                    "-map",
                    "0:v",
                    "-map",
                    "0:a",
                    "-c",
                    "copy",
                    // El AAC llega en ADTS (MPEG-TS) y MP4 exige otro empaquetado.
                    "-bsf:a",
                    "aac_adtstoasc",
                    "-movflags",
                    "+frag_keyframe+empty_moov",
                    "-f",
                    "mp4",
                ])
                .arg(&file)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn();
            let mut success = false;
            if let Ok(mut child) = child {
                let mut stdin = child.stdin.take().unwrap();
                loop {
                    tokio::select! {
                        _ = stopped.changed() => break,
                        packet = input.recv() => match packet {
                            Ok(packet) => {
                                tokio::select! {
                                    r = stdin.write_all(&packet) => if r.is_err() { break; },
                                    _ = stopped.changed() => break,
                                }
                            }
                            // Un disco lento deja un hueco en el archivo, nunca frena el directo.
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            // El encoder terminó: se cierra el MP4 con lo recibido.
                            Err(broadcast::error::RecvError::Closed) => break,
                        },
                    }
                }
                drop(stdin);
                success = matches!(
                    tokio::time::timeout(FINISH_TIMEOUT, child.wait()).await,
                    Ok(Ok(status)) if status.success()
                );
                if !success {
                    let _ = child.kill().await;
                }
            }
            *task_ended.lock().unwrap() = Some(Instant::now());
            *task_state.lock().unwrap() = if success {
                State::Complete
            } else {
                State::Failed
            };
        });
        Self {
            id,
            state,
            started: Instant::now(),
            ended,
            stop,
        }
    }
    pub fn stop(&self) {
        let _ = self.stop.send(true);
    }
    pub fn active(&self) -> bool {
        *self.state.lock().unwrap() == State::Recording
    }
    /// Misma forma que `recording_results` de la reconciliación.
    pub fn info(&self) -> Value {
        let status = match *self.state.lock().unwrap() {
            State::Recording => "live",
            State::Complete => "complete",
            State::Failed => "error",
        };
        let end = self.ended.lock().unwrap().unwrap_or_else(Instant::now);
        let duration = end.duration_since(self.started).as_nanos().to_string();
        json!({"id":self.id,"status":status,"duration":duration})
    }
}
