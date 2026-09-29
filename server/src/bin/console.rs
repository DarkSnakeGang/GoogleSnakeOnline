//! Local control GUI for the multiplayer room server.
//! Serves a True Dark themed dashboard on :7778 that starts/stops/rebuilds
//! the game server on :7777 and streams its logs. Optionally hosts an HTTP
//! reverse-proxy of googlesnakemods.com on :7779 (off by default) with UPnP.

use axum::body::Body;
use axum::extract::{Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use clap::Parser;
use futures_util::stream::Stream;
use multiplayer_server::upnp::{Gateway, UpnpMapping};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, oneshot};
use tower_http::cors::CorsLayer;

const LOG_CAP: usize = 2000;
const DEFAULT_GUI: &str = "0.0.0.0:7778";
const DEFAULT_SERVER: &str = "0.0.0.0:7777";
const DEFAULT_SITE: &str = "0.0.0.0:7779";
const GSM_ORIGIN: &str = "https://googlesnakemods.com";
const MOD_SCRIPT_TAG: &str = r#"<script src="/MultiplayerMod.js"></script>"#;

#[derive(Parser, Debug)]
#[command(
    name = "multiplayer-console",
    about = "True Dark control GUI for the multiplayer room server"
)]
struct Args {
    /// Control GUI bind address
    #[arg(long, env = "MULTIPLAYER_GUI_BIND", default_value = DEFAULT_GUI)]
    gui_bind: SocketAddr,

    /// Game server bind passed to multiplayer-server
    #[arg(long, env = "MULTIPLAYER_BIND", default_value = DEFAULT_SERVER)]
    server_bind: SocketAddr,

    /// Optional GSM HTTP host bind (off until Start site; default :7779)
    #[arg(long, env = "MULTIPLAYER_SITE_BIND", default_value = DEFAULT_SITE)]
    site_bind: SocketAddr,

    /// Path to server/Cargo.toml (auto-detected from CWD when empty)
    #[arg(long, env = "MULTIPLAYER_MANIFEST", default_value = "")]
    manifest: String,

    /// Extra args forwarded to multiplayer-server (after --)
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    server_args: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    Idle,
    Starting,
    Running,
    Stopping,
    Rebuilding,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SitePhase {
    Idle,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Clone, Debug, Serialize)]
struct Status {
    phase: Phase,
    running: bool,
    pid: Option<u32>,
    server_bind: String,
    message: String,
    rebuilding: bool,
    site_phase: SitePhase,
    site_running: bool,
    site_bind: String,
    site_message: String,
    site_public_url: Option<String>,
    secure_wss: bool,
    acme_staging: bool,
    public_ws: Option<String>,
    duckdns_domain: String,
    /// Whether a DuckDNS token is saved (the token itself is never sent to the page).
    duckdns_token_set: bool,
    game_port: u16,
    game_upnp: bool,
    /// `ip:port` while the console holds the game server's router forward.
    game_upnp_open: Option<String>,
    game_upnp_error: Option<String>,
    site_port: u16,
    site_upnp: bool,
    site_upnp_error: Option<String>,
}

/// Persisted host toggles (`console-settings.json` in the repo root, git-ignored).
#[derive(Clone, Serialize, Deserialize)]
struct ConsoleSettings {
    #[serde(default)]
    secure_wss: bool,
    #[serde(default)]
    acme_staging: bool,
    #[serde(default = "default_duckdns_domain")]
    duckdns_domain: String,
    #[serde(default)]
    duckdns_token: String,
    /// Overrides the port of `--server-bind` / `--site-bind` when set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    game_port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    site_port: Option<u16>,
    #[serde(default = "default_true")]
    game_upnp: bool,
    #[serde(default = "default_true")]
    site_upnp: bool,
}

impl Default for ConsoleSettings {
    fn default() -> Self {
        Self {
            secure_wss: false,
            acme_staging: false,
            duckdns_domain: default_duckdns_domain(),
            duckdns_token: String::new(),
            game_port: None,
            site_port: None,
            game_upnp: true,
            site_upnp: true,
        }
    }
}

fn default_duckdns_domain() -> String {
    "yarmiplay".into()
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Service {
    Game,
    Site,
}

/// `POST /api/upnp` body.
#[derive(Deserialize)]
struct UpnpRequest {
    target: Service,
    enabled: bool,
}

/// `POST /api/port` body.
#[derive(Deserialize)]
struct PortRequest {
    target: Service,
    port: u16,
}

/// `POST /api/secure` body; an absent or blank token keeps the saved one.
#[derive(Deserialize)]
struct SecureRequest {
    secure_wss: bool,
    acme_staging: bool,
    #[serde(default)]
    duckdns_domain: Option<String>,
    #[serde(default)]
    duckdns_token: Option<String>,
}

const SETTINGS_FILE: &str = "console-settings.json";
const PUBLIC_URL_MARKER: &str = "Public join URL: ";
const ACME_FALLBACK_MARKER: &str = "ACME fallback: serving plain ws://";

fn load_settings(repo_root: &std::path::Path) -> ConsoleSettings {
    std::fs::read_to_string(repo_root.join(SETTINGS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn with_port(bind: SocketAddr, port: Option<u16>) -> SocketAddr {
    SocketAddr::new(bind.ip(), port.filter(|p| *p != 0).unwrap_or(bind.port()))
}

fn save_settings(repo_root: &std::path::Path, settings: &ConsoleSettings) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    std::fs::write(repo_root.join(SETTINGS_FILE), json)
}

struct Shared {
    phase: Mutex<Phase>,
    message: Mutex<String>,
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
    log_lines: Mutex<Vec<LogEntry>>,
    log_tx: broadcast::Sender<LogEntry>,
    busy: AtomicBool,
    server_bind: Mutex<SocketAddr>,
    site_bind: Mutex<SocketAddr>,
    /// CLI binds; a saved port is only written when it differs from these.
    default_server_bind: SocketAddr,
    default_site_bind: SocketAddr,
    gui_port: u16,
    game_upnp: AtomicBool,
    game_upnp_gateway: Mutex<Option<Gateway>>,
    game_upnp_ip: Mutex<Option<IpAddr>>,
    game_upnp_error: Mutex<Option<String>>,
    site_phase: Mutex<SitePhase>,
    site_message: Mutex<String>,
    site_public_url: Mutex<Option<String>>,
    site_upnp: Mutex<Option<Gateway>>,
    site_upnp_enabled: AtomicBool,
    site_upnp_error: Mutex<Option<String>>,
    site_local: Mutex<Option<SocketAddr>>,
    site_busy: AtomicBool,
    secure_wss: AtomicBool,
    acme_staging: AtomicBool,
    duckdns_domain: Mutex<String>,
    duckdns_token: Mutex<String>,
    /// Latest `Public join URL:` announced by the game server.
    public_ws: Mutex<Option<String>>,
    /// Whether the running child was started with --acme (serves https/wss).
    running_tls: AtomicBool,
    site_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    /// Signal to quit the console GUI process itself (ends start-server.bat / cargo).
    console_shutdown: Mutex<Option<oneshot::Sender<()>>>,
    http_client: reqwest::Client,
    manifest: PathBuf,
    repo_root: PathBuf,
    server_bin: PathBuf,
    extra_args: Vec<String>,
    /// Same-origin fruit sprite cache (Google CDN bytes).
    fruit_sprites: Mutex<HashMap<u32, Arc<Vec<u8>>>>,
}

impl Shared {
    fn status(&self) -> Status {
        let phase = *self.phase.lock();
        let site_phase = *self.site_phase.lock();
        let server_bind = self.server_bind();
        let game_upnp_ip = *self.game_upnp_ip.lock();
        // Plain ws:// servers announce nothing — the join URL is the console's forward.
        let public_ws = self.public_ws.lock().clone().or_else(|| {
            let plain = !self.running_tls.load(Ordering::SeqCst);
            game_upnp_ip
                .filter(|_| plain && matches!(phase, Phase::Running))
                .map(|ip| format!("ws://{ip}:{}/ws", server_bind.port()))
        });
        Status {
            phase,
            running: matches!(phase, Phase::Running | Phase::Starting),
            pid: *self.pid.lock(),
            server_bind: server_bind.to_string(),
            message: self.message.lock().clone(),
            rebuilding: phase == Phase::Rebuilding,
            site_phase,
            site_running: matches!(site_phase, SitePhase::Running | SitePhase::Starting),
            site_bind: self.site_bind().to_string(),
            site_message: self.site_message.lock().clone(),
            site_public_url: self.site_public_url.lock().clone(),
            secure_wss: self.secure_wss.load(Ordering::SeqCst),
            acme_staging: self.acme_staging.load(Ordering::SeqCst),
            public_ws,
            duckdns_domain: self.duckdns_domain.lock().clone(),
            duckdns_token_set: !self.duckdns_token.lock().is_empty(),
            game_port: server_bind.port(),
            game_upnp: self.game_upnp.load(Ordering::SeqCst),
            game_upnp_open: game_upnp_ip.map(|ip| format!("{ip}:{}", server_bind.port())),
            game_upnp_error: self.game_upnp_error.lock().clone(),
            site_port: self.site_bind().port(),
            site_upnp: self.site_upnp_enabled.load(Ordering::SeqCst),
            site_upnp_error: self.site_upnp_error.lock().clone(),
        }
    }

    fn server_bind(&self) -> SocketAddr {
        *self.server_bind.lock()
    }

    fn site_bind(&self) -> SocketAddr {
        *self.site_bind.lock()
    }

    fn settings(&self) -> ConsoleSettings {
        let game_port = self.server_bind().port();
        let site_port = self.site_bind().port();
        ConsoleSettings {
            secure_wss: self.secure_wss.load(Ordering::SeqCst),
            acme_staging: self.acme_staging.load(Ordering::SeqCst),
            duckdns_domain: self.duckdns_domain.lock().clone(),
            duckdns_token: self.duckdns_token.lock().clone(),
            game_port: (game_port != self.default_server_bind.port()).then_some(game_port),
            site_port: (site_port != self.default_site_bind.port()).then_some(site_port),
            game_upnp: self.game_upnp.load(Ordering::SeqCst),
            site_upnp: self.site_upnp_enabled.load(Ordering::SeqCst),
        }
    }

    fn save(&self) {
        if let Err(e) = save_settings(&self.repo_root, &self.settings()) {
            self.push_log(format!("[console] could not save {SETTINGS_FILE}: {e}"));
        }
    }

    fn set_phase(&self, phase: Phase, message: String) {
        *self.phase.lock() = phase;
        *self.message.lock() = message;
    }

    fn set_site_phase(&self, phase: SitePhase, message: String) {
        *self.site_phase.lock() = phase;
        *self.site_message.lock() = message;
    }

    fn push_log(&self, line: String) {
        let entry = LogEntry {
            t: chrono::Utc::now().timestamp_millis(),
            line: strip_ansi(&line),
        };
        {
            let mut lines = self.log_lines.lock();
            lines.push(entry.clone());
            if lines.len() > LOG_CAP {
                let drain = lines.len() - LOG_CAP;
                lines.drain(0..drain);
            }
        }
        let _ = self.log_tx.send(entry);
    }
}

/// One console log line with the time it arrived (Unix ms), sent to the page as JSON.
#[derive(Clone, Serialize)]
struct LogEntry {
    t: i64,
    line: String,
}

impl LogEntry {
    fn event(&self) -> Event {
        Event::default()
            .event("log")
            .data(serde_json::to_string(self).unwrap_or_default())
    }
}

/// Drop CSI / OSC color codes so the HTML log pane stays readable.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('[') => {
                // CSI: ESC [ ... final-byte
                chars.next();
                while let Some(n) = chars.next() {
                    if ('\x40'..='\x7e').contains(&n) {
                        break;
                    }
                }
            }
            Some(']') => {
                // OSC: ESC ] ... BEL or ST (ESC \)
                chars.next();
                while let Some(n) = chars.next() {
                    if n == '\u{7}' {
                        break;
                    }
                    if n == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => {
                // Skip a single-char intermediate escape if present.
                chars.next();
            }
            None => {}
        }
    }
    out
}

fn resolve_paths(manifest_arg: &str) -> (PathBuf, PathBuf, PathBuf) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let manifest = if manifest_arg.is_empty() {
        let a = cwd.join("server").join("Cargo.toml");
        let b = cwd.join("Cargo.toml");
        if a.is_file() {
            a
        } else if b.is_file() {
            b
        } else {
            a
        }
    } else {
        PathBuf::from(manifest_arg)
    };
    let server_dir = manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| cwd.clone());
    let repo_root = server_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| server_dir.clone());
    let exe_name = if cfg!(windows) {
        "multiplayer-server.exe"
    } else {
        "multiplayer-server"
    };
    let server_bin = server_dir.join("target").join("release").join(exe_name);
    (manifest, repo_root, server_bin)
}

#[tokio::main]
async fn main() {
    // reqwest uses rustls-tls-*-no-provider — must install a CryptoProvider
    // before Client::new() (even for plain http:// status probes).
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("rustls CryptoProvider::install_default(ring) failed");

    let args = Args::parse();
    let (manifest, repo_root, server_bin) = resolve_paths(&args.manifest);
    let settings = load_settings(&repo_root);
    let (log_tx, _) = broadcast::channel(512);
    let http_client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("GoogleSnakeLAN-console-site/1.0")
        .build()
        .expect("reqwest Client");
    let (console_shutdown_tx, console_shutdown_rx) = oneshot::channel::<()>();
    let shared = Arc::new(Shared {
        phase: Mutex::new(Phase::Idle),
        message: Mutex::new("Ready".into()),
        child: Mutex::new(None),
        pid: Mutex::new(None),
        log_lines: Mutex::new(Vec::new()),
        log_tx,
        busy: AtomicBool::new(false),
        server_bind: Mutex::new(with_port(args.server_bind, settings.game_port)),
        site_bind: Mutex::new(with_port(args.site_bind, settings.site_port)),
        default_server_bind: args.server_bind,
        default_site_bind: args.site_bind,
        gui_port: args.gui_bind.port(),
        game_upnp: AtomicBool::new(settings.game_upnp),
        game_upnp_gateway: Mutex::new(None),
        game_upnp_ip: Mutex::new(None),
        game_upnp_error: Mutex::new(None),
        site_phase: Mutex::new(SitePhase::Idle),
        site_message: Mutex::new("Site host off".into()),
        site_public_url: Mutex::new(None),
        site_upnp: Mutex::new(None),
        site_upnp_enabled: AtomicBool::new(settings.site_upnp),
        site_upnp_error: Mutex::new(None),
        site_local: Mutex::new(None),
        site_busy: AtomicBool::new(false),
        secure_wss: AtomicBool::new(settings.secure_wss),
        acme_staging: AtomicBool::new(settings.acme_staging),
        duckdns_domain: Mutex::new(settings.duckdns_domain.clone()),
        duckdns_token: Mutex::new(settings.duckdns_token.clone()),
        public_ws: Mutex::new(None),
        running_tls: AtomicBool::new(false),
        site_shutdown: Mutex::new(None),
        console_shutdown: Mutex::new(Some(console_shutdown_tx)),
        http_client,
        manifest,
        repo_root,
        server_bin,
        extra_args: args.server_args,
        fruit_sprites: Mutex::new(HashMap::new()),
    });

    shared.push_log(format!(
        "[console] GUI http://{}  ·  game server {}  ·  site host {} (off until Start site)",
        args.gui_bind,
        shared.server_bind(),
        shared.site_bind()
    ));
    shared.push_log(format!(
        "[console] manifest {}  ·  bin {}",
        shared.manifest.display(),
        shared.server_bin.display()
    ));

    // Auto-start if a release binary already exists; otherwise idle until Restart.
    // Site host stays off until the user presses Start site.
    if shared.server_bin.is_file() {
        let s = shared.clone();
        tokio::spawn(async move {
            let _ = start_server(s).await;
        });
    } else {
        shared.push_log(
            "[console] No release binary yet — press Restart to cargo build --release".into(),
        );
    }

    let app = Router::new()
        .route("/", get(index))
        .route("/api/status", get(api_status))
        .route("/api/start", post(api_start))
        .route("/api/stop", post(api_stop))
        .route("/api/restart", post(api_restart))
        .route("/api/shutdown", post(api_shutdown))
        .route("/api/site/start", post(api_site_start))
        .route("/api/site/stop", post(api_site_stop))
        .route("/api/secure", post(api_secure))
        .route("/api/upnp", post(api_upnp))
        .route("/api/port", post(api_port))
        .route("/api/logs", get(api_logs))
        .route("/api/rooms", get(api_rooms_proxy))
        .route("/api/spectate", get(api_spectate_proxy))
        .route("/api/fruit/{idx}", get(api_fruit_sprite))
        .layer(CorsLayer::permissive())
        .with_state(shared.clone());

    let listener = tokio::net::TcpListener::bind(args.gui_bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("failed to bind GUI on {}: {e}", args.gui_bind);
            std::process::exit(1);
        });
    let local = listener.local_addr().unwrap();
    eprintln!(
        "Multiplayer console (True Dark)  http://{local}\nGame server target  {}\nSite host (off)     {}\n",
        shared.server_bind(),
        shared.site_bind()
    );
    let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = console_shutdown_rx => {}
        }
    });
    if let Err(e) = serve.await {
        eprintln!("console serve error: {e}");
    }
    // Best-effort: tear down game server + site host + UPnP on console exit.
    let _ = stop_server_inner(shared.clone()).await;
    let _ = stop_site_inner(shared).await;
}

