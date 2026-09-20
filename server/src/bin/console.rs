//! Local control GUI for the multiplayer room server.
//! Serves a True Dark themed dashboard on :7778 that starts/stops/rebuilds
//! the game server on :7777 and streams its logs.

use axum::extract::{Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::Json;
use axum::Router;
use clap::Parser;
use futures_util::stream::Stream;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

const LOG_CAP: usize = 2000;
const DEFAULT_GUI: &str = "0.0.0.0:7778";
const DEFAULT_SERVER: &str = "0.0.0.0:7777";

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

#[derive(Clone, Debug, Serialize)]
struct Status {
    phase: Phase,
    running: bool,
    pid: Option<u32>,
    server_bind: String,
    message: String,
    rebuilding: bool,
}

struct Shared {
    phase: Mutex<Phase>,
    message: Mutex<String>,
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
    log_lines: Mutex<Vec<String>>,
    log_tx: broadcast::Sender<String>,
    busy: AtomicBool,
    server_bind: SocketAddr,
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
        Status {
            phase,
            running: matches!(phase, Phase::Running | Phase::Starting),
            pid: *self.pid.lock(),
            server_bind: self.server_bind.to_string(),
            message: self.message.lock().clone(),
            rebuilding: phase == Phase::Rebuilding,
        }
    }

    fn set_phase(&self, phase: Phase, message: String) {
        *self.phase.lock() = phase;
        *self.message.lock() = message;
    }

    fn push_log(&self, line: String) {
        {
            let mut lines = self.log_lines.lock();
            lines.push(line.clone());
            if lines.len() > LOG_CAP {
                let drain = lines.len() - LOG_CAP;
                lines.drain(0..drain);
            }
        }
        let _ = self.log_tx.send(line);
    }
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
    let (log_tx, _) = broadcast::channel(512);
    let shared = Arc::new(Shared {
        phase: Mutex::new(Phase::Idle),
        message: Mutex::new("Ready".into()),
        child: Mutex::new(None),
        pid: Mutex::new(None),
        log_lines: Mutex::new(Vec::new()),
        log_tx,
        busy: AtomicBool::new(false),
        server_bind: args.server_bind,
        manifest,
        repo_root,
        server_bin,
        extra_args: args.server_args,
        fruit_sprites: Mutex::new(HashMap::new()),
    });

    shared.push_log(format!(
        "[console] GUI http://{}  ·  game server {}",
        args.gui_bind, args.server_bind
    ));
    shared.push_log(format!(
        "[console] manifest {}  ·  bin {}",
        shared.manifest.display(),
        shared.server_bin.display()
    ));

    // Auto-start if a release binary already exists; otherwise idle until Restart.
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
        .route("/api/logs", get(api_logs))
        .route("/api/rooms", get(api_rooms_proxy))
        .route("/api/spectate", get(api_spectate_proxy))
        .route("/api/fruit/{idx}", get(api_fruit_sprite))
        .layer(CorsLayer::permissive())
        .with_state(shared);

    let listener = tokio::net::TcpListener::bind(args.gui_bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("failed to bind GUI on {}: {e}", args.gui_bind);
            std::process::exit(1);
        });
    let local = listener.local_addr().unwrap();
    eprintln!(
        "Multiplayer console (True Dark)  http://{local}\nGame server target  {}\n",
        args.server_bind
    );
    axum::serve(listener, app).await.unwrap();
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

