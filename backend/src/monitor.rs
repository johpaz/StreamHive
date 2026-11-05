//! Monitor de recursos: CPU/RAM/disco de la máquina y de cada proceso de StreamHive
//! (backend, LiveKit, ffmpeg, app de escritorio) más las estadísticas del encoder,
//! para que el streamer sepa cuánta capacidad le queda antes de invitar a más gente.
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const HISTORY: usize = 90; // 3 minutos a 2 s

#[derive(Clone, Serialize, Default, Debug)]
pub struct Sample {
    pub t: u64,
    pub cpu: f32, // % de la máquina (0-100)
    pub cpus: usize,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_free: u64,
    /// % de la máquina por grupo de procesos y memoria en bytes.
    pub groups: HashMap<String, Group>,
}
#[derive(Clone, Serialize, Default, Debug)]
pub struct Group {
    pub cpu: f32,
    pub mem: u64,
    pub procs: usize,
}
#[derive(Default)]
struct State {
    disk: Option<PathBuf>,
    latest: Option<Sample>,
    history: VecDeque<(u64, f32, f32)>, // t, cpu%, mem%
}
#[derive(Clone, Default)]
pub struct Monitor(Arc<Mutex<State>>);

/// Procesos de un grupo: por nombre exacto (sin extensión) o descendientes de un pid.
fn base(name: &str) -> String {
    name.trim_end_matches(".exe").to_ascii_lowercase()
}

impl Monitor {
    /// Disco que se vigila: el de la carpeta de grabaciones elegida.
    pub fn watch_disk(&self, path: PathBuf) {
        self.0.lock().unwrap().disk = Some(path);
    }
    pub fn spawn(app_pid: Option<u32>, recordings: PathBuf) -> Self {
        let m = Monitor::default();
        let state = m.0.clone();
        std::thread::Builder::new()
            .name("resource-monitor".into())
            .spawn(move || {
                let Ok(mut sys) = System::new() else {
                    tracing::warn!("monitor de recursos no disponible en esta plataforma");
                    return;
                };
                let me = Pid::from_u32(std::process::id());
                loop {
                    sys.refresh_cpu_usage();
                    sys.refresh_memory();
                    sys.refresh_processes_specifics(
                        ProcessesToUpdate::All,
                        true,
                        ProcessRefreshKind::nothing().with_cpu().with_memory(),
                    );
                    let cpus = sys.cpus().len().max(1);
                    let scale = 1.0 / cpus as f32; // sysinfo: 100 = un núcleo
                    let mut assigned: HashSet<Pid> = HashSet::new();
                    let mut groups: HashMap<String, Group> = HashMap::new();
                    let mut add = |g: &str, p: &sysinfo::Process| {
                        let e = groups.entry(g.into()).or_default();
                        e.cpu += p.cpu_usage() * scale;
                        e.mem += p.memory();
                        e.procs += 1;
                    };
                    // En Linux sysinfo lista también los hilos como procesos: se descartan.
                    for (pid, p) in sys
                        .processes()
                        .iter()
                        .filter(|(_, p)| p.thread_kind().is_none())
                    {
                        let n = base(&p.name().to_string_lossy());
                        let g = if *pid == me {
                            Some("backend")
                        } else if n == "livekit-server" {
                            Some("livekit")
                        } else if n == "ffmpeg" {
                            Some("ffmpeg")
                        } else {
                            None
                        };
                        if let Some(g) = g {
                            assigned.insert(*pid);
                            add(g, p);
                        }
                    }
                    if let Some(root) = app_pid {
                        // App de escritorio: Electron principal + GPU + renderers (descendientes).
                        let root = Pid::from_u32(root);
                        for (pid, p) in sys.processes() {
                            if assigned.contains(pid) || p.thread_kind().is_some() {
                                continue;
                            }
                            let (mut cur, mut hops) = (Some(*pid), 0);
                            while let Some(c) = cur {
                                if c == root {
                                    add("app", p);
                                    break;
                                }
                                cur = sys.process(c).and_then(|x| x.parent());
                                hops += 1;
                                if hops > 8 {
                                    break;
                                }
                            }
                        }
                    }
                    let cpu = sys.global_cpu_usage();
                    let sample = Sample {
                        t: std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0),
                        cpu,
                        cpus,
                        mem_used: sys.used_memory(),
                        mem_total: sys.total_memory(),
                        disk_free: fs2::available_space(
                            state.lock().unwrap().disk.as_ref().unwrap_or(&recordings),
                        )
                        .unwrap_or(0),
                        groups,
                    };
                    {
                        let mut s = state.lock().unwrap();
                        let mem_pct = if sample.mem_total > 0 {
                            sample.mem_used as f32 * 100.0 / sample.mem_total as f32
                        } else {
                            0.0
                        };
                        s.history.push_back((sample.t, cpu, mem_pct));
                        while s.history.len() > HISTORY {
                            s.history.pop_front();
                        }
                        s.latest = Some(sample);
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
            })
            .expect("no se pudo iniciar el monitor");
        m
    }
    #[cfg(test)]
    pub fn with_sample(sample: Sample) -> Self {
        let m = Monitor::default();
        m.0.lock().unwrap().latest = Some(sample);
        m
    }
    pub fn snapshot(&self) -> (Option<Sample>, Vec<(u64, f32, f32)>) {
        let s = self.0.lock().unwrap();
        (s.latest.clone(), s.history.iter().cloned().collect())
    }
}

pub struct Load<'a> {
    pub participants: usize,        // personas conectadas (sin el compositor)
    pub on_program: usize,          // en pantalla ahora mismo
    pub live: bool,                 // hay emisión activa
    pub encoder: Option<&'a Value>, // progreso de ffmpeg
}