async fn api_status(State(s): State<Arc<Shared>>) -> Json<Status> {
    // Reap exited children
    {
        let mut child = s.child.lock();
        if let Some(c) = child.as_mut() {
            match c.try_wait() {
                Ok(Some(status)) => {
                    let pid = *s.pid.lock();
                    s.push_log(format!(
                        "[console] server exited (pid {}) status {status}",
                        pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())
                    ));
                    *child = None;
                    *s.pid.lock() = None;
                    if *s.phase.lock() == Phase::Running {
                        s.set_phase(Phase::Idle, "Server stopped".to_string());
                    }
                }
                Ok(None) => {}
                Err(e) => {
                    s.push_log(format!("[console] wait error: {e}"));
                }
            }
        }
    }
    Json(s.status())
}

async fn api_start(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    match start_server(s).await {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

async fn api_stop(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    match stop_server(s).await {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

async fn api_restart(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    match restart_server(s).await {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

/// Stop game server + site host, then quit the console process (ends cargo / .bat).
async fn api_shutdown(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    s.push_log("[console] Shutdown requested — stopping hosts, then quitting…".into());
    s.set_phase(Phase::Stopping, "Shutting down console…".into());
    let _ = stop_server_inner(s.clone()).await;
    let _ = stop_site_inner(s.clone()).await;
    s.set_phase(Phase::Idle, "Console exiting…".into());
    let st = s.status();
    // Defer the quit signal so this HTTP response can flush first.
    let tx = s.console_shutdown.lock().take();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
        // Hard exit so cargo run / start-server.bat do not hang on stray tasks.
        tokio::time::sleep(Duration::from_millis(400)).await;
        std::process::exit(0);
    });
    (axum::http::StatusCode::OK, Json(st))
}

async fn api_site_start(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    match start_site(s).await {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

async fn api_site_stop(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Status>) {
    match stop_site(s).await {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

/// Persist Secure WSS / staging / DuckDNS settings; restart a running server so they apply.
async fn api_secure(
    State(s): State<Arc<Shared>>,
    Json(req): Json<SecureRequest>,
) -> (axum::http::StatusCode, Json<Status>) {
    let secure_changed = s.secure_wss.swap(req.secure_wss, Ordering::SeqCst) != req.secure_wss;
    let staging_changed = s.acme_staging.swap(req.acme_staging, Ordering::SeqCst) != req.acme_staging;
    let mut changed = secure_changed || staging_changed;
    if let Some(domain) = req.duckdns_domain.map(|d| d.trim().to_string()) {
        let mut cur = s.duckdns_domain.lock();
        if *cur != domain {
            *cur = domain;
            changed = true;
        }
    }
    if let Some(token) = req.duckdns_token.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
        let mut cur = s.duckdns_token.lock();
        if *cur != token {
            *cur = token;
            changed = true;
        }
    }
    s.save();
    let duck = duckdns_label(&s);
    s.push_log(format!(
        "[console] Secure WSS {}{}",
        if req.secure_wss { format!("on (Let's Encrypt, {duck})") } else { "off (plain ws://)".into() },
        if req.secure_wss && req.acme_staging { " · staging CA" } else { "" }
    ));
    if !changed || s.child.lock().is_none() {
        return (axum::http::StatusCode::OK, Json(s.status()));
    }
    if s
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        s.push_log("[console] busy — Secure WSS applies on next Start".into());
        return (axum::http::StatusCode::OK, Json(s.status()));
    }
    s.push_log("[console] restarting game server to apply Secure WSS…".into());
    let _ = stop_server_inner(s.clone()).await;
    let result = start_server_inner(s.clone()).await;
    s.busy.store(false, Ordering::SeqCst);
    match result {
        Ok(st) => (axum::http::StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

/// Start/stop one service's router forward without restarting the service.
async fn api_upnp(
    State(s): State<Arc<Shared>>,
    Json(req): Json<UpnpRequest>,
) -> (StatusCode, Json<Status>) {
    let label = if req.enabled { "on" } else { "off" };
    match req.target {
        Service::Game => {
            s.game_upnp.store(req.enabled, Ordering::SeqCst);
            s.save();
            if matches!(*s.phase.lock(), Phase::Running | Phase::Starting) {
                if req.enabled {
                    open_game_upnp(&s).await;
                } else {
                    close_game_upnp(&s, s.server_bind().port()).await;
                }
            } else {
                s.push_log(format!("[console] game UPnP {label} — applies when the server starts"));
            }
        }
        Service::Site => {
            s.site_upnp_enabled.store(req.enabled, Ordering::SeqCst);
            s.save();
            if s.site_local.lock().is_some() {
                if req.enabled {
                    open_site_upnp(&s).await;
                } else {
                    close_site_upnp(&s, s.site_bind().port()).await;
                }
                refresh_site_message(&s);
            } else {
                s.push_log(format!("[console] site UPnP {label} — applies when the site host starts"));
            }
        }
    }
    (StatusCode::OK, Json(s.status()))
}

/// Change one service's port; a running service restarts on the new port.
async fn api_port(
    State(s): State<Arc<Shared>>,
    Json(req): Json<PortRequest>,
) -> (StatusCode, Json<Status>) {
    let port = req.port;
    let (name, current, other) = match req.target {
        Service::Game => ("game server", s.server_bind().port(), s.site_bind().port()),
        Service::Site => ("site host", s.site_bind().port(), s.server_bind().port()),
    };
    let clash = if port == 0 {
        Some("port 0 is not allowed".to_string())
    } else if port == s.gui_port {
        Some(format!("{port} is the console's own port"))
    } else if port == other {
        Some(format!("{port} is already used by the {}", if req.target == Service::Game { "site host" } else { "game server" }))
    } else {
        None
    };
    if let Some(reason) = clash {
        s.push_log(format!("[console] {name} port not changed — {reason}"));
        return (StatusCode::BAD_REQUEST, Json(s.status()));
    }
    if port == current {
        return (StatusCode::OK, Json(s.status()));
    }
    let busy = match req.target {
        Service::Game => &s.busy,
        Service::Site => &s.site_busy,
    };
    if busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        s.push_log(format!("[console] {name} busy — try the port change again in a moment"));
        return (StatusCode::CONFLICT, Json(s.status()));
    }
    let result = match req.target {
        Service::Game => {
            let running = s.child.lock().is_some();
            if running {
                let _ = stop_server_inner(s.clone()).await;
            }
            let bind = s.server_bind();
            *s.server_bind.lock() = SocketAddr::new(bind.ip(), port);
            s.save();
            s.push_log(format!("[console] game server port {current} → {port}"));
            if running { start_server_inner(s.clone()).await } else { Ok(s.status()) }
        }
        Service::Site => {
            let running = s.site_local.lock().is_some();
            if running {
                let _ = stop_site_inner(s.clone()).await;
            }
            let bind = s.site_bind();
            *s.site_bind.lock() = SocketAddr::new(bind.ip(), port);
            s.save();
            s.push_log(format!("[console] site host port {current} → {port}"));
            if running { start_site_inner(s.clone()).await } else { Ok(s.status()) }
        }
    };
    busy.store(false, Ordering::SeqCst);
    match result {
        Ok(st) => (StatusCode::OK, Json(st)),
        Err((code, st)) => (code, Json(st)),
    }
}

async fn open_game_upnp(s: &Arc<Shared>) {
    if s.game_upnp_gateway.lock().is_some() {
        return;
    }
    let port = s.server_bind().port();
    s.push_log(format!("[console] UPnP: opening router forward for game port {port}…"));
    match UpnpMapping::open(port).await {
        Ok((mapping, ip)) => {
            *s.game_upnp_gateway.lock() = mapping.release();
            *s.game_upnp_ip.lock() = Some(ip);
            *s.game_upnp_error.lock() = None;
            s.push_log(format!("[console] UPnP: game port {port} forwarded — open on {ip}:{port}"));
        }
        Err(e) => {
            *s.game_upnp_ip.lock() = None;
            *s.game_upnp_error.lock() = Some(e.clone());
            s.push_log(format!("[console] UPnP: game port {port} not opened ({e}) — LAN only"));
        }
    }
}

async fn close_game_upnp(s: &Arc<Shared>, port: u16) {
    let gateway = s.game_upnp_gateway.lock().take();
    *s.game_upnp_ip.lock() = None;
    *s.game_upnp_error.lock() = None;
    close_forward(s, "game", gateway, port).await;
}

async fn open_site_upnp(s: &Arc<Shared>) {
    if s.site_upnp.lock().is_some() {
        return;
    }
    let port = s.site_bind().port();
    s.push_log(format!("[console] site UPnP: opening TCP {port}…"));
    match UpnpMapping::open(port).await {
        Ok((mapping, external_ip)) => {
            let url = format!("http://{external_ip}:{port}");
            *s.site_public_url.lock() = Some(url.clone());
            *s.site_upnp.lock() = mapping.release();
            *s.site_upnp_error.lock() = None;
            s.push_log(format!("[console] site UPnP: TCP {port} open — friends open {url}"));
        }
        Err(e) => {
            *s.site_public_url.lock() = None;
            *s.site_upnp_error.lock() = Some(e.clone());
            s.push_log(format!("[console] site UPnP: TCP {port} not opened ({e}) — LAN only"));
        }
    }
}

async fn close_site_upnp(s: &Arc<Shared>, port: u16) {
    let gateway = s.site_upnp.lock().take();
    *s.site_public_url.lock() = None;
    *s.site_upnp_error.lock() = None;
    close_forward(s, "site", gateway, port).await;
}

/// Delete a forward via the gateway that created it; without one, only remove
/// a forward that carries our description (never a hand-made router rule).
async fn close_forward(s: &Arc<Shared>, what: &str, gateway: Option<Gateway>, port: u16) {
    let result = match &gateway {
        Some(gw) => multiplayer_server::upnp::delete_mapping_on(gw, port).await.map(|()| true),
        None => multiplayer_server::upnp::delete_tcp_mapping_if_ours(port).await,
    };
    match result {
        Ok(true) => s.push_log(format!("[console] UPnP: {what} TCP {port} closed")),
        Ok(false) => {}
        Err(e) => s.push_log(format!(
            "[console] UPnP: {what} TCP {port} close skipped ({e}) — router may already be clear"
        )),
    }
}

fn refresh_site_message(s: &Shared) {
    let Some(local) = *s.site_local.lock() else { return };
    let message = match (s.site_public_url.lock().clone(), s.site_upnp_error.lock().is_some()) {
        (Some(url), _) => format!("Hosting on http://{local} · public {url}"),
        (None, true) => format!("Hosting on http://{local} (UPnP unavailable)"),
        (None, false) => format!("Hosting on http://{local} (LAN only)"),
    };
    if *s.site_phase.lock() == SitePhase::Running {
        *s.site_message.lock() = message;
    }
}

/// DuckDNS domain + token when both are configured.
fn duckdns_config(s: &Shared) -> Option<(String, String)> {
    let domain = s.duckdns_domain.lock().trim().to_string();
    let token = s.duckdns_token.lock().clone();
    (!domain.is_empty() && !token.is_empty()).then_some((domain, token))
}

fn duckdns_label(s: &Shared) -> String {
    match duckdns_config(s) {
        Some((domain, _)) => format!("DuckDNS {domain}"),
        None => "public IP — no DuckDNS token saved".into(),
    }
}

fn game_http_base(bind: SocketAddr, tls: bool) -> String {
    let host = if bind.ip().is_unspecified() {
        "127.0.0.1".to_string()
    } else {
        bind.ip().to_string()
    };
    let scheme = if tls { "https" } else { "http" };
    format!("{scheme}://{host}:{}", bind.port())
}

#[derive(Debug, Deserialize, Default)]
struct SpectateQuery {
    room: Option<String>,
}

async fn proxy_game_json(
    s: &Shared,
    path: &str,
) -> (axum::http::StatusCode, Json<Value>) {
    if !matches!(*s.phase.lock(), Phase::Running | Phase::Starting) {
        return (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            Json(json_offline("Game server is not running")),
        );
    }
    let tls = s.running_tls.load(Ordering::SeqCst);
    let url = format!("{}{path}", game_http_base(s.server_bind(), tls));
    // Loopback only: the ACME cert names the public IP, not 127.0.0.1.
    let client = match reqwest::Client::builder()
        .danger_accept_invalid_certs(tls)
        .no_proxy()
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_GATEWAY,
                Json(json_offline(&format!("client: {e}"))),
            )
        }
    };
    match client
        .get(&url)
        .timeout(Duration::from_secs(2))
        .send()
        .await
    {
        Ok(res) => {
            let status = axum::http::StatusCode::from_u16(res.status().as_u16())
                .unwrap_or(axum::http::StatusCode::BAD_GATEWAY);
            match res.json::<Value>().await {
                Ok(v) => (status, Json(v)),
                Err(e) => (
                    axum::http::StatusCode::BAD_GATEWAY,
                    Json(json_offline(&format!("Bad spectate payload: {e}"))),
                ),
            }
        }
        Err(e) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json_offline(&format!("Game server unreachable: {e}"))),
        ),
    }
}

fn json_offline(message: &str) -> Value {
    serde_json::json!({
        "mode": null,
        "sessionActive": false,
        "players": [],
        "boards": {},
        "board": null,
        "rooms": [],
        "message": message,
        "offline": true,
    })
}

async fn api_rooms_proxy(State(s): State<Arc<Shared>>) -> (axum::http::StatusCode, Json<Value>) {
    proxy_game_json(&s, "/api/rooms").await
}

async fn api_spectate_proxy(
    State(s): State<Arc<Shared>>,
    Query(q): Query<SpectateQuery>,
) -> (axum::http::StatusCode, Json<Value>) {
    let path = match q.room.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(room) => format!(
            "/api/spectate?room={}",
            urlencoding_loose(room)
        ),
        None => "/api/spectate".to_string(),
    };
    proxy_game_json(&s, &path).await
}

/// Proxy + cache Google Snake fruit sprites so the console can draw them
/// same-origin (CDN hotlink / referrer often leaves only the red-dot fallback).
async fn api_fruit_sprite(
    State(s): State<Arc<Shared>>,
    Path(idx): Path<u32>,
) -> Response {
    let idx = idx.min(99);
    if let Some(bytes) = s.fruit_sprites.lock().get(&idx).cloned() {
        return fruit_png_response(bytes);
    }
    let pad = format!("{idx:02}");
    // Prefer current arcade pack (v18); fall back to v3 for older indices.
    let urls = [
        format!("https://www.google.com/logos/fnbx/snake_arcade/v18/apple_{pad}.png"),
        format!("https://www.google.com/logos/fnbx/snake_arcade/v3/apple_{pad}.png"),
    ];
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .user_agent("GoogleSnakeLAN-console/0.9")
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("fruit client: {e}"),
            )
                .into_response();
        }
    };
    let mut last_err = String::from("unreachable");
    for url in &urls {
        match client.get(url).send().await {
            Ok(res) if res.status().is_success() => {
                match res.bytes().await {
                    Ok(body) if !body.is_empty() => {
                        let arc = Arc::new(body.to_vec());
                        s.fruit_sprites.lock().insert(idx, arc.clone());
                        return fruit_png_response(arc);
                    }
                    Ok(_) => last_err = "empty body".into(),
                    Err(e) => last_err = e.to_string(),
                }
            }
            Ok(res) => last_err = format!("HTTP {}", res.status()),
            Err(e) => last_err = e.to_string(),
        }
    }
    (StatusCode::BAD_GATEWAY, format!("fruit {idx}: {last_err}")).into_response()
}