fn game_http_base(bind: SocketAddr) -> String {
    let host = if bind.ip().is_unspecified() {
        "127.0.0.1".to_string()
    } else {
        bind.ip().to_string()
    };
    format!("http://{host}:{}", bind.port())
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
    let url = format!("{}{path}", game_http_base(s.server_bind));
    match reqwest::Client::new()
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
        for line in history {
            yield Ok(Event::default().event("log").data(line));
        }
        yield Ok(Event::default().event("status").data(
            serde_json::to_string(&s.status()).unwrap_or_else(|_| "{}".into())
        ));
        loop {
            match rx.recv().await {
                Ok(line) => yield Ok(Event::default().event("log").data(line)),
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
    s.set_phase(Phase::Starting, "Starting server…".to_string());
    s.push_log(format!(
        "[console] spawning {} --bind {}",
        s.server_bin.display(),
        s.server_bind
    ));

    let mut cmd = Command::new(&s.server_bin);
    cmd.arg("--bind")
        .arg(s.server_bind.to_string())
        .args(&s.extra_args)
        .current_dir(&s.repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

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
  .actions {
    display: flex; flex-wrap: wrap; gap: 10px;
  }
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
  .meta {
    margin-top: 14px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
    font-size: 0.86rem;
  }
  .meta .cell {
    background: var(--td-shadow);
    border: 1px solid var(--td-border);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .meta .label { color: var(--td-muted); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .meta .value { margin-top: 4px; font-family: ui-monospace, Consolas, monospace; word-break: break-all; }
  .log-panel { flex: 0 0 auto; display: flex; flex-direction: column; min-height: 140px; }
  .log-toolbar {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 10px; gap: 8px;
  }
  .log-toolbar button { padding: 7px 12px; font-size: 0.8rem; }
  #log {
    flex: 1;
    background: #0a0a0a;
    border: 1px solid var(--td-border);
    border-radius: 8px;
    padding: 12px 14px;
    overflow: auto;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: 12.5px;
    line-height: 1.45;
    color: #c9c9c9;
    white-space: pre-wrap;
    word-break: break-word;
    min-height: 120px;
    max-height: 22vh;
  }
  #log .dim { color: #666; }
  #log .cargo { color: #9aa7b8; }
  #log .err { color: #e09090; }
  #log .ok { color: #8fd49a; }
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
        <div class="sub">True Dark console · stop / rebuild / spectate</div>
      </div>
      <div class="status-pill" id="pill">
        <span class="dot" id="dot"></span>
        <span id="phaseLabel">idle</span>
      </div>
    </header>

    <section class="panel">
      <h2>Controls</h2>
      <div class="actions">
        <button class="primary" id="btnStart" type="button">Start</button>
        <button class="danger" id="btnStop" type="button">Stop</button>
        <button class="restart" id="btnRestart" type="button">Restart</button>
      </div>
      <div class="meta">
        <div class="cell"><div class="label">Message</div><div class="value" id="msg">—</div></div>
        <div class="cell"><div class="label">PID</div><div class="value" id="pid">—</div></div>
        <div class="cell"><div class="label">Game bind</div><div class="value" id="bind">—</div></div>
      </div>
    </section>

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
        <button type="button" id="btnClear">Clear view</button>
      </div>
      <div id="log" aria-live="polite"></div>
    </section>

    <footer>Open this page on the host machine · clients still use ws://&lt;lan-ip&gt;:7777/ws</footer>
  </div>
<script>
(function () {
  const logEl = document.getElementById("log");
  const phaseLabel = document.getElementById("phaseLabel");
  const dot = document.getElementById("dot");
  const msg = document.getElementById("msg");
  const pid = document.getElementById("pid");
  const bind = document.getElementById("bind");
  const btnStart = document.getElementById("btnStart");
  const btnStop = document.getElementById("btnStop");
  const btnRestart = document.getElementById("btnRestart");
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
  });

  function paintStatus(st) {
    if (!st) return;
    phaseLabel.textContent = st.phase || "idle";
    msg.textContent = st.message || "—";
    pid.textContent = st.pid != null ? String(st.pid) : "—";
    bind.textContent = st.server_bind || "—";
    dot.className = "dot";
    if (st.phase === "running") dot.classList.add("on");
    else if (st.phase === "error") dot.classList.add("err");
    else if (st.phase === "rebuilding" || st.phase === "starting" || st.phase === "stopping")
      dot.classList.add("busy");
    const busy = st.phase === "rebuilding" || st.phase === "starting" || st.phase === "stopping";
    btnStart.disabled = busy || st.running;
    btnStop.disabled = busy || !st.running;
    btnRestart.disabled = busy;
  }

  function appendLog(line) {
    const span = document.createElement("div");
    let cls = "";
    if (line.indexOf("[cargo]") === 0) cls = "cargo";
    else if (line.indexOf("[err]") === 0) cls = "err";
    else if (/rebuild ok|server up|Listening/i.test(line)) cls = "ok";
    else if (line.indexOf("[console]") === 0) cls = "dim";
    if (cls) span.className = cls;
    span.textContent = line;
    logEl.appendChild(span);
    while (logEl.childNodes.length > 2500) logEl.removeChild(logEl.firstChild);
    if (stickBottom) logEl.scrollTop = logEl.scrollHeight;
  }

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

  btnStart.addEventListener("click", function () { post("/api/start"); });
  btnStop.addEventListener("click", function () { post("/api/stop"); });
  btnRestart.addEventListener("click", function () { post("/api/restart"); });
  document.getElementById("btnClear").addEventListener("click", function () {
    logEl.innerHTML = "";
  });

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
  setInterval(refresh, 2000);
  pollSpectate();
  setInterval(pollSpectate, 150);
  window.addEventListener("resize", function () { renderSpectate(lastSnap); });

  const es = new EventSource("/api/logs");
  es.addEventListener("log", function (ev) { appendLog(ev.data); });
  es.addEventListener("status", function (ev) {
    try { paintStatus(JSON.parse(ev.data)); } catch (_) {}
  });
  es.onerror = function () { /* auto-reconnect */ };
})();
</script>
</body>
</html>
"##;