/// Nivel y recomendaciones en español. La estimación de "cuántos más" es orientativa.
pub fn advise(s: &Sample, l: &Load) -> Value {
    let mem_pct = if s.mem_total > 0 {
        s.mem_used as f32 * 100.0 / s.mem_total as f32
    } else {
        0.0
    };
    let speed = l.encoder.and_then(|e| e["speed"].as_f64());
    let dropped = l
        .encoder
        .and_then(|e| e["drop_frames"].as_u64())
        .unwrap_or(0);
    let mut level = "ok";
    let mut reasons: Vec<String> = vec![];
    let mut raise = |lv: &'static str, msg: String| {
        let rank = |x: &str| match x {
            "critical" => 2,
            "warn" => 1,
            _ => 0,
        };
        if rank(lv) > rank(level) {
            level = lv;
        }
        reasons.push(msg);
    };
    if s.cpu >= 90.0 {
        raise(
            "critical",
            format!(
                "CPU del equipo al {:.0} %: el directo puede perder frames",
                s.cpu
            ),
        );
    } else if s.cpu >= 70.0 {
        raise(
            "warn",
            format!("CPU del equipo al {:.0} %: poco margen", s.cpu),
        );
    }
    if mem_pct >= 92.0 {
        raise(
            "critical",
            format!("Memoria del equipo al {mem_pct:.0} %: riesgo de que se cuelgue"),
        );
    } else if mem_pct >= 80.0 {
        raise("warn", format!("Memoria del equipo al {mem_pct:.0} %"));
    }
    let gb = s.disk_free as f64 / 1e9;
    if s.disk_free > 0 && gb < 2.0 {
        raise(
            "critical",
            format!("Quedan {gb:.1} GB de disco: la grabación se detendrá pronto"),
        );
    } else if s.disk_free > 0 && gb < 5.0 {
        raise("warn", format!("Quedan {gb:.1} GB de disco"));
    }
    if l.live {
        if speed.is_some_and(|v| v < 0.95) {
            raise(
                "critical",
                format!(
                    "El codificador va a {:.2}x (menos de 1x): no alcanza el tiempo real",
                    speed.unwrap()
                ),
            );
        }
        if dropped > 0 {
            raise("warn", format!("El codificador descartó {dropped} frames"));
        }
    }
    // Coste por persona: reparto conservador del uso total entre anfitrión + invitados.
    let people = (l.participants.max(1) + 1) as f32;
    let per_person = (s.cpu / people).clamp(3.0, 25.0);
    let headroom = (75.0 - s.cpu).max(0.0);
    let by_cpu = (headroom / per_person).floor() as i64;
    let mem_per = (s.mem_used as f32 / people).max(1.0);
    let mem_room = (s.mem_total as f32 * 0.85 - s.mem_used as f32).max(0.0);
    let by_mem = (mem_room / mem_per).floor() as i64;
    let more = by_cpu.min(by_mem).clamp(0, 10);
    let tip = match level {
        "critical" => "No invites a más gente ni compartas pantalla; baja el bitrate o cierra otras aplicaciones.".to_string(),
        "warn" => "Estás cerca del límite: evita añadir más participantes o compartir pantalla a la vez.".to_string(),
        _ if more == 0 => "Sin margen para más participantes.".to_string(),
        _ => format!("Puedes invitar a unas {more} personas más (estimación orientativa)."),
    };
    json!({"level":level,"reasons":reasons,"more_guests":more,"tip":tip,"cpu_per_person":per_person})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(cpu: f32, mem_pct: f32, disk_gb: f64) -> Sample {
        Sample {
            cpu,
            cpus: 8,
            mem_total: 1000,
            mem_used: (mem_pct * 10.0) as u64,
            disk_free: (disk_gb * 1e9) as u64,
            ..Default::default()
        }
    }
    fn load(n: usize, live: bool, enc: Option<&Value>) -> Load<'_> {
        Load {
            participants: n,
            on_program: n,
            live,
            encoder: enc,
        }
    }
    #[test]
    fn healthy_machine_estimates_more_guests() {
        let a = advise(&sample(20.0, 30.0, 100.0), &load(2, false, None));
        assert_eq!(a["level"], "ok");
        assert!(a["more_guests"].as_i64().unwrap() >= 1);
    }
    #[test]
    fn high_cpu_or_memory_or_disk_raises_level_and_blocks_invites() {
        assert_eq!(
            advise(&sample(75.0, 30.0, 100.0), &load(2, false, None))["level"],
            "warn"
        );
        let c = advise(&sample(95.0, 30.0, 100.0), &load(2, false, None));
        assert_eq!(c["level"], "critical");
        assert_eq!(c["more_guests"], 0);
        assert_eq!(
            advise(&sample(10.0, 95.0, 100.0), &load(1, false, None))["level"],
            "critical"
        );
        assert_eq!(
            advise(&sample(10.0, 10.0, 1.0), &load(1, false, None))["level"],
            "critical"
        );
    }
    #[test]
    fn slow_encoder_is_critical_only_while_live() {
        let slow = json!({"speed":0.8,"drop_frames":3});
        assert_eq!(
            advise(&sample(30.0, 30.0, 100.0), &load(1, true, Some(&slow)))["level"],
            "critical"
        );
        assert_eq!(
            advise(&sample(30.0, 30.0, 100.0), &load(1, false, Some(&slow)))["level"],
            "ok"
        );
    }
    #[test]
    fn admission_follows_hardware_not_a_fixed_number() {
        let idle = sample(10.0, 20.0, 100.0);
        assert!(admission(Some(&idle), 5, 10, None, false).is_ok()); // más de 5 si sobra hardware
        assert!(admission(Some(&idle), 10, 10, None, false).is_err()); // tope configurado
        assert!(admission(None, 3, 10, None, false).is_ok()); // sin muestra: solo el tope
        let critical = sample(95.0, 20.0, 100.0);
        assert!(
            admission(Some(&critical), 0, 10, None, false)
                .unwrap_err()
                .contains("sobrecargado")
        );
        let tight = sample(72.0, 20.0, 100.0); // warn, sin margen
        assert!(admission(Some(&tight), 1, 10, None, false).is_ok()); // los 2 primeros se garantizan
        assert!(
            admission(Some(&tight), 2, 10, None, false)
                .unwrap_err()
                .contains("Sin margen")
        );
        let slow = json!({"speed":0.7});
        assert!(admission(Some(&idle), 1, 10, Some(&slow), true).is_err()); // codificador no llega a tiempo real
    }
    #[test]
    fn sampler_reports_this_process_and_machine_totals() {
        let m = Monitor::spawn(None, std::env::temp_dir());
        for _ in 0..30 {
            if m.snapshot().0.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let (s, _) = m.snapshot();
        let s = s.expect("sin muestra");
        assert!(s.cpus >= 1 && s.mem_total > 0 && s.disk_free > 0);
        assert!(s.groups["backend"].mem > 0);
    }
}