fn fruit_png_response(bytes: Arc<Vec<u8>>) -> Response {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        bytes.as_ref().clone(),
    )
        .into_response()
}

fn urlencoding_loose(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn api_logs(
    State(s): State<Arc<Shared>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let history = s.log_lines.lock().clone();
    let mut rx = s.log_tx.subscribe();
    let stream = async_stream::stream! {
        yield Ok(Event::default().event("reset").data(""));
        for entry in history {
            yield Ok(entry.event());
        }
        yield Ok(Event::default().event("status").data(
            serde_json::to_string(&s.status()).unwrap_or_else(|_| "{}".into())
        ));
        loop {
            match rx.recv().await {
                Ok(entry) => yield Ok(entry.event()),
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

async fn start_server(
    s: Arc<Shared>,
) -> Result<Status, (axum::http::StatusCode, Status)> {
    if !s.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Status {
                message: "Busy".into(),
                ..s.status()
            },
        ));
    }
    let result = start_server_inner(s.clone()).await;
    s.busy.store(false, Ordering::SeqCst);
    result
}

async fn start_server_inner(
    s: Arc<Shared>,
) -> Result<Status, (axum::http::StatusCode, Status)> {
    if s.child.lock().is_some() {
        return Ok(s.status());
    }
    if !s.server_bin.is_file() {
        s.set_phase(
            Phase::Error,
            "Binary missing — use Restart to build".to_string(),
        );
        s.push_log(format!(
            "[console] missing {}",
            s.server_bin.display()
        ));
        return Err((axum::http::StatusCode::FAILED_DEPENDENCY, s.status()));
    }
    let secure = s.secure_wss.load(Ordering::SeqCst);
    let duckdns = if secure { duckdns_config(&s) } else { None };
    let mut secure_args: Vec<String> = Vec::new();
    if secure {
        secure_args.push("--acme".into());
        if s.acme_staging.load(Ordering::SeqCst) {
            secure_args.push("--acme-staging".into());
        }
        if let Some((domain, _)) = &duckdns {
            secure_args.push("--duckdns-domain".into());
            secure_args.push(domain.clone());
        }
    }
    s.set_phase(
        Phase::Starting,
        if secure {
            "Starting server (requesting Let's Encrypt certificate)…".to_string()
        } else {
            "Starting server…".to_string()
        },
    );
    let bind = s.server_bind();
    s.push_log(format!(
        "[console] spawning {} --bind {bind} {}",
        s.server_bin.display(),
        secure_args.join(" ")
    ));
    *s.public_ws.lock() = None;
    s.running_tls.store(secure, Ordering::SeqCst);
    let mut cmd = Command::new(&s.server_bin);
    cmd.arg("--bind")
        .arg(bind.to_string())
        .args(&secure_args)
        .args(&s.extra_args)
        .current_dir(&s.repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Piped into the HTML log — never emit ANSI (also covers older bins).
        .env("NO_COLOR", "1")
        .env("RUST_LOG_STYLE", "never")
        .env_remove("MULTIPLAYER_DUCKDNS_TOKEN")
        .env_remove("MULTIPLAYER_DUCKDNS_DOMAIN")
        .kill_on_drop(true);
    // Env only: keeps the token off the command line and out of the spawn log line.
    if let Some((_, token)) = &duckdns {
        cmd.env("MULTIPLAYER_DUCKDNS_TOKEN", token);
    }

    match cmd.spawn() {
        Ok(mut child) => {
            let pid = child.id();
            *s.pid.lock() = pid;
            if let Some(out) = child.stdout.take() {
                spawn_pipe_reader(s.clone(), out, "out");
            }
            if let Some(err) = child.stderr.take() {
                spawn_pipe_reader(s.clone(), err, "err");
            }
            *s.child.lock() = Some(child);
            let pid_label = pid
                .map(|p| p.to_string())
                .unwrap_or_else(|| "?".into());
            s.set_phase(Phase::Running, format!("Running (pid {pid_label})"));
            s.push_log(format!("[console] server up pid={pid_label}"));
            if s.game_upnp.load(Ordering::SeqCst) {
                let upnp_s = s.clone();
                tokio::spawn(async move { open_game_upnp(&upnp_s).await });
            }
            Ok(s.status())
        }
        Err(e) => {
            s.set_phase(Phase::Error, format!("Start failed: {e}"));
            s.push_log(format!("[console] spawn error: {e}"));
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, s.status()))
        }
    }
}

fn spawn_pipe_reader<R>(s: Arc<Shared>, reader: R, tag: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(idx) = line.find(PUBLIC_URL_MARKER) {
                let url = line[idx + PUBLIC_URL_MARKER.len()..].trim().to_string();
                if !url.is_empty() {
                    *s.public_ws.lock() = Some(url);
                }
            }
            if line.contains(ACME_FALLBACK_MARKER) {
                s.running_tls.store(false, Ordering::SeqCst);
            }
            s.push_log(format!("[{tag}] {line}"));
        }
    });
}

async fn stop_server(
    s: Arc<Shared>,
) -> Result<Status, (axum::http::StatusCode, Status)> {
    if !s.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Status {
                message: "Busy".into(),
                ..s.status()
            },
        ));
    }
    let result = stop_server_inner(s.clone()).await;
    s.busy.store(false, Ordering::SeqCst);
    result
}

async fn stop_server_inner(
    s: Arc<Shared>,
) -> Result<Status, (axum::http::StatusCode, Status)> {
    s.set_phase(Phase::Stopping, "Stopping…".to_string());
    close_game_upnp(&s, s.server_bind().port()).await;
    if s.running_tls.load(Ordering::SeqCst) {
        // A kill mid-issuance can strand the temporary ACME port-80/443 forward.
        for port in [80, 443] {
            if let Ok(true) = multiplayer_server::upnp::delete_tcp_mapping_if_ours(port).await {
                s.push_log(format!("[console] UPnP: removed leftover ACME TCP {port} forward"));
            }
        }
    }
    *s.public_ws.lock() = None;
    let child = s.child.lock().take();
    if let Some(mut c) = child {
        let pid = c.id();
        s.push_log(format!("[console] stopping pid={}", pid.map(|p| p.to_string()).unwrap_or_else(|| "?".into())));
        match c.kill().await {
            Ok(()) => s.push_log("[console] kill sent".into()),
            Err(e) => s.push_log(format!("[console] kill error: {e}")),
        }
        let _ = c.wait().await;
    }
    *s.pid.lock() = None;
    s.set_phase(Phase::Idle, "Stopped".to_string());
    Ok(s.status())
}

async fn start_site(s: Arc<Shared>) -> Result<Status, (axum::http::StatusCode, Status)> {
    if !s
        .site_busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Status {
                site_message: "Busy".into(),
                ..s.status()
            },
        ));
    }
    let result = start_site_inner(s.clone()).await;
    s.site_busy.store(false, Ordering::SeqCst);
    result
}

async fn start_site_inner(s: Arc<Shared>) -> Result<Status, (axum::http::StatusCode, Status)> {
    if matches!(
        *s.site_phase.lock(),
        SitePhase::Running | SitePhase::Starting
    ) || s.site_shutdown.lock().is_some()
    {
        return Ok(s.status());
    }

    s.set_site_phase(SitePhase::Starting, "Starting site host…".into());
    let bind = s.site_bind();
    s.push_log(format!("[console] site host binding http://{bind}"));

    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) => {
            s.set_site_phase(SitePhase::Error, format!("Site bind failed: {e}"));
            s.push_log(format!("[console] site bind error: {e}"));
            return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, s.status()));
        }
    };
    let local = listener.local_addr().unwrap_or(bind);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    *s.site_shutdown.lock() = Some(shutdown_tx);

    let site_app = Router::new()
        .route("/MultiplayerMod.js", get(serve_multiplayer_mod))
        .fallback(proxy_gsm)
        .layer(CorsLayer::permissive())
        .with_state(s.clone());

    let serve_s = s.clone();
    tokio::spawn(async move {
        let serve = axum::serve(listener, site_app).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(e) = serve.await {
            serve_s.push_log(format!("[console] site serve error: {e}"));
            serve_s.set_site_phase(SitePhase::Error, format!("Site serve error: {e}"));
        }
    });

    *s.site_local.lock() = Some(local);
    s.set_site_phase(SitePhase::Running, format!("Hosting on http://{local}"));
    if s.site_upnp_enabled.load(Ordering::SeqCst) {
        open_site_upnp(&s).await;
    }
    refresh_site_message(&s);
    s.push_log(format!("[console] site host up on http://{local}"));
    Ok(s.status())
}

async fn stop_site(s: Arc<Shared>) -> Result<Status, (axum::http::StatusCode, Status)> {
    if !s
        .site_busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Status {
                site_message: "Busy".into(),
                ..s.status()
            },
        ));
    }
    let result = stop_site_inner(s.clone()).await;
    s.site_busy.store(false, Ordering::SeqCst);
    result
}

async fn stop_site_inner(s: Arc<Shared>) -> Result<Status, (axum::http::StatusCode, Status)> {
    s.set_site_phase(SitePhase::Stopping, "Stopping site host…".into());
    s.push_log("[console] site host stopping…".into());

    let shutdown_tx = s.site_shutdown.lock().take();
    if let Some(tx) = shutdown_tx {
        let _ = tx.send(());
        // Brief pause so the listener can release the port before a quick restart.
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    *s.site_local.lock() = None;
    close_site_upnp(&s, s.site_bind().port()).await;
    s.set_site_phase(SitePhase::Idle, "Site host off".into());
    Ok(s.status())
}

async fn serve_multiplayer_mod(State(s): State<Arc<Shared>>) -> Response {
    let path = s.repo_root.join("MultiplayerMod.js");
    match tokio::fs::read(&path).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(
                header::CONTENT_TYPE,
                "application/javascript; charset=utf-8",
            )],
            bytes,
        )
            .into_response(),
        Err(e) => {
            s.push_log(format!(
                "[console] site missing MultiplayerMod.js at {}: {e}",
                path.display()
            ));
            (
                StatusCode::NOT_FOUND,
                format!("MultiplayerMod.js not found at {}", path.display()),
            )
                .into_response()
        }
    }
}

async fn proxy_gsm(State(s): State<Arc<Shared>>, req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return (StatusCode::METHOD_NOT_ALLOWED, "GET/HEAD only").into_response();
    }

    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let url = format!("{GSM_ORIGIN}{path_and_query}");

    let mut upstream = s.http_client.request(req.method().clone(), &url);
    // Forward a few safe request headers.
    if let Some(accept) = req.headers().get(header::ACCEPT) {
        upstream = upstream.header(header::ACCEPT, accept);
    }
    if let Some(lang) = req.headers().get(header::ACCEPT_LANGUAGE) {
        upstream = upstream.header(header::ACCEPT_LANGUAGE, lang);
    }

    let resp = match upstream.send().await {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Upstream fetch failed: {e}"),
            )
                .into_response();
        }
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let headers = resp.headers().clone();
    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let is_html = content_type.to_ascii_lowercase().contains("text/html");

    if is_html {
        let mut body = match resp.text().await {
            Ok(t) => t,
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    format!("Upstream body error: {e}"),
                )
                    .into_response();
            }
        };
        body = body.replace("https://googlesnakemods.com", "");
        body = body.replace("http://googlesnakemods.com", "");
        if !body.contains("/MultiplayerMod.js") {
            if let Some(idx) = body.to_ascii_lowercase().rfind("</body>") {
                body.insert_str(idx, MOD_SCRIPT_TAG);
            } else {
                body.push_str(MOD_SCRIPT_TAG);
            }
        }
        let mut out = Response::builder().status(status);
        if let Some(h) = out.headers_mut() {
            copy_passthrough_headers(&headers, h, true);
            h.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/html; charset=utf-8"),
            );
        }
        return out
            .body(Body::from(body))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return (
                StatusCode::BAD_GATEWAY,
                format!("Upstream body error: {e}"),
            )
                .into_response();
        }
    };
    let mut out = Response::builder().status(status);
    if let Some(h) = out.headers_mut() {
        copy_passthrough_headers(&headers, h, false);
    }
    out.body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn copy_passthrough_headers(from: &HeaderMap, to: &mut HeaderMap, html_rebuild: bool) {
    const SKIP: &[&str] = &[
        "transfer-encoding",
        "connection",
        "keep-alive",
        "content-length",
        "content-encoding",
        "content-security-policy",
        "content-security-policy-report-only",
        "strict-transport-security",
        "x-frame-options",
    ];
    for (name, value) in from.iter() {
        let lower = name.as_str();
        if SKIP.iter().any(|s| *s == lower) {
            continue;
        }
        if html_rebuild && lower == "content-type" {
            continue;
        }
        if let Ok(n) = HeaderName::from_bytes(name.as_str().as_bytes()) {
            to.insert(n, value.clone());
        }
    }
}

async fn restart_server(
    s: Arc<Shared>,
) -> Result<Status, (axum::http::StatusCode, Status)> {
    if !s.busy.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
        return Err((
            axum::http::StatusCode::CONFLICT,
            Status {
                message: "Busy".into(),
                ..s.status()
            },
        ));
    }
    let result = async {
        let _ = stop_server_inner(s.clone()).await;
        s.set_phase(Phase::Rebuilding, "cargo build --release…".to_string());
        s.push_log("[console] rebuilding release binary…".into());
        rebuild(s.clone()).await?;
        start_server_inner(s.clone()).await
    }
    .await;
    s.busy.store(false, Ordering::SeqCst);
    result
}

async fn rebuild(s: Arc<Shared>) -> Result<(), (axum::http::StatusCode, Status)> {
    let mut cmd = Command::new("cargo");
    cmd.arg("build")
        .arg("--release")
        .arg("--manifest-path")
        .arg(&s.manifest)
        .arg("--bin")
        .arg("multiplayer-server")
        .current_dir(&s.repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            s.set_phase(Phase::Error, format!("cargo spawn failed: {e}"));
            s.push_log(format!("[console] cargo spawn error: {e}"));
            return Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, s.status()));
        }
    };
    if let Some(out) = child.stdout.take() {
        spawn_pipe_reader(s.clone(), out, "cargo");
    }
    if let Some(err) = child.stderr.take() {
        spawn_pipe_reader(s.clone(), err, "cargo");
    }
    match child.wait().await {
        Ok(status) if status.success() => {
            s.push_log("[console] rebuild ok".into());
            Ok(())
        }
        Ok(status) => {
            s.set_phase(Phase::Error, format!("Rebuild failed ({status})"));
            s.push_log(format!("[console] rebuild failed: {status}"));
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, s.status()))
        }
        Err(e) => {
            s.set_phase(Phase::Error, format!("Rebuild wait error: {e}"));
            Err((axum::http::StatusCode::INTERNAL_SERVER_ERROR, s.status()))
        }
    }
}

async fn index() -> Html<&'static str> {
    Html(INDEX_HTML)
}

