//! Independent RTMP publishers. They copy the shared H.264/AAC stream, never encode it.
//! Bounded queues and write deadlines keep a stalled destination away from the recording.
use std::{
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::{broadcast, watch},
};

pub(super) struct Relay {
    pub url: String,
    pub state: Arc<Mutex<String>>,
    pub retry: watch::Sender<u64>,
    task: tokio::task::JoinHandle<()>,
}

/// Detener el directo descarta el publicador; `kill_on_drop` cierra su FFmpeg.
impl Drop for Relay {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Relay {
    pub fn spawn(bin: String, url: String, mut input: broadcast::Receiver<Arc<[u8]>>) -> Self {
        let state = Arc::new(Mutex::new("CONNECTING".to_string()));
        let (retry, mut retried) = watch::channel(0u64);
        let (published, shared) = (url.clone(), state.clone());
        let task = tokio::spawn(async move {
            let set = |s: &str| *state.lock().unwrap() = s.into();
            let mut first = true;
            loop {
                if !first {
                    set("RECONNECTING");
                    // Keep draining during backoff: a failed channel cannot accumulate stale video.
                    let delay = tokio::time::sleep(Duration::from_secs(3));
                    tokio::pin!(delay);
                    loop {
                        tokio::select! {
                            _ = &mut delay => break,
                            _ = retried.changed() => break,
                            packet = input.recv() => if matches!(packet, Err(broadcast::error::RecvError::Closed)) {
                                set("FINISHED"); return;
                            },
                        }
                    }
                    input = input.resubscribe();
                }
                first = false;
                let child = Command::new(&bin)
                    .args([
                        "-hide_banner",
                        "-loglevel",
                        "quiet",
                        "-nostats",
                        "-progress",
                        "pipe:1",
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
                        "-f",
                        "flv",
                        "-flvflags",
                        "no_duration_filesize",
                        "-rw_timeout",
                        "5000000",
                        &url,
                    ])
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    .kill_on_drop(true)
                    .spawn();
                let Ok(mut child) = child else { continue };
                let mut stdin = child.stdin.take().unwrap();
                let mut progress = BufReader::new(child.stdout.take().unwrap()).lines();
                let mut last_progress = Instant::now();
                let mut clock = tokio::time::interval(Duration::from_secs(1));
                loop {
                    tokio::select! {
                        packet = input.recv() => match packet {
                            Ok(packet) => {
                                let write = tokio::time::timeout(Duration::from_secs(3), stdin.write_all(&packet));
                                tokio::select! {
                                    r = write => if !matches!(r, Ok(Ok(()))) { break; },
                                    _ = retried.changed() => break,
                                }
                            },
                            Err(broadcast::error::RecvError::Lagged(_)) => break,
                            Err(broadcast::error::RecvError::Closed) => {
                                drop(stdin);
                                let _ = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                                let _ = child.kill().await;
                                set("FINISHED"); return;
                            },
                        },
                        line = progress.next_line() => match line {
                            Ok(Some(line)) => {
                                if line.strip_prefix("out_time_us=").and_then(|n| n.parse::<i64>().ok()).is_some_and(|n| n > 0) {
                                    last_progress = Instant::now();
                                    set("ACTIVE");
                                }
                            },
                            _ => break,
                        },
                        _ = retried.changed() => break,
                        _ = clock.tick() => {
                            if last_progress.elapsed() > Duration::from_secs(15)
                                || !matches!(child.try_wait(), Ok(None)) { break; }
                        },
                    }
                }
                set("RECONNECTING");
                let _ = child.kill().await;
            }
        });
        Self {
            url: published,
            state: shared,
            retry,
            task,
        }
    }
}