/// Los dos primeros invitados se admiten siempre que el equipo no esté sobrecargado.
pub const GUARANTEED_GUESTS: usize = 2;

/// ¿Admitir un invitado más? Combina el máximo configurado con la carga real del equipo.
/// Sin muestra todavía (arranque) solo rige el máximo configurado.
pub fn admission(
    sample: Option<&Sample>,
    admitted: usize,
    max_guests: usize,
    encoder: Option<&Value>,
    live: bool,
) -> Result<(), String> {
    if admitted >= max_guests {
        return Err(format!(
            "Máximo de {max_guests} invitados admitidos (configurable con MAX_GUESTS)"
        ));
    }
    let Some(s) = sample else { return Ok(()) };
    let a = advise(
        s,
        &Load {
            participants: admitted,
            on_program: admitted,
            live,
            encoder,
        },
    );
    if a["level"] == "critical" {
        let why = a["reasons"][0].as_str().unwrap_or("recursos al límite");
        return Err(format!(
            "El equipo está sobrecargado, no se pueden admitir más invitados: {why}"
        ));
    }
    if admitted >= GUARANTEED_GUESTS && a["more_guests"].as_i64().unwrap_or(0) < 1 {
        return Err(format!(
            "Sin margen de hardware para más invitados (equipo: CPU {:.0} %, memoria {:.0} %)",
            s.cpu,
            if s.mem_total > 0 {
                s.mem_used as f32 * 100.0 / s.mem_total as f32
            } else {
                0.0
            }
        ));
    }
    Ok(())
}