/// True Dark palette from Pudding Theme.js (+ readable accents for controls/log).
const INDEX_HTML: &str = r##"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Multiplayer Server</title>
<style>
  :root {
    --td-light: #1D1D1D;
    --td-dark: #161616;
    --td-shadow: #111111;
    --td-border: #000000;
    --td-sep: #212121;
    --td-bg: #111111;
    --td-text: #e6e6e6;
    --td-muted: #8a8a8a;
    --td-accent: #3a3a3a;
    --td-ok: #6bcf7f;
    --td-warn: #d4a017;
    --td-danger: #c45c5c;
    --td-chip: #2a2a2a;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background:
      linear-gradient(90deg, var(--td-dark) 50%, var(--td-light) 50%) 0 0 / 48px 48px,
      var(--td-bg);
    background-attachment: fixed;
    color: var(--td-text);
    font-family: "Segoe UI", system-ui, sans-serif;
  }
  body {
    display: flex; flex-direction: column; min-height: 100%;
    background-color: var(--td-bg);
    background-image:
      repeating-linear-gradient(
        90deg,
        var(--td-dark) 0 24px,
        var(--td-light) 24px 48px
      );
  }
  .shell {
    max-width: 1280px; margin: 0 auto; padding: 20px 18px 28px;
    width: 100%; flex: 1; display: flex; flex-direction: column; gap: 14px;
  }
  header.top {
    display: flex; align-items: flex-end; justify-content: space-between; gap: 16px;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--td-sep);
    padding-bottom: 16px;
  }
  .brand {
    display: flex; flex-direction: column; gap: 4px;
  }
  .brand h1 {
    margin: 0; font-size: 1.55rem; font-weight: 650; letter-spacing: 0.02em;
  }
  .brand .sub {
    color: var(--td-muted); font-size: 0.85rem;
  }
  .status-pill {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 8px 14px; border-radius: 999px;
    background: var(--td-chip); border: 1px solid var(--td-sep);
    font-size: 0.82rem; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--td-muted);
    box-shadow: 0 0 0 3px rgba(255,255,255,0.04);
  }
  .dot.on { background: var(--td-ok); box-shadow: 0 0 10px rgba(107,207,127,0.45); }
  .dot.busy { background: var(--td-warn); box-shadow: 0 0 10px rgba(212,160,23,0.35); }
  .dot.err { background: var(--td-danger); }
  .panel {
    background: rgba(29,29,29,0.94);
    border: 1px solid var(--td-sep);
    border-radius: 12px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.45);
    padding: 18px 18px 16px;
  }
  .panel h2 {
    margin: 0 0 12px; font-size: 0.78rem; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--td-muted);
  }
  .top-actions {
    display: flex; align-items: center; gap: 10px;
  }
  .join {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    flex-wrap: wrap; padding: 16px 18px;
  }
  .join-main { min-width: 0; flex: 1 1 320px; }
  .eyebrow {
    color: var(--td-muted); font-size: 0.72rem; font-weight: 600;
    letter-spacing: 0.12em; text-transform: uppercase;
  }
  .join-url {
    margin-top: 6px; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 1.25rem; color: #fff; cursor: pointer; word-break: break-all;
  }
  .join-url.empty { color: var(--td-muted); font-size: 1rem; cursor: default; }
  .join-side { display: flex; align-items: center; gap: 10px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 5px 10px; border-radius: 999px; font-size: 0.76rem; font-weight: 600;
    background: var(--td-chip); border: 1px solid var(--td-sep); color: var(--td-muted);
    white-space: nowrap;
  }
  .badge.ok { color: #bfeecb; border-color: #35553a; background: #14231a; }
  .badge.warn { color: #f0d99a; border-color: #5c4a14; background: #231d0c; }
  .cards {
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
  }
  .card { display: flex; flex-direction: column; gap: 12px; }
  .card-head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .card-head h2 { margin: 0; }
  .kv {
    margin: 0; display: grid; grid-template-columns: auto 1fr;
    gap: 8px 16px; font-size: 0.86rem;
  }
  .kv dt { color: var(--td-muted); }
  .kv dd {
    margin: 0; font-family: ui-monospace, Consolas, monospace;
    text-align: right; word-break: break-all;
  }
  .card-actions { display: flex; gap: 10px; margin-top: auto; }
  .card-actions button { flex: 1; }
  .hint { margin: 0; color: var(--td-muted); font-size: 0.8rem; line-height: 1.4; }
  .net-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; align-items: end; }
  .port-field input { font-family: ui-monospace, Consolas, monospace; -moz-appearance: textfield; }
  .port-field input::-webkit-outer-spin-button,
  .port-field input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .upnp-field button { padding: 9px 12px; font-size: 0.85rem; }
  .upnp-field button.on { color: #bfeecb; border-color: #35553a; background: #14231a; }
  .upnp-state { margin-top: -4px; }
  .upnp-state.ok { color: #8fd9a1; }
  .upnp-state.warn { color: #e6c46a; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { color: var(--td-muted); font-size: 0.74rem; letter-spacing: 0.06em; text-transform: uppercase; }
  .input-group {
    display: flex; align-items: stretch;
    background: rgba(0,0,0,0.35); border: 1px solid var(--td-sep); border-radius: 8px;
    overflow: hidden; transition: border-color .15s;
  }
  .input-group:focus-within { border-color: #4a4a4a; }
  .input-group input {
    flex: 1; min-width: 0; background: transparent; color: var(--td-text);
    border: 0; outline: none; padding: 9px 10px; font: inherit; font-size: 0.9rem;
  }
  .input-group .suffix {
    display: flex; align-items: center; padding: 0 10px;
    color: var(--td-muted); font-size: 0.85rem; background: rgba(255,255,255,0.03);
    border-left: 1px solid var(--td-sep);
  }
  .input-group button {
    border: 0; border-left: 1px solid var(--td-sep); border-radius: 0;
    padding: 0 16px; font-size: 0.85rem;
  }
  .switch-row {
    display: flex; align-items: center; gap: 10px;
    font-size: 0.86rem; cursor: pointer; user-select: none;
  }
  .switch-row .muted { color: var(--td-muted); font-size: 0.8rem; }
  input.switch {
    appearance: none; margin: 0; flex: 0 0 auto; position: relative; cursor: pointer;
    width: 38px; height: 22px; border-radius: 999px;
    background: #2a2a2a; border: 1px solid #3a3a3a;
    transition: background .15s, border-color .15s;
  }
  input.switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 16px; height: 16px; border-radius: 50%; background: #8a8a8a;
    transition: transform .15s, background .15s;
  }
  input.switch:checked { background: #1f3a25; border-color: #35553a; }
  input.switch:checked::after { transform: translateX(16px); background: var(--td-ok); }
  input.switch.warn:checked { background: #3a3014; border-color: #5c4a14; }
  input.switch.warn:checked::after { background: var(--td-warn); }
  input.switch:disabled { opacity: 0.4; cursor: not-allowed; }
  .secure-body { display: flex; flex-direction: column; gap: 12px; transition: opacity .15s; }
  .secure-body.off { opacity: 0.55; }
  .duck-state { font-size: 0.8rem; color: var(--td-muted); }
  .duck-state strong { color: var(--td-text); font-weight: 600; }
  button {
    appearance: none; cursor: pointer;
    border: 1px solid var(--td-sep);
    background: var(--td-border);
    color: var(--td-text);
    padding: 11px 18px;
    border-radius: 8px;
    font-size: 0.92rem; font-weight: 600;
    letter-spacing: 0.02em;
    transition: background .15s, border-color .15s, transform .1s;
  }
  button:hover:not(:disabled) {
    background: var(--td-accent); border-color: #333;
  }
  button:active:not(:disabled) { transform: translateY(1px); }
  button:disabled {
    opacity: 0.4; cursor: not-allowed;
  }
  button.primary {
    background: #1a1a1a;
    border-color: #333;
  }
  button.danger {
    border-color: #5a3030;
    color: #f0c0c0;
  }
  button.danger:hover:not(:disabled) {
    background: #2a1515; border-color: var(--td-danger);
  }
  button.restart {
    border-color: #35553a;
    color: #c8efd0;
  }
  button.restart:hover:not(:disabled) {
    background: #152218; border-color: var(--td-ok);
  }
  button.shutdown {
    border-color: #6a2a2a;
    color: #ffb0b0;
    padding: 8px 14px; font-size: 0.82rem;
  }
  button.shutdown:hover:not(:disabled) {
    background: #3a1212; border-color: #c04040;
  }
  .lower {
    display: grid; gap: 14px; align-items: stretch;
    grid-template-columns: minmax(0, 3fr) minmax(340px, 2fr);
  }
  .log-panel { display: flex; flex-direction: column; min-height: 140px; min-width: 0; }
  .lower .log-wrap { height: 0; flex: 1 1 auto; max-height: none; }
  @media (max-width: 980px) {
    .lower { grid-template-columns: 1fr; }
    .lower .log-wrap { height: 44vh; flex: none; }
  }
  .log-toolbar {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 10px; gap: 8px;
  }
  .log-tools { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .log-tools button { padding: 7px 12px; font-size: 0.8rem; }
  #logSearch {
    width: 150px; min-width: 0; background: rgba(0,0,0,0.35); color: var(--td-text);
    border: 1px solid var(--td-sep); border-radius: 8px; padding: 7px 10px;
    font: inherit; font-size: 0.8rem; outline: none;
  }
  #logSearch:focus { border-color: #4a4a4a; }
  .log-filters {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 8px; margin-bottom: 10px;
  }
  .log-filters .seg button { padding: 6px 10px; font-size: 0.78rem; }
  .log-filters .count:not(:empty) {
    display: inline-block; min-width: 16px; margin-left: 4px; padding: 0 5px;
    border-radius: 999px; background: #5a2323; color: #ffd0d0; font-size: 0.7rem; line-height: 16px;
  }
  .log-wrap { position: relative; min-height: 160px; max-height: 60vh; display: flex; }
  #log {
    flex: 1; min-height: 0; overflow: auto;
    background: #0a0a0a; border: 1px solid var(--td-border); border-radius: 8px;
    padding: 4px 0; font-size: 0.84rem; line-height: 1.4; color: #d4d4d4;
    color-scheme: dark; scrollbar-color: #3a3a3a transparent; scrollbar-width: thin;
  }
  #log .empty { padding: 18px; color: var(--td-muted); text-align: center; font-size: 0.82rem; }
  .le {
    display: grid; grid-template-columns: 58px 20px minmax(0, 1fr); gap: 0 8px;
    align-items: baseline; padding: 5px 12px 5px 10px;
    border-left: 2px solid transparent; cursor: pointer;
  }
  .le:hover { background: rgba(255,255,255,0.035); }
  .le + .le { border-top: 1px solid rgba(255,255,255,0.03); }
  .le .t { color: #6f6f6f; font-family: ui-monospace, Consolas, monospace; font-size: 0.72rem; }
  .le .ic { text-align: center; font-size: 0.8rem; color: #7d7d7d; }
  .le .m { min-width: 0; overflow-wrap: anywhere; }
  .le .src {
    display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 4px;
    font-size: 0.64rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    vertical-align: 1px; background: #1c1c1c; color: #8a8a8a; border: 1px solid #262626;
  }
  .le .src.room { color: #9cc3ff; border-color: #22344f; background: #111a26; }
  .le .src.net { color: #b6a2f5; border-color: #33294f; background: #17131f; }
  .le .src.tls { color: #8fd9a1; border-color: #25442d; background: #111c14; }
  .le .src.build { color: #9aa7b8; }
  .le .chip {
    font-family: ui-monospace, Consolas, monospace; font-size: 0.78rem;
    padding: 0 5px; border-radius: 4px; background: #1b1b1b; color: #ececec;
    border: 1px solid #2a2a2a; white-space: nowrap;
  }
  .le .chip.who { color: #ffe6a8; border-color: #3d3419; background: #1d190d; }
  .le .chip.url { white-space: normal; overflow-wrap: anywhere; }
  .le .raw {
    display: none; grid-column: 3; margin-top: 4px; padding: 6px 8px; border-radius: 6px;
    background: #111; color: #8c8c8c; font-family: ui-monospace, Consolas, monospace;
    font-size: 0.72rem; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .le.open .raw { display: block; }
  .le.ok .ic { color: #6fd08a; }
  .le.warn { border-left-color: #b8902c; background: rgba(184,144,44,0.05); }
  .le.warn .ic { color: #e6c46a; }
  .le.err { border-left-color: #c04848; background: rgba(192,72,72,0.07); }
  .le.err .ic { color: #ff8a8a; }
  .le.verbose .m { color: #8d8d8d; }
  .le.hidden { display: none; }
  .le .rep { color: #8a8a8a; font-size: 0.74rem; font-weight: 600; }
  .log-latest {
    position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%);
    padding: 6px 14px; font-size: 0.78rem; border-radius: 999px;
    background: #1f2d45; border-color: #34507a; color: #d6e6ff;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5); display: none;
  }
  .log-latest.show { display: block; }
  footer {
    color: var(--td-muted); font-size: 0.75rem; text-align: center;
    padding-top: 4px;
  }
  .spec-toolbar {
    display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
    justify-content: space-between; margin-bottom: 12px;
  }
  .spec-toolbar .left, .spec-toolbar .right {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
  }
  .seg {
    display: inline-flex; border: 1px solid var(--td-sep); border-radius: 8px; overflow: hidden;
  }
  .seg button {
    border: 0; border-radius: 0; padding: 8px 14px; font-size: 0.82rem;
    background: var(--td-shadow);
  }
  .seg button.active {
    background: var(--td-accent); color: #fff;
  }
  select#roomPick {
    background: var(--td-shadow); color: var(--td-text);
    border: 1px solid var(--td-sep); border-radius: 8px;
    padding: 8px 10px; font-size: 0.85rem;
  }
  #specStage {
    position: relative;
    flex: 1 1 auto;
    min-height: clamp(380px, 58vh, 860px);
    height: clamp(380px, 58vh, 860px);
    background: #0a0a0a;
    border: 1px solid var(--td-border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  #specEmpty {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: var(--td-muted); font-size: 0.9rem; padding: 24px; text-align: center;
  }
  #specMosaic {
    display: none; width: 100%; height: 100%; min-height: 320px;
    padding: 12px; box-sizing: border-box;
    justify-content: center; align-content: center; gap: 10px;
  }
  #specMosaic.show { display: grid; }
  .spec-cell {
    display: flex; flex-direction: column; gap: 4px; cursor: pointer;
    border: 1px solid var(--td-sep); border-radius: 8px; padding: 6px;
    background: rgba(22,22,22,0.9);
    transition: border-color .15s, background .15s;
  }
  .spec-cell:hover { border-color: #444; background: #1a1a1a; }
  .spec-cell.focused { border-color: var(--td-ok); }
  .spec-cell .label {
    font-size: 0.72rem; color: var(--td-muted); letter-spacing: 0.04em;
    text-transform: uppercase; display: flex; justify-content: space-between; gap: 8px;
  }
  .spec-cell .label .score { color: var(--td-text); font-family: ui-monospace, Consolas, monospace; }
  .spec-cell svg, #specFocus svg {
    display: block; width: 100%; height: auto;
    border-radius: 4px;
  }
  /* Bitmap size + inline style come from sizeCanvas — never force width/height
     here (max-height + width:100% was squashing the board into a wide strip). */
  .spec-cell canvas, #specFocus canvas, #specCoop canvas {
    display: block;
    border-radius: 4px;
    image-rendering: auto;
  }
  #specFocus {
    display: none; width: 100%; height: 100%; min-height: 0; flex: 1;
    padding: 12px 16px; box-sizing: border-box;
    flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  }
  #specFocus.show { display: flex; }
  #specFocus .focus-label {
    font-size: 0.85rem; color: var(--td-muted); letter-spacing: 0.06em; text-transform: uppercase;
    flex: 0 0 auto;
  }
  #specFocus .canvas-wrap {
    width: 100%; flex: 1 1 auto; min-height: 0;
    display: flex; align-items: center; justify-content: center;
  }
  #specCoop {
    display: none; width: 100%; height: 100%; min-height: 0; flex: 1;
    padding: 12px 16px; box-sizing: border-box;
    flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  }
  #specCoop.show { display: flex; }
  #specCoop .canvas-wrap {
    width: 100%; flex: 1 1 auto; min-height: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .panel.spec-panel {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .spec-meta {
    margin-top: 10px; font-size: 0.8rem; color: var(--td-muted);
    display: flex; flex-wrap: wrap; gap: 12px;
  }
  .spec-meta strong { color: var(--td-text); font-weight: 600; }
</style>
</head>
<body>
  <div class="shell">
    <header class="top">
      <div class="brand">
        <h1>Multiplayer Server</h1>
        <div class="sub">Google Snake host console</div>
      </div>
      <div class="top-actions">
        <div class="status-pill" id="pill">
          <span class="dot" id="dot"></span>
          <span id="phaseLabel">idle</span>
        </div>
        <button class="shutdown" id="btnShutdown" type="button" title="Stop everything and exit the console (ends start-server.bat)">Shutdown</button>
      </div>
    </header>

    <section class="panel join">
      <div class="join-main">
        <div class="eyebrow">Public join URL</div>
        <div class="join-url empty" id="publicWs" title="Click to copy">Start the game server to get a join URL</div>
      </div>
      <div class="join-side">
        <span class="badge" id="certBadge">—</span>
        <button type="button" id="btnCopyWs" disabled>Copy</button>
      </div>
    </section>

    <div class="cards">
      <section class="panel card">
        <div class="card-head">
          <h2>Game server</h2>
          <span class="dot" id="gameDot"></span>
        </div>
        <dl class="kv">
          <dt>Status</dt><dd id="msg">—</dd>
          <dt>PID</dt><dd id="pid">—</dd>
          <dt>Bind</dt><dd id="bind">—</dd>
        </dl>
        <div class="net-row">
          <div class="field port-field">
            <label class="field-label" for="gamePort">Port</label>
            <div class="input-group">
              <input type="number" id="gamePort" min="1" max="65535" inputmode="numeric">
              <button type="button" id="btnGamePort">Apply</button>
            </div>
          </div>
          <div class="field upnp-field">
            <span class="field-label">Router (UPnP)</span>
            <button type="button" id="btnGameUpnp">Start UPnP</button>
          </div>
        </div>
        <p class="hint upnp-state" id="gameUpnpState">—</p>
        <div class="card-actions">
          <button class="primary" id="btnPower" type="button">Start</button>
          <button class="restart" id="btnRestart" type="button">Restart</button>
        </div>
      </section>

      <section class="panel card">
        <div class="card-head">
          <h2>Secure WSS</h2>
          <input type="checkbox" class="switch" id="chkSecure" title="Get a free Let's Encrypt certificate so https://googlesnakemods.com can join via wss://">
        </div>
        <div class="secure-body" id="secureBody">
          <p class="hint">Free Let's Encrypt certificate so players on googlesnakemods.com can join.</p>
          <div class="field">
            <label class="field-label" for="duckDomain">DuckDNS domain</label>
            <div class="input-group">
              <input type="text" id="duckDomain" placeholder="yarmiplay" spellcheck="false" autocomplete="off">
              <span class="suffix">.duckdns.org</span>
            </div>
          </div>
          <div class="field">
            <label class="field-label" for="duckToken">DuckDNS token</label>
            <div class="input-group">
              <input type="password" id="duckToken" placeholder="token" autocomplete="off">
              <button type="button" id="btnDuckSave">Save</button>
            </div>
          </div>
          <label class="switch-row" title="Browsers will NOT trust staging certificates — testing only">
            <input type="checkbox" class="switch warn" id="chkStaging">
            Staging CA <span class="muted">testing only, not trusted</span>
          </label>
          <div class="duck-state" id="duckState">—</div>
        </div>
      </section>

      <section class="panel card">
        <div class="card-head">
          <h2>Site host</h2>
          <span class="dot" id="siteDot"></span>
        </div>
        <dl class="kv">
          <dt>Status</dt><dd id="siteMsg">—</dd>
          <dt>Bind</dt><dd id="siteBind">—</dd>
          <dt>Public</dt><dd id="sitePublic">—</dd>
        </dl>
        <div class="net-row">
          <div class="field port-field">
            <label class="field-label" for="sitePort">Port</label>
            <div class="input-group">
              <input type="number" id="sitePort" min="1" max="65535" inputmode="numeric">
              <button type="button" id="btnSitePort">Apply</button>
            </div>
          </div>
          <div class="field upnp-field">
            <span class="field-label">Router (UPnP)</span>
            <button type="button" id="btnSiteUpnp">Start UPnP</button>
          </div>
        </div>
        <p class="hint upnp-state" id="siteUpnpState">—</p>
        <div class="card-actions">
          <button class="primary" id="btnSite" type="button">Start site</button>
        </div>
      </section>
    </div>

    <div class="lower">
    <section class="panel spec-panel">
      <h2>Spectate</h2>
      <div class="spec-toolbar">
        <div class="left">
          <select id="roomPick" title="Room"><option value="">Auto</option></select>
          <div class="seg" id="viewSeg" title="Race view">
            <button type="button" data-view="mosaic" class="active">Mosaic</button>
            <button type="button" data-view="focus">Focus</button>
          </div>
          <button type="button" id="btnBackMosaic" style="display:none;padding:8px 12px;font-size:0.82rem">← Mosaic</button>
        </div>
        <div class="right">
          <span id="specModeTag" class="status-pill" style="text-transform:none;letter-spacing:0.02em">—</span>
        </div>
      </div>
      <div id="specStage">
        <div id="specEmpty">Start the game server, then open a room — boards appear here live.</div>
        <div id="specMosaic"></div>
        <div id="specFocus">
          <div class="focus-label" id="focusLabel">Focus</div>
          <div class="canvas-wrap"><canvas id="focusCanvas" width="700" height="620"></canvas></div>
        </div>
        <div id="specCoop">
          <div class="focus-label">Shared co-op board</div>
          <div class="canvas-wrap"><canvas id="coopCanvas" width="720" height="640"></canvas></div>
        </div>
      </div>
      <div class="spec-meta" id="specMeta"></div>
    </section>

    <section class="panel log-panel">
      <div class="log-toolbar">
        <h2 style="margin:0">Log</h2>
        <div class="log-tools">
          <input type="search" id="logSearch" placeholder="Search" spellcheck="false" autocomplete="off">
          <button type="button" id="btnClear" title="Clear the view (the server keeps its history)">Clear</button>
        </div>
      </div>
      <div class="log-filters">
        <div class="seg" id="logSeg">
          <button type="button" data-cat="all" class="active">All</button>
          <button type="button" data-cat="room">Rooms</button>
          <button type="button" data-cat="net">Network</button>
          <button type="button" data-cat="problem">Problems <span class="count" id="problemCount"></span></button>
        </div>
        <label class="switch-row" title="Show low-level lines (network adapters, internal config, build output)">
          <input type="checkbox" class="switch" id="logVerbose"> Details
        </label>
      </div>
      <div class="log-wrap">
        <div id="log" aria-live="polite"></div>
        <button type="button" id="btnLogLatest" class="log-latest">↓ New messages</button>
      </div>
    </section>
    </div>

    <footer id="footer">Console :7778 · game :7777 · site host :7779 (off until Start site)</footer>
  </div>
<script>
(function () {
  const logEl = document.getElementById("log");
  const phaseLabel = document.getElementById("phaseLabel");
  const dot = document.getElementById("dot");
  const msg = document.getElementById("msg");
  const pid = document.getElementById("pid");
  const bind = document.getElementById("bind");
  const siteMsg = document.getElementById("siteMsg");
  const siteBind = document.getElementById("siteBind");
  const sitePublic = document.getElementById("sitePublic");
  const publicWs = document.getElementById("publicWs");
  const chkSecure = document.getElementById("chkSecure");
  const chkStaging = document.getElementById("chkStaging");
  const duckDomain = document.getElementById("duckDomain");
  const duckToken = document.getElementById("duckToken");
  const btnDuckSave = document.getElementById("btnDuckSave");
  const duckState = document.getElementById("duckState");
  const secureBody = document.getElementById("secureBody");
  const certBadge = document.getElementById("certBadge");
  const btnCopyWs = document.getElementById("btnCopyWs");
  const gameDot = document.getElementById("gameDot");
  const siteDot = document.getElementById("siteDot");
  const btnPower = document.getElementById("btnPower");
  const btnSite = document.getElementById("btnSite");
  const btnRestart = document.getElementById("btnRestart");
  const btnShutdown = document.getElementById("btnShutdown");
  const gamePort = document.getElementById("gamePort");
  const sitePort = document.getElementById("sitePort");
  const btnGamePort = document.getElementById("btnGamePort");
  const btnSitePort = document.getElementById("btnSitePort");
  const btnGameUpnp = document.getElementById("btnGameUpnp");
  const btnSiteUpnp = document.getElementById("btnSiteUpnp");
  const gameUpnpState = document.getElementById("gameUpnpState");
  const siteUpnpState = document.getElementById("siteUpnpState");
  const footer = document.getElementById("footer");
  const roomPick = document.getElementById("roomPick");
  const viewSeg = document.getElementById("viewSeg");
  const btnBackMosaic = document.getElementById("btnBackMosaic");
  const specEmpty = document.getElementById("specEmpty");
  const specMosaic = document.getElementById("specMosaic");
  const specFocus = document.getElementById("specFocus");
  const specCoop = document.getElementById("specCoop");
  const focusSvg = document.getElementById("focusCanvas");
  const coopSvg = document.getElementById("coopCanvas");
  const focusLabel = document.getElementById("focusLabel");
  const specModeTag = document.getElementById("specModeTag");
  const specMeta = document.getElementById("specMeta");
  let stickBottom = true;
  let raceView = "mosaic";
  let focusId = null;
  let lastSnap = null;
  let shuttingDown = false;

  const COLORS = {
    0:["#4E7CF6","#17439F"],1:["#19D8E6","#15B5C1"],2:["#B648F2","#910FD7"],
    3:["#ED44B5","#C31388"],4:["#F53D40","#D00B0E"],5:["#F69C3C","#EA7E0B"],
    6:["#ECD613","#D9C512"],7:["#35B63E","#298E30"],8:["#6B6B6B","#404040"],
    9:["#F2F2F2","#D9D9D9"],10:["#4E7CF6","#27AE60"],11:["#3888F8","#E4425E"],
    12:["#B749EC","#EF8826"],13:["#F53AA2","#F5D40E"],14:["#F9B202","#4CBD1E"],
    15:["#39C14C","#3A79F2"],16:["#6B6B6B","#F2F2F2"],17:["#F2F2F2","#6B6B6B"],
    18:["#222222","#000000"],19:["#FF0000","#FF0000"],20:["#0000FF","#0000FF"],
    21:["#00FF00","#00FF00"],22:["#FFFFFF","#000000"],23:["#222222","#FFFFFF"],
    24:["#6759B9","#5B50B0"],25:["#0059b9","#0050b0"],26:["#000000","#000000"],
    27:["#ffaaff","#ff77ff"],28:["#964B00","#7B3F00"],29:["#4B2D08","#1B1D08"],
    30:["#b59b1d","#947f19"],31:["#87868c","#555652"],32:["#667da4","#4c5a73"],
    33:["#bd2862","#a72356"],34:["#000080","#000080"]
  };

  logEl.addEventListener("scroll", function () {
    const gap = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight;
    stickBottom = gap < 40;
    if (stickBottom) btnLogLatest.classList.remove("show");
  });

  function paintStatus(st) {
    if (!st) return;
    phaseLabel.textContent = st.phase || "idle";
    msg.textContent = (st.message || "—").replace(/\s*\(pid \d+\)/, "");
    pid.textContent = st.pid != null ? String(st.pid) : "—";
    bind.textContent = st.server_bind || "—";
    siteMsg.textContent = (st.site_message || "—").replace(/\s*\(default\)/, "");
    siteBind.textContent = st.site_bind || "—";
    sitePublic.textContent = st.site_public_url || "—";
    const url = st.public_ws || "";
    publicWs.textContent = url || "Start the game server to get a join URL";
    publicWs.classList.toggle("empty", !url);
    btnCopyWs.disabled = !url;
    certBadge.className = "badge";
    if (!url) {
      certBadge.textContent = "offline";
    } else if (url.indexOf("wss://") !== 0) {
      certBadge.textContent = "plain ws://";
    } else if (st.acme_staging) {
      certBadge.textContent = "staging cert · untrusted";
      certBadge.classList.add("warn");
    } else {
      certBadge.textContent = "trusted · Let's Encrypt";
      certBadge.classList.add("ok");
    }
    chkSecure.checked = !!st.secure_wss;
    chkStaging.checked = !!st.acme_staging;
    chkStaging.disabled = !st.secure_wss;
    secureBody.classList.toggle("off", !st.secure_wss);
    if (document.activeElement !== duckDomain) {
      duckDomain.value = (st.duckdns_domain || "").replace(/\.duckdns\.org$/i, "");
    }
    duckToken.placeholder = st.duckdns_token_set ? "saved — type to replace" : "paste token";
    duckState.innerHTML = "";
    const strong = document.createElement("strong");
    if (st.duckdns_token_set) {
      duckState.append("Certificate for ");
      strong.textContent = (duckDomain.value || "?") + ".duckdns.org";
      duckState.append(strong);
    } else {
      duckState.append("No token — certificate for your ");
      strong.textContent = "public IP";
      duckState.append(strong, " (needs inbound TCP 80/443)");
    }
    function paintDot(el, phase, running) {
      el.className = "dot";
      if (phase === "error") el.classList.add("err");
      else if (phase === "rebuilding" || phase === "starting" || phase === "stopping") el.classList.add("busy");
      else if (running) el.classList.add("on");
    }
    paintDot(dot, st.phase, st.phase === "running");
    paintDot(gameDot, st.phase, !!st.running);
    paintDot(siteDot, st.site_phase, !!st.site_running);
    const busy = st.phase === "rebuilding" || st.phase === "starting" || st.phase === "stopping";
    const siteBusy = st.site_phase === "starting" || st.site_phase === "stopping";
    const gameOn = !!st.running;
    btnPower.textContent = gameOn ? "Stop" : "Start";
    btnPower.className = gameOn ? "danger" : "primary";
    btnPower.disabled = busy || shuttingDown;
    const siteOn = !!st.site_running;
    btnSite.textContent = siteOn ? "Stop site" : "Start site";
    btnSite.className = siteOn ? "danger" : "primary";
    btnSite.disabled = siteBusy || shuttingDown;
    btnRestart.disabled = busy || shuttingDown;
    btnShutdown.disabled = shuttingDown;

    paintPort(gamePort, btnGamePort, st.game_port, busy);
    paintPort(sitePort, btnSitePort, st.site_port, siteBusy);
    paintUpnp(btnGameUpnp, gameUpnpState, st.game_upnp, gameOn && st.phase === "running",
      st.game_upnp_open, st.game_upnp_error, "server");
    const siteHosting = st.site_phase === "running";
    const siteOpen = st.site_public_url ? st.site_public_url.replace(/^https?:\/\//, "") : null;
    paintUpnp(btnSiteUpnp, siteUpnpState, st.site_upnp, siteHosting,
      siteOpen, st.site_upnp_error, "site host");
    footer.textContent = "Console :" + (location.port || "7778") + " · game :" + (st.game_port || "—") +
      " · site host :" + (st.site_port || "—") + (siteOn ? "" : " (off until Start site)");
  }

  function paintPort(input, btn, port, svcBusy) {
    const editing = document.activeElement === input || input.dataset.dirty === "1";
    if (!editing) input.value = port ? String(port) : "";
    const wanted = parseInt(input.value, 10);
    btn.disabled = svcBusy || shuttingDown || !(wanted >= 1 && wanted <= 65535) || wanted === port;
  }

  function paintUpnp(btn, stateEl, enabled, live, openAt, error, what) {
    btn.textContent = enabled ? "Stop UPnP" : "Start UPnP";
    btn.classList.toggle("on", !!enabled);
    btn.disabled = shuttingDown;
    stateEl.className = "hint upnp-state";
    stateEl.title = "";
    if (!enabled) {
      stateEl.textContent = "Port forward off, LAN only";
    } else if (!live) {
      stateEl.textContent = "Port forward opens when the " + what + " starts";
    } else if (openAt) {
      stateEl.textContent = "Port forward open on " + openAt;
      stateEl.classList.add("ok");
    } else if (error) {
      stateEl.textContent = "Router refused the port forward (hover for details)";
      stateEl.title = error;
      stateEl.classList.add("warn");
    } else {
      stateEl.textContent = "Opening port forward…";
    }
  }

  // ---- Log view: raw lines → readable entries ----
  const TRACE_RE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+([\w:]+):\s?(.*)$/;
  const KV_RE = /([A-Za-z_][\w.]*)=("(?:[^"\\]|\\.)*"|[^\s]+(?:\s+(?![A-Za-z_][\w.]*=)[^\s]+)*)/g;
  const URL_RE = /((?:wss?|https?):\/\/[^\s)]+)/;
  const PATH_RE = /[A-Za-z]:\\(?:[^\\\n]+\\)*([^\\\n]+?\.(?:exe|toml|json))/g;
  const LOG_MAX = 2500;
  const names = {};
  let problemCount = 0;
  let lastEntry = null;
  const logSearch = document.getElementById("logSearch");
  const logSeg = document.getElementById("logSeg");
  const logVerbose = document.getElementById("logVerbose");
  const problemCountEl = document.getElementById("problemCount");
  const btnLogLatest = document.getElementById("btnLogLatest");
  const logFilter = {
    cat: localStorage.getItem("mpLogCat") || "all",
    verbose: localStorage.getItem("mpLogVerbose") === "1",
    q: ""
  };
  const logEmpty = document.createElement("div");
  logEmpty.className = "empty";
  logEl.appendChild(logEmpty);

  function c(text, cls) { return { chip: String(text), cls: cls || "" }; }
  function who(id) { return id ? { who: String(id) } : "someone"; }
  function room(kv) { return c(kv.roomId || "?"); }
  function words(s) { return String(s || "").replace(/_/g, " ").toLowerCase(); }
  function sentence(s) { s = words(s); return s.charAt(0).toUpperCase() + s.slice(1); }
  function untilDate(sec) {
    const n = Number(sec);
    return n ? new Date(n * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "?";
  }
  function problem(text, kv) { return kv.error ? [text + ": " + kv.error] : [text]; }

  const EVENTS = {
    room_create: function (kv) { return { ic: "+", parts: ["Room ", room(kv), " created"] }; },
    join: function (kv) { return { ic: "→", parts: [who(kv.clientId), " joined room ", room(kv)] }; },
    leave: function (kv) { return { ic: "←", parts: [who(kv.clientId), " left room ", room(kv)] }; },
    disconnect: function (kv) {
      return { verbose: kv.code === "ws_closed", parts: [who(kv.clientId), " disconnected", kv.code && kv.code !== "ws_closed" ? " (" + words(kv.code) + ")" : ""] };
    },
    admin_assign: function (kv) { return { ic: "★", parts: [who(kv.clientId), " is the host of room ", room(kv)] }; },
    admin_succession: function (kv) { return { ic: "★", parts: ["Host left — ", who(kv.clientId), " now hosts room ", room(kv)] }; },
    admin_transfer: function (kv) { return { ic: "★", parts: ["Host handed to ", who(kv.clientId), " in room ", room(kv)] }; },
    kick: function (kv) { return { level: "warn", parts: [who(kv.clientId), " was kicked from room ", room(kv)] }; },
    auto_demote: function (kv) { return { parts: [who(kv.clientId), " moved to spectators in room ", room(kv)] }; },
    set_role: function (kv) { return { parts: [who(kv.clientId), " is now a ", words(kv.role || "player"), " in room ", room(kv)] }; },
    set_duration: function (kv) { return { parts: ["Room ", room(kv), ": round length set to ", c(kv.minutes + " min")] }; },
    set_race_goal: function (kv) { return { parts: ["Room ", room(kv), ": race goal set to ", c(words(kv.goal))] }; },
    mode_change: function (kv) { return { parts: ["Room ", room(kv), " switched to ", c(words(kv.mode))] }; },
    session_start: function (kv) { return { level: "ok", ic: "▶", parts: ["Room ", room(kv), ": ", words(kv.mode || ""), " round started"] }; },
    session_end_admin: function (kv) { return { ic: "■", parts: ["Host ended the round in room ", room(kv)] }; },
    attempt_expired: function (kv) { return { ic: "■", parts: ["Room ", room(kv), ": time's up"] }; },
    attempt_expired_grace: function (kv) { return { ic: "■", parts: ["Room ", room(kv), ": time's up — letting runs in progress finish"] }; },
    attempt_grace_complete: function (kv) { return { ic: "■", parts: ["Room ", room(kv), ": all runs finished"] }; },
    coop_session_end: function (kv) { return { ic: "■", parts: ["Room ", room(kv), ": co-op run ended", kv.reason ? " (" + words(kv.reason) + ")" : ""] }; },
    coop_all_dead: function (kv) { return { parts: ["Room ", room(kv), ": everyone died"] }; },
    coop_no_players: function (kv) { return { parts: ["Room ", room(kv), ": co-op run has no players left"] }; },
    orphan_reaped: function (kv) { return { verbose: true, parts: ["Cleaned up ", who(kv.clientId), "'s leftover seat in room ", room(kv)] }; },
    room_gc: function (kv) { return { verbose: true, parts: ["Removed ", String(kv.removed), " empty room" + (kv.removed === "1" ? "" : "s")] }; },
    play_sync: function (kv) { return { verbose: true, parts: [who(kv.clientId), " synced play state in room ", room(kv)] }; },
    settings_sync: function (kv) { return { verbose: true, parts: [who(kv.clientId), " synced game settings in room ", room(kv)] }; },
    spectate_focus: function (kv) { return { verbose: true, parts: [who(kv.clientId), " is spectating ", kv.focus ? who(kv.focus) : "the mosaic", " in room ", room(kv)] }; },
    resync_request: function (kv) { return { verbose: true, parts: [who(kv.clientId), " asked for a resync in room ", room(kv)] }; },
    client_error: function (kv) { return { level: "warn", parts: [who(kv.clientId), " hit an error in room ", room(kv), ": ", kv.message || words(kv.code)] }; },
    unknown_type: function (kv) { return { level: "warn", parts: [who(kv.clientId), " sent an unknown message type ", c(kv.msg_type || "?")] }; },
    malformed: function (kv) { return { level: "warn", parts: [who(kv.clientId), " sent a malformed message", kv.error ? ": " + kv.error : ""] }; },
    binary_ignored: function (kv) { return { level: "warn", parts: [who(kv.clientId), " sent binary data (ignored)"] }; },
    ws_rate_limited: function (kv) { return { level: "warn", parts: [who(kv.clientId), " is sending too fast (rate limited)"] }; },
    ws_text_too_large: function (kv) { return { level: "warn", parts: [who(kv.clientId), " sent an oversized message"] }; },
    coop_authority_config: function (kv) { return { verbose: true, parts: ["Co-op engine: ", c(kv.coopAuthority || "?")] }; },
    listen: function (kv) { return { verbose: true, parts: ["Listening on ", c(kv.bind)] }; },
    listen_tls: function (kv) { return { verbose: true, parts: ["Listening (TLS) on ", c(kv.bind)] }; },
    shutdown_signal: function () { return { parts: ["Server shutting down"] }; },
    upnp_ssdp_iface: function (kv) { return { verbose: true, parts: ["Looking for the router via ", kv.adapter || "?", " ", c(kv.ip)] }; },
    upnp_ssdp_iface_failed: function (kv) { return { verbose: true, level: "info", parts: problem("Router search failed on " + (kv.adapter || "?"), kv) }; },
    upnp_ssdp_send_failed: function (kv) { return { verbose: true, level: "info", parts: problem("Router search failed on " + (kv.adapter || "?"), kv) }; },
    upnp_gateway_found: function (kv) { return { verbose: true, parts: ["Router found via ", kv.adapter || "?", " (this PC is ", c(kv.local_ip), ")"] }; },
    upnp_gateway_rejected: function (kv) { return { verbose: true, level: "info", parts: problem("Ignored a UPnP device", kv) }; },
    upnp_mapped: function (kv) { return { level: "ok", parts: ["Router forward open: TCP ", c(kv.port || kv.external_port || "?"), " on ", c(kv.external_ip || "?")] }; },
    upnp_ready: function (kv) { return { level: "ok", parts: ["Public join URL ", kv.public_ws || ""] }; },
    upnp_unmapped: function (kv) { return { parts: ["Router forward closed: TCP ", c(kv.port || kv.external_port || "?")] }; },
    upnp_unmap_failed: function (kv) { return { level: "warn", parts: problem("Couldn't close router forward TCP " + (kv.port || "?"), kv) }; },
    upnp_skipped: function (kv) { return { level: "warn", parts: problem("UPnP unavailable", kv) }; },
    upnp_disabled: function () { return { verbose: true, parts: ["Server-side UPnP off — the console manages the router forward"] }; },
    upnp_existing_mapping_replaced: function (kv) { return { parts: ["Replaced an old router forward", kv.port ? " on TCP " + kv.port : ""] }; },
    upnp_external_ip_private: function (kv) {
      return { level: "warn", parts: ["Router reports a private internet address ", c(kv.external_ip || kv.ip || "?"), " — likely double NAT / CGNAT, friends outside can't reach you"] };
    },
    upnp_get_mapping_failed: function (kv) { return { verbose: true, parts: problem("Router forward lookup failed", kv) }; },
    acme_order_started: function (kv) {
      return { parts: ["Requesting a certificate for ", c(kv.host), kv.staging === "true" ? " (staging, untrusted)" : ""] };
    },
    duckdns_txt_set: function (kv) { return { parts: ["DuckDNS verification record set for ", c(kv.host)] }; },
    acme_dns_txt_visible: function () { return { parts: ["Verification record is visible on the internet"] }; },
    acme_cert_issued: function (kv) { return { level: "ok", parts: ["Certificate issued for ", c(kv.host), ", valid until ", untilDate(kv.not_after)] }; },
    acme_cert_cached: function (kv) { return { level: "ok", parts: ["Using saved certificate for ", c(kv.host), ", valid until ", untilDate(kv.not_after)] }; },
    acme_ready: function (kv) { return { verbose: true, parts: ["Secure server ready at ", kv.url || ""] }; },
    acme_renewed: function (kv) { return { level: "ok", parts: ["Certificate renewed, valid until ", untilDate(kv.not_after)] }; },
    acme_failed: function (kv) { return { level: "err", parts: problem("Certificate request failed", kv) }; },
    acme_renew_failed: function (kv) { return { level: "warn", parts: problem("Certificate renewal failed", kv) }; },
    acme_renew_failed_keeping_cached: function (kv) { return { level: "warn", parts: problem("Renewal failed — keeping the current certificate", kv) }; },
    acme_host_changed: function (kv) { return { level: "warn", parts: ["Certificate name changed from ", c(kv.old), " to ", c(kv.new)] }; },
    duckdns_ip_updated: function (kv) { return { level: "ok", parts: [c(kv.domain), " now points to ", c(String(kv.ip || "this PC").replace(/^Some\("?|"?\)$/g, ""))] }; },
    duckdns_retry: function (kv) { return { level: "warn", parts: ["DuckDNS didn't answer, retrying", kv.attempt ? " (attempt " + kv.attempt + ")" : "", kv.error ? ": " + kv.error : ""] }; },
    duckdns_ip_update_failed: function (kv) { return { level: "warn", parts: problem("DuckDNS address update failed (keeping the old one)", kv) }; }
  };

  function srcFor(target, event, kv) {
    const e = event || "";
    if (/^(acme|duckdns)/.test(e) || /acme/.test(target)) return { label: "TLS", cls: "tls", cat: "net" };
    if (/^upnp/.test(e) || /upnp/.test(target)) return { label: "Router", cls: "net", cat: "net" };
    if (/::room$/.test(target) || kv.roomId || kv.clientId || e === "room_gc") return { label: "Room", cls: "room", cat: "room" };
    return { label: "Server", cls: "", cat: "system" };
  }

  function levelFromText(text) {
    if (/spawn error|start failed|panicked|exited with|fatal|\berror:/i.test(text)) return "err";
    if (/fail|refused|not opened|rejected|unavailable|could not|couldn't|skipped|busy|timed out|warning/i.test(text)) return "warn";
    if (/server up|site host up|\bopen on\b|\bopen —|rebuild ok|valid until|listening on|public join url|closed$/i.test(text)) return "ok";
    return "info";
  }

  function describePlain(origin, body) {
    const text = body.replace(PATH_RE, "$1");
    if (origin === "cargo") {
      const lvl = /^error|\berror\[/i.test(text) ? "err" : /^warning/i.test(text) ? "warn" : /Finished/.test(text) ? "ok" : "info";
      return { src: { label: "Build", cls: "build", cat: "build" }, level: lvl, verbose: lvl === "info", parts: [text] };
    }
    if (origin === "console") {
      let src = { label: "Console", cls: "", cat: "system" };
      if (/^(spawning|server up|stopping pid|kill )/i.test(text)) {
        src = { label: "Console", cls: "", cat: "system" };
      } else if (/^site /i.test(text)) {
        src = { label: "Site", cls: "net", cat: "net" };
      } else if (/UPnP|forward|port /i.test(text)) {
        src = { label: "Router", cls: "net", cat: "net" };
      } else if (/ACME|certificate|DuckDNS|secure/i.test(text)) {
        src = { label: "TLS", cls: "tls", cat: "net" };
      } else if (/rebuild|cargo/i.test(text)) {
        src = { label: "Build", cls: "build", cat: "build" };
      }
      const verbose = /^manifest |^GUI http|^site host binding/.test(text);
      let clean = text
        .replace(/^(site )?UPnP:\s*/i, "")
        .replace(/^spawning (\S+)/, "Starting game server: $1")
        .replace(/^server up pid=(\d+)/, "Game server started (pid $1)");
      clean = clean.charAt(0).toUpperCase() + clean.slice(1);
      return { src: src, level: levelFromText(text), verbose: verbose, parts: [clean] };
    }
    let src = { label: "Server", cls: "", cat: "system" };
    if (/ACME|certificate|DuckDNS/i.test(text)) src = { label: "TLS", cls: "tls", cat: "net" };
    else if (/UPnP|router|forward/i.test(text)) src = { label: "Router", cls: "net", cat: "net" };
    const verbose = /^Share wss?:\/\/<host>|^\(LAN friends|^ACME certificate for .* valid until/.test(text);
    let clean = text.replace(/^ACME:\s*/, "");
    clean = clean.charAt(0).toUpperCase() + clean.slice(1);
    return { src: src, level: levelFromText(text), verbose: verbose, parts: [clean] };
  }

  function describe(line) {
    let origin = "out";
    let body = line;
    const pm = /^\[(console|err|out|cargo)\]\s?/.exec(line);
    if (pm) { origin = pm[1]; body = line.slice(pm[0].length); }
    const tm = origin !== "console" && origin !== "cargo" ? TRACE_RE.exec(body) : null;
    if (!tm) return describePlain(origin, body);
    const kv = {};
    let m;
    KV_RE.lastIndex = 0;
    while ((m = KV_RE.exec(tm[4]))) {
      let v = m[2];
      if (v.charAt(0) === '"') { try { v = JSON.parse(v); } catch (_) { v = v.slice(1, -1); } }
      kv[m[1]] = v;
    }
    const message = tm[4].replace(KV_RE, "").trim();
    if (kv.clientId && kv.name && !names[kv.clientId]) setName(kv.clientId, kv.name);
    const traceLevel = { ERROR: "err", WARN: "warn", INFO: "info", DEBUG: "info", TRACE: "info" }[tm[2]];
    const ev = kv.event || "";
    const rule = EVENTS[ev] ? EVENTS[ev](kv) : null;
    const d = {
      at: Date.parse(tm[1]),
      src: srcFor(tm[3], ev, kv),
      level: (rule && rule.level) || traceLevel,
      verbose: rule ? !!rule.verbose : tm[2] === "DEBUG" || tm[2] === "TRACE",
      ic: rule && rule.ic,
      parts: null
    };
    if (rule) {
      d.parts = rule.parts;
    } else {
      d.parts = [message || sentence(ev || "server event")];
      Object.keys(kv).forEach(function (k) {
        if (k === "event") return;
        d.parts.push(" ");
        if (k === "clientId") d.parts.push(who(kv[k]));
        else if (k === "roomId") d.parts.push("room ", c(kv[k]));
        else if (k === "error") d.parts.push("— " + kv[k]);
        else d.parts.push(c(words(k) + " " + kv[k]));
      });
    }
    return d;
  }

  function nameFor(id) { return names[id] || "player " + id.slice(0, 4); }

  function setName(id, n) {
    names[id] = n;
    logEl.querySelectorAll('.chip.who[data-client="' + CSS.escape(id) + '"]').forEach(function (el) {
      el.textContent = n;
      const le = el.closest(".le");
      if (le) le.dataset.search = (le.querySelector(".m").textContent + " " + le.querySelector(".raw").textContent).toLowerCase();
    });
  }

  function learnNames(snap) {
    const players = (snap && snap.players) || [];
    players.forEach(function (p) {
      const n = p && p.clientId && (p.resolvedName || p.displayName);
      if (n && names[p.clientId] !== n) setName(p.clientId, n);
    });
  }

  function renderParts(target, parts) {
    parts.forEach(function (p) {
      if (p == null || p === "") return;
      if (typeof p === "string") {
        p.split(URL_RE).forEach(function (piece, i) {
          if (!piece) return;
          if (i % 2) {
            const u = document.createElement("span");
            u.className = "chip url";
            u.textContent = piece;
            target.appendChild(u);
          } else {
            target.appendChild(document.createTextNode(piece));
          }
        });
        return;
      }
      const span = document.createElement("span");
      if (p.who) {
        span.className = "chip who";
        span.dataset.client = p.who;
        span.title = p.who;
        span.textContent = nameFor(p.who);
      } else {
        span.className = "chip" + (p.cls ? " " + p.cls : "");
        span.textContent = p.chip;
      }
      target.appendChild(span);
    });
  }

  function clock(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }

  function entryVisible(el) {
    if (el.classList.contains("verbose") && !logFilter.verbose && logFilter.cat !== "problem") return false;
    if (logFilter.cat === "problem") {
      if (!(el.classList.contains("warn") || el.classList.contains("err"))) return false;
    } else if (logFilter.cat !== "all" && el.dataset.cat !== logFilter.cat) {
      return false;
    }
    if (logFilter.q && el.dataset.search.indexOf(logFilter.q) === -1) return false;
    return true;
  }

  function paintEmpty() {
    const any = logEl.querySelector(".le:not(.hidden)");
    logEmpty.style.display = any ? "none" : "";
    const total = logEl.querySelectorAll(".le").length;
    logEmpty.textContent = total ? "Nothing matches this filter." : "Waiting for log messages…";
  }

  function applyLogFilter() {
    logEl.querySelectorAll(".le").forEach(function (el) {
      el.classList.toggle("hidden", !entryVisible(el));
    });
    Array.prototype.forEach.call(logSeg.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-cat") === logFilter.cat);
    });
    logVerbose.checked = logFilter.verbose;
    paintEmpty();
    logEl.scrollTop = logEl.scrollHeight;
    stickBottom = true;
    btnLogLatest.classList.remove("show");
  }

  function paintProblemCount() {
    problemCountEl.textContent = problemCount ? String(problemCount > 99 ? "99+" : problemCount) : "";
  }

  function clearLog() {
    logEl.querySelectorAll(".le").forEach(function (el) { el.remove(); });
    lastEntry = null;
    problemCount = 0;
    paintProblemCount();
    paintEmpty();
    btnLogLatest.classList.remove("show");
  }

  function appendLog(line, at) {
    const d = describe(line);
    const when = d.at || at || Date.now();
    const level = d.level || "info";
    const probe = document.createElement("span");
    renderParts(probe, d.parts);
    const key = d.src.label + "|" + level + "|" + probe.textContent;
    if (lastEntry && lastEntry.key === key && when - lastEntry.at < 60000) {
      lastEntry.count += 1;
      lastEntry.at = when;
      lastEntry.rep.textContent = " ×" + lastEntry.count;
      lastEntry.el.querySelector(".t").textContent = clock(when);
      lastEntry.el.querySelector(".raw").textContent += "\n" + line;
      return;
    }
    const el = document.createElement("div");
    el.className = "le " + level + (d.verbose ? " verbose" : "");
    el.dataset.cat = d.src.cat;
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(when);
    t.title = new Date(when).toLocaleString();
    const ic = document.createElement("span");
    ic.className = "ic";
    ic.textContent = d.ic || { ok: "✓", warn: "!", err: "✕", info: "•" }[level];
    const m = document.createElement("span");
    m.className = "m";
    const src = document.createElement("span");
    src.className = "src" + (d.src.cls ? " " + d.src.cls : "");
    src.textContent = d.src.label;
    m.appendChild(src);
    while (probe.firstChild) m.appendChild(probe.firstChild);
    const rep = document.createElement("span");
    rep.className = "rep";
    m.appendChild(rep);
    const raw = document.createElement("div");
    raw.className = "raw";
    raw.textContent = line;
    el.append(t, ic, m, raw);
    el.dataset.search = (m.textContent + " " + line).toLowerCase();
    if (!entryVisible(el)) el.classList.add("hidden");
    logEl.appendChild(el);
    lastEntry = { key: key, el: el, rep: rep, count: 1, at: when };
    if (level === "warn" || level === "err") {
      problemCount += 1;
      paintProblemCount();
    }
    const entries = logEl.querySelectorAll(".le");
    for (let i = 0; i < entries.length - LOG_MAX; i++) entries[i].remove();
    if (!el.classList.contains("hidden")) {
      logEmpty.style.display = "none";
      if (stickBottom) logEl.scrollTop = logEl.scrollHeight;
      else btnLogLatest.classList.add("show");
    }
  }

  logEl.addEventListener("click", function (ev) {
    const el = ev.target.closest(".le");
    if (!el || (window.getSelection && String(window.getSelection()))) return;
    el.classList.toggle("open");
  });
  logSeg.addEventListener("click", function (ev) {
    const b = ev.target.closest("button[data-cat]");
    if (!b) return;
    logFilter.cat = b.getAttribute("data-cat");
    localStorage.setItem("mpLogCat", logFilter.cat);
    applyLogFilter();
  });
  logVerbose.addEventListener("change", function () {
    logFilter.verbose = logVerbose.checked;
    localStorage.setItem("mpLogVerbose", logFilter.verbose ? "1" : "0");
    applyLogFilter();
  });
  logSearch.addEventListener("input", function () {
    logFilter.q = logSearch.value.trim().toLowerCase();
    applyLogFilter();
  });
  btnLogLatest.addEventListener("click", function () {
    logEl.scrollTop = logEl.scrollHeight;
    stickBottom = true;
    btnLogLatest.classList.remove("show");
  });
  applyLogFilter();

  async function post(path) {
    try {
      const res = await fetch(path, { method: "POST" });
      const st = await res.json().catch(function () { return null; });
      if (st) paintStatus(st);
      if (!res.ok && st && st.message) appendLog("[console] " + st.message);
    } catch (e) {
      appendLog("[console] request failed: " + e);
    }
  }

  btnPower.addEventListener("click", function () {
    post(btnPower.textContent === "Stop" ? "/api/stop" : "/api/start");
  });
  btnSite.addEventListener("click", function () {
    post(btnSite.textContent === "Stop site" ? "/api/site/stop" : "/api/site/start");
  });
  btnRestart.addEventListener("click", function () { post("/api/restart"); });
  async function postJson(path, body) {
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const st = await res.json().catch(function () { return null; });
      if (st) paintStatus(st);
      return res.ok;
    } catch (e) {
      appendLog("[console] request failed: " + e);
      return false;
    }
  }
  function wirePort(target, input, btn) {
    async function apply() {
      if (btn.disabled) return;
      btn.disabled = true;
      await postJson("/api/port", { target: target, port: parseInt(input.value, 10) });
      input.dataset.dirty = "";
      input.blur();
      refresh();
    }
    input.addEventListener("input", function () { input.dataset.dirty = "1"; });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") apply();
      if (e.key === "Escape") { input.dataset.dirty = ""; input.blur(); refresh(); }
    });
    btn.addEventListener("click", apply);
  }
  wirePort("game", gamePort, btnGamePort);
  wirePort("site", sitePort, btnSitePort);
  btnGameUpnp.addEventListener("click", function () {
    btnGameUpnp.disabled = true;
    postJson("/api/upnp", { target: "game", enabled: btnGameUpnp.textContent === "Start UPnP" });
  });
  btnSiteUpnp.addEventListener("click", function () {
    btnSiteUpnp.disabled = true;
    postJson("/api/upnp", { target: "site", enabled: btnSiteUpnp.textContent === "Start UPnP" });
  });
  async function postSecure() {
    const body = {
      secure_wss: chkSecure.checked,
      acme_staging: chkStaging.checked,
      duckdns_domain: duckDomain.value.trim()
    };
    if (duckToken.value.trim()) body.duckdns_token = duckToken.value.trim();
    try {
      const res = await fetch("/api/secure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      duckToken.value = "";
      const st = await res.json().catch(function () { return null; });
      if (st) paintStatus(st);
    } catch (e) {
      appendLog("[console] request failed: " + e);
    }
  }
  chkSecure.addEventListener("change", postSecure);
  chkStaging.addEventListener("change", postSecure);
  btnDuckSave.addEventListener("click", postSecure);
  function copyJoinUrl() {
    if (publicWs.classList.contains("empty") || !navigator.clipboard) return;
    const url = publicWs.textContent;
    navigator.clipboard.writeText(url).then(function () {
      btnCopyWs.textContent = "Copied";
      setTimeout(function () { btnCopyWs.textContent = "Copy"; }, 1400);
    }).catch(function () {});
  }
  publicWs.addEventListener("click", copyJoinUrl);
  btnCopyWs.addEventListener("click", copyJoinUrl);
  duckDomain.addEventListener("keydown", function (e) { if (e.key === "Enter") postSecure(); });
  duckToken.addEventListener("keydown", function (e) { if (e.key === "Enter") postSecure(); });
  btnShutdown.addEventListener("click", async function () {
    if (shuttingDown) return;
    if (!window.confirm("Shut down the console completely?\n\nThis stops the game server, site host, and exits start-server.bat.")) {
      return;
    }
    shuttingDown = true;
    btnShutdown.disabled = true;
    btnPower.disabled = true;
    btnSite.disabled = true;
    btnRestart.disabled = true;
    btnShutdown.textContent = "Shutting down…";
    phaseLabel.textContent = "shutting down";
    msg.textContent = "Console exiting…";
    appendLog("[console] Shutdown requested");
    try {
      await fetch("/api/shutdown", { method: "POST" });
    } catch (e) {
      /* connection drop is expected as the process exits */
    }
    appendLog("[console] Console process exiting — bat window should close");
  });
  document.getElementById("btnClear").addEventListener("click", clearLog);

  viewSeg.addEventListener("click", function (ev) {
    const btn = ev.target.closest("button[data-view]");
    if (!btn) return;
    raceView = btn.getAttribute("data-view");
    if (raceView === "mosaic") focusId = null;
    Array.prototype.forEach.call(viewSeg.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b === btn);
    });
    renderSpectate(lastSnap);
  });
  btnBackMosaic.addEventListener("click", function () {
    raceView = "mosaic";
    focusId = null;
    Array.prototype.forEach.call(viewSeg.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-view") === "mosaic");
    });
    renderSpectate(lastSnap);
  });
  roomPick.addEventListener("change", function () { pollSpectate(); });

  function snakeColor(boardOrSnake) {
    if (!boardOrSnake) return { primary: "#4E7CF6", secondary: "#17439F" };
    if (boardOrSnake.Sc || boardOrSnake.Yc) {
      return {
        primary: boardOrSnake.Sc || boardOrSnake.Yc,
        secondary: boardOrSnake.Yc || boardOrSnake.Sc
      };
    }
    const id = boardOrSnake.colorId;
    if (id != null && COLORS[id]) {
      return { primary: COLORS[id][0], secondary: COLORS[id][1] };
    }
    return { primary: "#4E7CF6", secondary: "#17439F" };
  }

  function themeOf(board) {
    const t = (board && board.themeColors) || {};
    return {
      light: t.light || "#aad751",
      dark: t.dark || "#a2d149",
      border: t.border || "#578a34",
      apple: t.apple || "#e7471d"
    };
  }

  function cellPts(body) {
    if (!body || !body.length) return [];
    return body.map(function (c) {
      if (Array.isArray(c)) return { x: +c[0], y: +c[1] };
      return { x: +c.x, y: +c.y };
    }).filter(function (c) { return isFinite(c.x) && isFinite(c.y); });
  }

  function hexToRgb(hex) {
    const s = String(hex || "").replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(rgb) {
    return "#" + rgb.map(function (x) {
      return Math.max(0, Math.min(255, x | 0)).toString(16).padStart(2, "0");
    }).join("");
  }

  /** WallSolver-style tapered snake (matches MultiplayerGsm.drawWallSolverStyleSnakeRun). */
  function drawWallSnake(ctx, body, ox, oy, cell, colorInfo, dir, alive) {
    const ptsBody = cellPts(body);
    if (!ptsBody.length) return;
    const pts = [];
    for (let i = ptsBody.length - 1; i >= 0; i--) {
      const p = ptsBody[i];
      pts.push([ox + (p.x + 0.5) * cell, oy + (p.y + 0.5) * cell]);
    }
    const n = pts.length;
    const headI = n - 1;
    const neckI = n > 1 ? n - 2 : 0;
    let ux = 1, uy = 0;
    if (n > 1) {
      const dx = pts[headI][0] - pts[neckI][0];
      const dy = pts[headI][1] - pts[neckI][1];
      const len = Math.hypot(dx, dy) || 1;
      ux = dx / len; uy = dy / len;
    } else {
      const d = String(dir || "RIGHT").toUpperCase();
      if (d === "UP") { ux = 0; uy = -1; }
      else if (d === "DOWN") { ux = 0; uy = 1; }
      else if (d === "LEFT") { ux = -1; uy = 0; }
    }
    let tipPull = 0, headPull = 0;
    if (n > 1) {
      const gapPx = Math.hypot(pts[0][0] - pts[headI][0], pts[0][1] - pts[headI][1]);
      if (gapPx < cell * 1.25) { tipPull = cell * 0.45; headPull = cell * 0.2; }
    }
    let tipX = pts[0][0], tipY = pts[0][1];
    if (n > 1 && tipPull) {
      const dx = pts[1][0] - pts[0][0];
      const dy = pts[1][1] - pts[0][1];
      const len = Math.hypot(dx, dy) || 1;
      tipX += (dx / len) * tipPull;
      tipY += (dy / len) * tipPull;
    }
    const headX = pts[headI][0] - ux * headPull;
    const headY = pts[headI][1] - uy * headPull;
    const angle = Math.atan2(uy, ux);
    const headW = cell * 0.7;
    const tipW = cell * 0.32;
    let headCol = hexToRgb((colorInfo && colorInfo.primary) || "#4E7CF6") || [78, 124, 246];
    let tipCol = hexToRgb((colorInfo && colorInfo.secondary) || "#17439F") || [23, 67, 159];
    function mix(t) {
      return rgbToHex(headCol.map(function (v, i) {
        return Math.round(v + (tipCol[i] - v) * t);
      }));
    }
    function tAt(i) { return n <= 1 ? 0 : (headI - i) / headI; }
    function widthAt(t) { return headW * (1 - t) + tipW * t; }
    const poly = [[tipX, tipY, tAt(0)]];
    for (let i = 1; i < headI; i++) poly.push([pts[i][0], pts[i][1], tAt(i)]);
    poly.push([headX, headY, tAt(headI)]);
    const col = mix(0);
    const neckR = headW / 2;
    const bulgeR = neckR * 0.82;
    const bulgeX = neckR * 0.12;
    const bulgeY = neckR * 0.92;
    const snoutR = neckR * 1.02;
    const snoutX = neckR * 0.78;
    ctx.save();
    if (alive === false) ctx.globalAlpha = 0.45;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    function strokeBody() {
      for (let i = 0; i < poly.length - 1; i++) {
        const x0 = poly[i][0], y0 = poly[i][1], t0 = poly[i][2];
        const x1 = poly[i + 1][0], y1 = poly[i + 1][1], t1 = poly[i + 1][2];
        for (let s = 0; s < 4; s++) {
          const u0 = s / 4, u1 = (s + 1) / 4;
          const xa = x0 + (x1 - x0) * u0, ya = y0 + (y1 - y0) * u0;
          const xb = x0 + (x1 - x0) * u1, yb = y0 + (y1 - y0) * u1;
          const t = t0 * (1 - (u0 + u1) / 2) + t1 * ((u0 + u1) / 2);
          ctx.strokeStyle = mix(t);
          ctx.lineWidth = widthAt(t);
          ctx.beginPath();
          ctx.moveTo(xa, ya);
          ctx.lineTo(xb, yb);
          ctx.stroke();
        }
      }
    }
    function fillHead() {
      ctx.save();
      ctx.fillStyle = col;
      ctx.translate(headX, headY);
      ctx.rotate(angle);
      ctx.beginPath(); ctx.arc(0, 0, neckR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(bulgeX, -bulgeY, bulgeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(bulgeX, bulgeY, bulgeR, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(snoutX, 0, snoutR, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    for (let pass = 0; pass < 2; pass++) {
      const shade = pass === 0;
      ctx.shadowColor = shade ? "rgba(0,0,0,0.4)" : "transparent";
      ctx.shadowBlur = shade ? Math.max(1, cell * 0.045) : 0;
      ctx.shadowOffsetY = shade ? Math.max(1, cell * 0.05) : 0;
      strokeBody();
      fillHead();
    }
    const eyeR = Math.max(2.6, bulgeR * 0.72);
    const eyeX = bulgeX + bulgeR * 0.02;
    const eyeY = bulgeY;
    const pupilR = Math.max(1.3, eyeR * 0.4);
    const pupilFwd = eyeR * 0.38;
    const pupilIn = eyeR * 0.1;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.translate(headX, headY);
    ctx.rotate(angle);
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(eyeX, -eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeX, eyeY, eyeR, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = rgbToHex(tipCol.map(function (v) { return Math.round(v * 0.55); }));
    ctx.beginPath(); ctx.arc(eyeX + pupilFwd, -eyeY + pupilIn, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeX + pupilFwd, eyeY - pupilIn, pupilR, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  function sizeCanvas(canvas, cssW, cssH) {
    if (!canvas || !(cssW > 0) || !(cssH > 0)) return;
    const dpr = Math.min(2, (window.devicePixelRatio || 1));
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
  }

  /** Fit board into maxW×maxH without changing aspect (letterbox, no stretch). */
  function fitBoardBox(maxW, maxH, boardW, boardH) {
    const aspect = (boardW || 17) / Math.max(1, boardH || 15);
    let w = Math.max(1, Math.floor(maxW));
    let h = Math.max(1, Math.floor(w / aspect));
    if (maxH > 0 && h > maxH) {
      h = Math.max(1, Math.floor(maxH));
      w = Math.max(1, Math.floor(h * aspect));
    }
    return { w: w, h: h };
  }

  function spectateStageBox() {
    const stage = document.getElementById("specStage");
    if (!stage) return { w: 720, h: 520 };
    // Fill the stage; leave a little padding for the label row.
    const padX = 36;
    const padY = 48;
    return {
      w: Math.max(240, stage.clientWidth - padX),
      h: Math.max(220, stage.clientHeight - padY),
    };
  }

  function spectateMaxBoardHeight() {
    return Math.max(220, spectateStageBox().h);
  }

  const appleImgCache = Object.create(null);
  function appleTypeIndex(type, appleIndex) {
    let idx = type;
    if (idx == null || idx === "" || Number(idx) < 0 || Number.isNaN(Number(idx))) {
      idx = appleIndex;
    }
    idx = Number(idx);
    if (!Number.isFinite(idx) || idx < 0) idx = 0;
    return Math.min(99, idx | 0);
  }
  /** Same-origin proxy — Google CDN often fails as a red-dot fallback in the console. */
  function appleSpriteUrl(type, appleIndex) {
    const idx = appleTypeIndex(type, appleIndex);
    return "/api/fruit/" + idx;
  }
  function getAppleImage(type, appleIndex) {
    const url = appleSpriteUrl(type, appleIndex);
    if (appleImgCache[url]) return appleImgCache[url];
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onload = function () {
      if (lastSnap) renderSpectate(lastSnap);
    };
    img.onerror = function () {
      // Keep cache entry so we do not hammer a failing index.
    };
    try { img.src = url; } catch (e) { return null; }
    appleImgCache[url] = img;
    return img;
  }
  // Warm common fruit indices so the first paint is less likely to fall back.
  (function prefetchFruitSprites() {
    for (let i = 0; i <= 24; i++) getAppleImage(i, i);
  })();

  /** Matches MultiplayerGsm.drawBoardOnCanvas layout + snake paint. */
  function paintBoardOnCanvas(canvas, board, cssW, cssH, settings) {
    if (!canvas || !board) return;
    sizeCanvas(canvas, cssW || 240, cssH || 212);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const theme = themeOf(board);
    const w = board.width || 17;
    const h = board.height || 15;
    const cw = canvas.width;
    const ch = canvas.height;
    const cell = Math.min(cw / w, ch / h);
    const ox = (cw - cell * w) / 2;
    const oy = (ch - cell * h) / 2;
    ctx.fillStyle = theme.border;
    ctx.fillRect(0, 0, cw, ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? theme.light : theme.dark;
        ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
      }
    }
    const walls = board.walls;
    if (Array.isArray(walls)) {
      for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        const wx = wall.x != null ? +wall.x : +wall[0];
        const wy = wall.y != null ? +wall.y : +wall[1];
        if (!isFinite(wx) || !isFinite(wy)) continue;
        ctx.fillStyle = theme.border;
        ctx.fillRect(ox + wx * cell, oy + wy * cell, cell, cell);
      }
    }
    const apples = board.apples || board.fruit || board.collectables || [];
    const appleIndex =
      board.appleIndex != null
        ? board.appleIndex
        : settings && settings.apple != null
          ? settings.apple
          : 0;
    for (let i = 0; i < apples.length; i++) {
      const a = apples[i];
      const pos = a && a.pos;
      const ax =
        a.x != null ? +a.x
          : pos && pos.x != null ? +pos.x
            : +a[0];
      const ay =
        a.y != null ? +a.y
          : pos && pos.y != null ? +pos.y
            : +a[1];
      if (!isFinite(ax) || !isFinite(ay) || ax < 0 || ay < 0) continue;
      const cx = ox + ax * cell + cell / 2;
      const cy = oy + ay * cell + cell / 2;
      if (a.poison) {
        ctx.fillStyle = "#37474f";
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.35, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const rawType =
        a.type != null ? a.type
          : a.type_id != null ? a.type_id
            : a.kind != null ? a.kind
              : null;
      const img = getAppleImage(rawType, appleIndex);
      if (img && img.complete && img.naturalWidth > 0) {
        const size = cell * 0.92;
        try {
          ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
        } catch (eDraw) {
          ctx.fillStyle = theme.apple;
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.35, 0, Math.PI * 2);
          ctx.fill();
        }
      } else {
        ctx.fillStyle = theme.apple;
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const remotes = board.snakes || [];
    for (let ri = 0; ri < remotes.length; ri++) {
      const rs = remotes[ri];
      if (!rs) continue;
      drawWallSnake(ctx, rs.body, ox, oy, cell, snakeColor(rs), rs.dir, rs.alive);
      if (rs.body2) {
        drawWallSnake(ctx, rs.body2, ox, oy, cell, snakeColor(rs), rs.dir2 || rs.dir, rs.alive);
      }
    }
    if (board.body2) {
      drawWallSnake(ctx, board.body2, ox, oy, cell, snakeColor(board), board.dir2 || board.dir, board.alive);
    }
    if (board.body && board.body.length) {
      drawWallSnake(ctx, board.body, ox, oy, cell, snakeColor(board), board.dir, board.alive);
    }
  }

  function hideAllSpec() {
    specEmpty.style.display = "none";
    specMosaic.classList.remove("show");
    specFocus.classList.remove("show");
    specCoop.classList.remove("show");
    btnBackMosaic.style.display = "none";
  }

  function updateRoomPick(snap) {
    const rooms = (snap && snap.rooms) || [];
    const cur = roomPick.value;
    const opts = ['<option value="">Auto</option>'];
    for (let i = 0; i < rooms.length; i++) {
      const r = rooms[i];
      const code = r.roomCode || "";
      const label = code + " · " + (r.mode || "?") +
        (r.sessionActive ? " · live" : "") +
        " (" + (r.playerCount || 0) + "p)";
      opts.push('<option value="' + code + '"' + (cur === code ? " selected" : "") + ">" + label + "</option>");
    }
    roomPick.innerHTML = opts.join("");
    if (cur) roomPick.value = cur;
  }

  function layoutMosaic(n, boardW, boardH) {
    const stage = document.getElementById("specStage");
    const availW = Math.max(200, stage.clientWidth - 24);
    const availH = Math.max(220, Math.min(560, window.innerHeight * 0.45));
    const gap = 10;
    const chrome = 28;
    const aspect = boardW / Math.max(1, boardH);
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cellW = (availW - gap * (cols - 1)) / cols;
      const cellH = (availH - gap * (rows - 1)) / rows;
      const maxBoardH = Math.max(40, cellH - chrome);
      let w = cellW;
      let h = w / aspect;
      if (h > maxBoardH) { h = maxBoardH; w = h * aspect; }
      if (w > cellW) { w = cellW; h = w / aspect; }
      const area = w * h;
      if (!best || area > best.area) best = { cols: cols, w: Math.floor(w), h: Math.floor(h), area: area };
    }
    return best || { cols: 1, w: 200, h: 180, area: 0 };
  }

  function playerName(snap, clientId) {
    const players = (snap && snap.players) || [];
    for (let i = 0; i < players.length; i++) {
      if (players[i].clientId === clientId) {
        return players[i].resolvedName || players[i].displayName || clientId.slice(0, 6);
      }
    }
    return clientId.slice(0, 6);
  }

  function renderSpectate(snap) {
    lastSnap = snap;
    learnNames(snap);
    updateRoomPick(snap);
    hideAllSpec();
    if (!snap || snap.offline || (!snap.mode && !(snap.rooms && snap.rooms.length))) {
      specEmpty.style.display = "flex";
      specEmpty.textContent = (snap && snap.message) || "Waiting for game server…";
      specModeTag.textContent = "offline";
      specMeta.innerHTML = "";
      viewSeg.style.opacity = "0.35";
      return;
    }
    viewSeg.style.opacity = snap.mode === "race" ? "1" : "0.35";
    const mode = snap.mode || "—";
    specModeTag.textContent = mode + (snap.sessionActive ? " · live" : " · lobby");
    const roomCode = snap.roomCode || "—";
    specMeta.innerHTML =
      "<span>Room <strong>" + roomCode + "</strong></span>" +
      "<span>Players <strong>" + ((snap.players && snap.players.length) || 0) + "</strong></span>" +
      (snap.mode === "coop" && snap.coopAuthority
        ? "<span>Authority <strong>" + snap.coopAuthority + "</strong></span>"
        : "");

    if (snap.mode === "coop") {
      const board = snap.board;
      if (!board || (!board.snakes || !board.snakes.length) && !(board.apples && board.apples.length) && !snap.sessionActive) {
        specEmpty.style.display = "flex";
        specEmpty.textContent = snap.sessionActive
          ? "Co-op session live — waiting for board / poses…"
          : "Co-op lobby — start a match to spectate the shared board.";
        return;
      }
      specCoop.classList.add("show");
      const theme = themeOf(board);
      if (theme.border) document.getElementById("specStage").style.background = theme.border;
      const stageBox = spectateStageBox();
      const box = fitBoardBox(stageBox.w, stageBox.h, board.width || 17, board.height || 15);
      paintBoardOnCanvas(coopSvg, board, box.w, box.h, snap.settings);
      return;
    }

    if (snap.mode === "race") {
      const boards = snap.boards || {};
      const ids = Object.keys(boards);
      // Prefer seated players even without board yet
      const players = (snap.players || []).filter(function (p) { return p.role === "player"; });
      let order = players.map(function (p) { return p.clientId; }).filter(function (id) {
        return boards[id];
      });
      if (!order.length) order = ids;
      if (!order.length) {
        specEmpty.style.display = "flex";
        specEmpty.textContent = snap.sessionActive
          ? "Race live — waiting for BOARD_DELTA from players…"
          : "Race lobby — boards appear when players run.";
        return;
      }

      if (raceView === "focus" || focusId) {
        const fid = focusId && boards[focusId] ? focusId : order[0];
        focusId = fid;
        raceView = "focus";
        Array.prototype.forEach.call(viewSeg.querySelectorAll("button"), function (b) {
          b.classList.toggle("active", b.getAttribute("data-view") === "focus");
        });
        btnBackMosaic.style.display = "inline-block";
        specFocus.classList.add("show");
        const b = boards[fid];
        const score = b.score != null ? " · " + b.score : "";
        focusLabel.textContent = playerName(snap, fid) + score;
        const theme = themeOf(b);
        if (theme.border) document.getElementById("specStage").style.background = theme.border;
        const stageBox = spectateStageBox();
        const box = fitBoardBox(stageBox.w, stageBox.h, b.width || 17, b.height || 15);
        paintBoardOnCanvas(focusSvg, b, box.w, box.h, snap.settings);
        return;
      }

      let bw = 17, bh = 15;
      let chromeBorder = null;
      for (let i = 0; i < order.length; i++) {
        const b = boards[order[i]];
        if (b && b.width) bw = b.width;
        if (b && b.height) bh = b.height;
        if (!chromeBorder && b && b.themeColors && b.themeColors.border) {
          chromeBorder = b.themeColors.border;
        }
      }
      if (chromeBorder) document.getElementById("specStage").style.background = chromeBorder;
      const layout = layoutMosaic(order.length, bw, bh);
      specMosaic.classList.add("show");
      specMosaic.style.gridTemplateColumns = "repeat(" + layout.cols + ", " + layout.w + "px)";
      const html = [];
      for (let i = 0; i < order.length; i++) {
        const id = order[i];
        const b = boards[id];
        const name = (b && b.displayName) || playerName(snap, id);
        const score = b && b.score != null ? b.score : "—";
        const alive = b && b.alive === false ? " · dead" : "";
        html.push(
          '<div class="spec-cell" data-id="' + id + '">' +
            '<div class="label"><span>' + name + alive + '</span><span class="score">' + score + "</span></div>" +
            '<canvas width="240" height="212"></canvas>' +
          "</div>"
        );
      }
      specMosaic.innerHTML = html.join("");
      Array.prototype.forEach.call(specMosaic.querySelectorAll(".spec-cell"), function (cell) {
        const id = cell.getAttribute("data-id");
        const canvas = cell.querySelector("canvas");
        paintBoardOnCanvas(canvas, boards[id], layout.w, layout.h, snap.settings);
        cell.addEventListener("click", function () {
          focusId = id;
          raceView = "focus";
          Array.prototype.forEach.call(viewSeg.querySelectorAll("button"), function (b) {
            b.classList.toggle("active", b.getAttribute("data-view") === "focus");
          });
          renderSpectate(lastSnap);
        });
      });
      return;
    }

    specEmpty.style.display = "flex";
    specEmpty.textContent = snap.message || "No active mode.";
  }

  async function pollSpectate() {
    try {
      const room = roomPick.value;
      const url = room ? "/api/spectate?room=" + encodeURIComponent(room) : "/api/spectate";
      const res = await fetch(url);
      const snap = await res.json();
      renderSpectate(snap);
    } catch (e) {
      renderSpectate({ offline: true, message: "Spectate unreachable: " + e, rooms: [] });
    }
  }

  async function refresh() {
    try {
      const res = await fetch("/api/status");
      paintStatus(await res.json());
    } catch (_) {}
  }
  refresh();
  setInterval(refresh, 500);
  pollSpectate();
  setInterval(pollSpectate, 16);
  window.addEventListener("resize", function () { renderSpectate(lastSnap); });

  const es = new EventSource("/api/logs");
  es.addEventListener("reset", clearLog);
  es.addEventListener("log", function (ev) {
    let entry;
    try { entry = JSON.parse(ev.data); } catch (_) { entry = { line: ev.data }; }
    appendLog(entry.line || "", entry.t);
  });
  es.addEventListener("status", function (ev) {
    try { paintStatus(JSON.parse(ev.data)); } catch (_) {}
  });
  es.onerror = function () { /* auto-reconnect */ };
})();
</script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::strip_ansi;

    #[test]
    fn strip_ansi_removes_tracing_style_codes() {
        let raw = "\u{1b}[2m2026-09-20T19:28:48.123Z\u{1b}[0m \u{1b}[32mINFO\u{1b}[0m \u{1b}[3mroomId\u{1b}[0m\u{1b}[2m=\u{1b}[0mA6L6 event=coop_session_end";
        let clean = strip_ansi(raw);
        assert_eq!(
            clean,
            "2026-09-20T19:28:48.123Z INFO roomId=A6L6 event=coop_session_end"
        );
        assert!(!clean.contains('\u{1b}'));
        assert!(!clean.contains("[32m"));
    }

    #[test]
    fn strip_ansi_leaves_plain_text_alone() {
        assert_eq!(strip_ansi("[err] hello"), "[err] hello");
    }
}
