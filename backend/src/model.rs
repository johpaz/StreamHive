use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const ROOM: &str = "streamhive-studio";
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    #[default]
    Landscape,
    Portrait,
}
impl OutputFormat {
    pub fn dimensions(self) -> (u32, u32) {
        match self {
            Self::Landscape => (1920, 1080),
            Self::Portrait => (1080, 1920),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Landscape => "landscape",
            Self::Portrait => "portrait",
        }
    }
    pub fn session_id(self, broadcast: &str) -> String {
        match self {
            Self::Landscape => broadcast.to_owned(),
            Self::Portrait => format!("{broadcast}-portrait"),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub name: String,
    pub format: OutputFormat,
    pub program: Program,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    #[default]
    Grid,
    Spotlight,
    Screen,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ContentMode {
    #[default]
    Side,
    Pip,
    Full,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Playback {
    pub playing: bool,
    pub position: f64,
    pub started_at_ms: Option<u64>,
    pub volume: f64,
    pub looped: bool,
}
impl Default for Playback {
    fn default() -> Self {
        Self {
            playing: false,
            position: 0.0,
            started_at_ms: None,
            volume: 1.0,
            looped: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub filename: String,
    pub mime: String,
    pub kind: String,
    pub bytes: u64,
    pub created: u64,
}
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
fn yes() -> bool {
    true
}
fn default_corner() -> String {
    "bottom_right".into()
}
fn default_background() -> String {
    "#101923".into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Program {
    pub revision: u64,
    pub layout: Layout,
    pub identities: Vec<String>,
    pub spotlight: Option<String>,
    pub screen: Option<String>,
    pub screen_audio: bool,
    pub names: bool,
    pub logo: Option<String>,
    #[serde(default)]
    pub media_asset: Option<String>,
    #[serde(default)]
    pub content_mode: ContentMode,
    #[serde(default = "default_corner")]
    pub pip_position: String,
    #[serde(default = "yes")]
    pub microphones_enabled: bool,
    #[serde(default = "default_background")]
    pub background: String,
    #[serde(default)]
    pub background_asset: Option<String>,
    #[serde(default)]
    pub playback: Playback,
}
impl Default for Program {
    fn default() -> Self {
        Self {
            revision: 0,
            layout: Layout::Grid,
            identities: vec![],
            spotlight: None,
            screen: None,
            screen_audio: false,
            names: true,
            logo: None,
            media_asset: None,
            content_mode: ContentMode::Side,
            pip_position: default_corner(),
            microphones_enabled: true,
            background: default_background(),
            background_asset: None,
            playback: Playback::default(),
        }
    }
}
/// Pantallas genéricas que sustituyen al programa: inicio, pausa y fin.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SlateKind {
    Start,
    Pause,
    End,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Slate {
    pub title: String,
    pub subtitle: String,
    /// Duración del temporizador; 0 significa sin temporizador.
    pub timer_seconds: u32,
    pub timer_label: String,
    /// Texto que sustituye al temporizador cuando llega a cero.
    pub done_label: String,
    pub background: String,
    pub background_asset: Option<String>,
    pub show_logo: bool,
    pub music_asset: Option<String>,
    pub music_volume: f64,
    /// Al llegar a cero: inicio y pausa vuelven al programa; fin termina la sesión.
    pub auto_on_timer_end: bool,
    /// Solo inicio: se muestra sola al empezar el directo.
    pub show_on_go_live: bool,
}
impl Default for Slate {
    fn default() -> Self {
        Self {
            title: "Empezamos pronto".into(),
            subtitle: String::new(),
            timer_seconds: 0,
            timer_label: String::new(),
            done_label: String::new(),
            background: default_background(),
            background_asset: None,
            show_logo: true,
            music_asset: None,
            music_volume: 0.5,
            auto_on_timer_end: false,
            show_on_go_live: false,
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Slates {
    pub start: Slate,
    pub pause: Slate,
    pub end: Slate,
}
impl Default for Slates {
    fn default() -> Self {
        Self {
            start: Slate {
                title: "Empezamos pronto".into(),
                timer_seconds: 300,
                timer_label: "Empezamos en".into(),
                done_label: "Empezamos enseguida".into(),
                show_on_go_live: true,
                ..Slate::default()
            },
            pause: Slate {
                title: "Volvemos enseguida".into(),
                timer_seconds: 300,
                timer_label: "Volvemos en".into(),
                done_label: "Ya casi estamos de vuelta".into(),
                ..Slate::default()
            },
            end: Slate {
                title: "Gracias por acompañarnos".into(),
                ..Slate::default()
            },
        }
    }
}
impl Slates {
    pub fn get(&self, kind: SlateKind) -> &Slate {
        match kind {
            SlateKind::Start => &self.start,
            SlateKind::Pause => &self.pause,
            SlateKind::End => &self.end,
        }
    }
    pub fn get_mut(&mut self, kind: SlateKind) -> &mut Slate {
        match kind {
            SlateKind::Start => &mut self.start,
            SlateKind::Pause => &mut self.pause,
            SlateKind::End => &mut self.end,
        }
    }
    pub fn uses_asset(&self, asset: &str) -> bool {
        [&self.start, &self.pause, &self.end].iter().any(|s| {
            s.background_asset.as_deref() == Some(asset) || s.music_asset.as_deref() == Some(asset)
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ActiveSlate {
    pub kind: SlateKind,
    pub started_at_ms: u64,
    pub ends_at_ms: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Participant {
    pub id: String,
    pub name: String,
    pub status: String,
    pub invite: String,
    pub created: u64,
    pub connected: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Invitation {
    pub id: String,
    pub hash: String,
    pub expires: u64,
    pub revoked: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Broadcast {
    pub id: String,
    pub egress_id: Option<String>,
    pub status: String,
    pub created: u64,
    pub ended: Option<u64>,
    pub error: Option<String>,
    pub renderer_hash: String,
    pub renderer_revision: Option<u64>,
    #[serde(default)]
    pub outputs: BTreeMap<String, String>,
    /// Safe destination IDs and states only; stream URLs never enter snapshots.
    #[serde(default)]
    pub destination_statuses: BTreeMap<String, String>,
    #[serde(default)]
    pub renderer_revisions: BTreeMap<String, u64>,
    /// Servicios activos de la sesión. Las sesiones anteriores hacían siempre ambos.
    #[serde(default = "enabled")]
    pub live: bool,
    #[serde(default = "enabled")]
    pub recording: bool,
}
fn enabled() -> bool {
    true
}
impl Broadcast {
    pub fn running(&self) -> bool {
        matches!(
            self.status.as_str(),
            "starting" | "live" | "reconnecting" | "ending" | "uncertain"
        )
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: String,
    /// Sesión de salida que la produce; una sesión puede grabar varias veces.
    #[serde(default)]
    pub session: String,
    /// Carpeta elegida al grabar; sin valor está en la predeterminada.
    #[serde(default)]
    pub directory: Option<String>,
    pub filename: String,
    pub created: u64,
    pub status: String,
    pub bytes: u64,
    pub duration: f64,
}
/// Plataforma de salida. Solo `sealed` (URL + clave de transmisión) es secreto y va cifrado.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StoredDestination {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub enabled: bool,
    pub sealed: String,
    #[serde(default)]
    pub sealed_server: Option<String>,
    #[serde(default)]
    pub format: OutputFormat,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Data {
    pub program: Program,
    #[serde(default)]
    pub portrait_program: Program,
    #[serde(default)]
    pub scenes: Vec<Scene>,
    pub participants: BTreeMap<String, Participant>,
    pub invitations: BTreeMap<String, Invitation>,
    pub broadcasts: Vec<Broadcast>,
    pub recordings: Vec<Recording>,
    /// Destino único de versiones anteriores; se migra a `destinations` al arrancar.
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub destinations: Vec<StoredDestination>,
    #[serde(default)]
    pub assets: BTreeMap<String, Asset>,
    /// Carpeta elegida para las grabaciones nuevas; sin valor se usa la predeterminada.
    #[serde(default)]
    pub recordings_dir: Option<String>,
    #[serde(default)]
    pub slates: Slates,
    /// Pantalla al aire. Vive fuera del programa: afecta a los dos formatos a la vez,
    /// las escenas no la capturan y el programa se puede preparar debajo sin que se vea.
    #[serde(default)]
    pub active_slate: Option<ActiveSlate>,
}
impl Recording {
    /// Cada grabación sigue en su carpeta aunque luego se elija otra.
    pub fn path(&self, default: &std::path::Path) -> std::path::PathBuf {
        self.directory
            .as_deref()
            .map_or(default, std::path::Path::new)
            .join(&self.filename)
    }
    pub fn belongs_to(&self, broadcast: &str) -> bool {
        let portrait = OutputFormat::Portrait.session_id(broadcast);
        [self.id.as_str(), self.session.as_str()]
            .iter()
            .any(|x| *x == broadcast || *x == portrait)
    }
}
impl Data {
    pub fn validate_slate(&self, slate: &Slate) -> Result<(), &'static str> {
        let line = |text: &str| text.chars().count() <= 60 && !text.chars().any(char::is_control);
        if slate.title.trim().is_empty() {
            return Err("La pantalla necesita un título");
        }
        if ![
            &slate.title,
            &slate.subtitle,
            &slate.timer_label,
            &slate.done_label,
        ]
        .iter()
        .all(|text| line(text))
        {
            return Err("Los textos admiten una línea de hasta 60 caracteres");
        }
        if slate.timer_seconds > 21_600 {
            return Err("El temporizador admite hasta 6 horas");
        }
        if slate.background.len() != 7
            || !slate.background.starts_with('#')
            || !slate.background[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Color de fondo inválido");
        }
        if slate
            .background_asset
            .as_ref()
            .is_some_and(|id| !self.assets.get(id).is_some_and(|a| a.kind == "image"))
        {
            return Err("Selecciona una imagen existente para el fondo");
        }
        if slate
            .music_asset
            .as_ref()
            .is_some_and(|id| !self.assets.get(id).is_some_and(|a| a.kind == "audio"))
        {
            return Err("Selecciona un audio existente para la música");
        }
        if !slate.music_volume.is_finite() || !(0.0..=1.0).contains(&slate.music_volume) {
            return Err("Volumen de música inválido");
        }
        Ok(())
    }
    /// Mueve el destino único de versiones anteriores a la lista. Devuelve si hubo cambios.
    pub fn migrate_legacy_destination(&mut self, new_id: String) -> bool {
        let Some(sealed) = self.destination.take() else {
            return false;
        };
        if self.destinations.is_empty() {
            self.destinations.push(StoredDestination {
                id: new_id,
                name: "Principal".into(),
                platform: "custom".into(),
                enabled: true,
                sealed,
                sealed_server: None,
                format: OutputFormat::Landscape,
            });
        }
        true
    }
    pub fn active(&self) -> Option<&Broadcast> {
        self.broadcasts.iter().rev().find(|x| x.running())
    }
    pub fn remove_from_program(&mut self, identity: &str) {
        for program in std::iter::once(&mut self.program)
            .chain(std::iter::once(&mut self.portrait_program))
            .chain(self.scenes.iter_mut().map(|s| &mut s.program))
        {
            program.identities.retain(|x| x != identity);
            if program.screen.as_deref() == Some(identity) {
                program.screen = None;
                program.layout = Layout::Grid;
            }
            if program.spotlight.as_deref() == Some(identity) {
                program.spotlight = None;
                if program.layout == Layout::Spotlight {
                    program.layout = Layout::Grid;
                }
            }
            program.revision += 1;
        }
    }
    pub fn program_for(&self, format: OutputFormat) -> &Program {
        match format {
            OutputFormat::Landscape => &self.program,
            OutputFormat::Portrait => &self.portrait_program,
        }
    }
    pub fn program_for_mut(&mut self, format: OutputFormat) -> &mut Program {
        match format {
            OutputFormat::Landscape => &mut self.program,
            OutputFormat::Portrait => &mut self.portrait_program,
        }
    }
    #[cfg(test)]
    pub fn validate_program(&self, p: &Program) -> Result<(), &'static str> {
        self.validate_program_for(p, OutputFormat::Landscape)
    }
    pub fn validate_program_for(
        &self,
        p: &Program,
        format: OutputFormat,
    ) -> Result<(), &'static str> {
        if p.revision != self.program_for(format).revision {
            return Err("La escena cambió; actualiza antes de guardar");
        }
        if p.identities.len() > 6 {
            return Err("Máximo seis cámaras");
        }
        let mut unique = std::collections::HashSet::new();
        for identity in p
            .identities
            .iter()
            .chain(p.screen.iter())
            .chain(p.spotlight.iter())
        {
            if identity != "host"
                && !self
                    .participants
                    .get(identity)
                    .is_some_and(|x| x.status == "admitted")
            {
                return Err("Participante no admitido");
            }
        }
        for identity in &p.identities {
            if !unique.insert(identity) {
                return Err("Cámara duplicada");
            }
        }
        if p.layout == Layout::Spotlight
            && !p
                .spotlight
                .as_ref()
                .is_some_and(|s| p.identities.contains(s))
        {
            return Err("Selecciona un protagonista al aire");
        }
        if p.media_asset.is_some() && (p.screen.is_some() || p.layout != Layout::Screen) {
            return Err("Selecciona una sola fuente de contenido");
        }
        if p.media_asset
            .as_ref()
            .is_some_and(|id| !self.assets.contains_key(id))
        {
            return Err("Archivo inexistente");
        }
        if p.media_asset
            .as_ref()
            .and_then(|id| self.assets.get(id))
            .is_some_and(|a| a.kind == "audio")
        {
            return Err("El audio solo se puede usar como música de una pantalla");
        }
        if !["bottom_right", "bottom_left", "top_right", "top_left"]
            .contains(&p.pip_position.as_str())
        {
            return Err("Posición de cámara inválida");
        }
        if p.background_asset
            .as_ref()
            .is_some_and(|id| !self.assets.get(id).is_some_and(|a| a.kind == "image"))
        {
            return Err("Selecciona una imagen existente para el fondo");
        }
        if p.background.len() != 7
            || !p.background.starts_with('#')
            || !p.background[1..].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Color de fondo inválido");
        }
        if !p.playback.position.is_finite()
            || p.playback.position < 0.0
            || p.playback.position > 86400.0
            || !p.playback.volume.is_finite()
            || !(0.0..=1.0).contains(&p.playback.volume)
        {
            return Err("Controles de video inválidos");
        }
        if p.layout == Layout::Screen && p.screen.is_none() && p.media_asset.is_none() {
            return Err("Selecciona una pantalla");
        }
        if p.logo.as_ref().is_some_and(|x| {
            !x.starts_with("data:image/png;base64,") && !x.starts_with("data:image/jpeg;base64,")
        }) {
            return Err("Logo: solo PNG o JPEG");
        }
        if p.logo.as_ref().is_some_and(|x| x.len() > 400_000) {
            return Err("Logo demasiado grande");
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stage_background_requires_an_existing_image() {
        let mut d = Data::default();
        let mut p = d.program.clone();
        p.background_asset = Some("background".into());
        assert!(d.validate_program(&p).is_err());
        d.assets.insert(
            "background".into(),
            Asset {
                id: "background".into(),
                name: "Backdrop".into(),
                filename: "background.webm".into(),
                mime: "video/webm".into(),
                kind: "video".into(),
                bytes: 100,
                created: now(),
            },
        );
        assert!(d.validate_program(&p).is_err());
        d.assets.get_mut("background").unwrap().kind = "image".into();
        assert!(d.validate_program(&p).is_ok());
    }
    #[test]
    fn invalid_stage_is_rejected() {
        let d = Data::default();
        let mut p = d.program.clone();
        p.identities = vec!["stranger".into()];
        assert!(d.validate_program(&p).is_err());
    }
    #[test]
    fn stale_revision_and_duplicates_rejected() {
        let d = Data::default();
        let mut p = d.program.clone();
        p.revision = 1;
        assert!(d.validate_program(&p).is_err());
        p.revision = 0;
        p.identities = vec!["host".into(), "host".into()];
        assert!(d.validate_program(&p).is_err());
    }
    #[test]
    fn removing_screen_returns_to_grid() {
        let mut d = Data::default();
        d.program.screen = Some("x".into());
        d.program.layout = Layout::Screen;
        d.remove_from_program("x");
        assert_eq!(d.program.layout, Layout::Grid);
        assert!(d.program.screen.is_none());
    }
    #[test]
    fn removing_a_floating_camera_keeps_the_uploaded_content() {
        let mut d = Data::default();
        d.program.layout = Layout::Screen;
        d.program.media_asset = Some("manual".into());
        d.program.content_mode = ContentMode::Pip;
        d.program.spotlight = Some("guest".into());
        d.program.identities = vec!["guest".into()];
        d.remove_from_program("guest");
        assert_eq!(d.program.layout, Layout::Screen);
        assert_eq!(d.program.media_asset.as_deref(), Some("manual"));
        assert!(d.program.spotlight.is_none());
    }
}
