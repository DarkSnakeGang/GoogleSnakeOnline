//! Optional TLS for wss:// — friends on LAN keep using plain ws://.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use multiplayer_server::protocol::{parse_envelope, Envelope};
use multiplayer_server::room::{generate_room_code, Room, MAX_CONNECTIONS};
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;
use tracing::{error, info, warn};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(name = "multiplayer-server", about = "Google Snake LAN multiplayer room server")]
struct Args {
    /// Bind address (LAN: 0.0.0.0:7777)
    #[arg(long, env = "MULTIPLAYER_BIND", default_value = "0.0.0.0:7777")]
    bind: SocketAddr,

    /// Log directory
    #[arg(long, env = "MULTIPLAYER_LOG_DIR", default_value = "logs")]
    log_dir: PathBuf,

    /// Default room code (empty = auto)
    #[arg(long, env = "MULTIPLAYER_DEFAULT_ROOM", default_value = "")]
    default_room: String,

    /// Optional PEM certificate for native wss:// (leave unset for LAN ws://)
    #[arg(long, env = "MULTIPLAYER_TLS_CERT")]
    tls_cert: Option<PathBuf>,

    /// Optional PEM private key for native wss:// (required with --tls-cert)
    #[arg(long, env = "MULTIPLAYER_TLS_KEY")]
    tls_key: Option<PathBuf>,
}

struct AppState {
    rooms: Mutex<HashMap<String, Room>>,
    clients: Mutex<HashMap<String, mpsc::UnboundedSender<String>>>,
    membership: Mutex<HashMap<String, String>>,
}

const MAX_WS_TEXT_BYTES: usize = 256 * 1024;
const MAX_DISPLAY_NAME_CHARS: usize = 32;
const MAX_MSGS_PER_SEC: u32 = 60;

fn sanitize_display_name(raw: Option<String>) -> Option<String> {
    let s = raw?;
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

fn is_valid_room_code(code: &str) -> bool {
    let bytes = code.as_bytes();
    bytes.len() == 4
        && bytes.iter().all(|b| matches!(b, b'A'..=b'H' | b'J'..=b'N' | b'P'..=b'Z' | b'2'..=b'9'))
}

impl AppState {
    fn new() -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            clients: Mutex::new(HashMap::new()),
            membership: Mutex::new(HashMap::new()),
        }
    }

    fn get_or_create_room(&self, code: &str) -> String {
        let mut rooms = self.rooms.lock();
        if !code.is_empty() && rooms.contains_key(code) {
            return code.to_string();
        }
        let c = if code.is_empty() {
            let mut gen = generate_room_code();
            while rooms.contains_key(&gen) {
                gen = generate_room_code();
            }
            gen
        } else {
            code.to_string()
        };
        rooms.insert(c.clone(), Room::new(c.clone()));
        info!(roomId = %c, event = "room_create");
        c
    }

    /// Drop membership + writer for anyone no longer in the room (hard kick).
    fn reap_orphans(&self, room_code: &str) {
        let in_room: std::collections::HashSet<String> = {
            let rooms = self.rooms.lock();
            rooms
                .get(room_code)
                .map(|r| r.clients.keys().cloned().collect())
                .unwrap_or_default()
        };
        let orphans: Vec<String> = {
            let membership = self.membership.lock();
            membership
                .iter()
                .filter(|(cid, rc)| *rc == room_code && !in_room.contains(*cid))
                .map(|(cid, _)| cid.clone())
                .collect()
        };
        if orphans.is_empty() {
            return;
        }
        {
            let mut membership = self.membership.lock();
            for cid in &orphans {
                membership.remove(cid);
            }
        }
        {
            let mut clients = self.clients.lock();
            for cid in &orphans {
                clients.remove(cid);
                info!(clientId = %cid, roomId = %room_code, event = "orphan_reaped");
            }
        }
    }

    fn gc_empty_rooms(&self) {
        let mut rooms = self.rooms.lock();
        let before = rooms.len();
        rooms.retain(|_, r| !r.clients.is_empty() || r.session_active);
        let removed = before.saturating_sub(rooms.len());
        if removed > 0 {
            info!(removed, event = "room_gc");
        }
    }

    fn flush_outbox(&self, room_code: &str) {
        let messages = {
            let mut rooms = self.rooms.lock();
            match rooms.get_mut(room_code) {
                Some(r) => r.take_outbox(),
                None => return,
            }
        };
        let clients = self.clients.lock();
        let membership = self.membership.lock();
        for (target, env) in messages {
            let raw = match serde_json::to_string(&env) {
                Ok(s) => s,
                Err(e) => {
                    error!(error = %e, event = "encode_fail");
                    continue;
                }
            };
            if let Some(tid) = target {
                if let Some(tx) = clients.get(&tid) {
                    let _ = tx.send(raw);
                }
            } else {
                for (cid, tx) in clients.iter() {
                    if membership.get(cid).map(|r| r == room_code).unwrap_or(false) {
                        let _ = tx.send(raw.clone());
                    }
                }
            }
        }
    }
}

#[tokio::main]
async fn main() {
    let args = Args::parse();
    std::fs::create_dir_all(&args.log_dir).ok();

    let file_appender = tracing_appender::rolling::daily(&args.log_dir, "multiplayer");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let filter = EnvFilter::try_from_default_env()
        .or_else(|_| EnvFilter::try_new("info"))
        .unwrap();

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(std::io::stderr))
        .with(fmt::layer().with_ansi(false).with_writer(non_blocking))
        .init();

    let tls_mode = match (&args.tls_cert, &args.tls_key) {
        (Some(c), Some(k)) => Some((c.clone(), k.clone())),
        (None, None) => None,
        _ => {
            eprintln!("error: both --tls-cert and --tls-key are required for wss (or omit both for plain ws://)");
            std::process::exit(2);
        }
    };

    let state = Arc::new(AppState::new());
    if !args.default_room.is_empty() {
        state.get_or_create_room(&args.default_room);
    }

    let tick_state = state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        let mut gc_ticks: u32 = 0;
        loop {
            interval.tick().await;
            gc_ticks = gc_ticks.wrapping_add(1);
            let codes: Vec<String> = tick_state.rooms.lock().keys().cloned().collect();
            for code in codes {
                {
                    let mut rooms = tick_state.rooms.lock();
                    if let Some(room) = rooms.get_mut(&code) {
                        if room.session_active {
                            room.tick();
                        }
                    }
                }
                tick_state.flush_outbox(&code);
                tick_state.reap_orphans(&code);
            }
            if gc_ticks % 50 == 0 {
                tick_state.gc_empty_rooms();
            }
        }
    });

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/health", get(|| async { "ok" }))
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    if let Some((cert, key)) = tls_mode {
        let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
            .await
            .expect("failed to load TLS cert/key");
        info!(
            bind = %args.bind,
            event = "listen_tls",
            hint = format!("Clients connect with wss://<host>:{}/ws", args.bind.port())
        );
        eprintln!(
            "Multiplayer server (TLS) listening on https://{}\nShare wss://<host>:{}/ws\n(LAN friends can still use a non-TLS process without --tls-*)",
            args.bind,
            args.bind.port()
        );
        axum_server::bind_rustls(args.bind, config)
            .serve(app.into_make_service_with_connect_info::<SocketAddr>())
            .await
            .unwrap();
    } else {
        let listener = tokio::net::TcpListener::bind(args.bind)
            .await
            .expect("bind failed");
        let local = listener.local_addr().unwrap();
        info!(
            bind = %local,
            event = "listen",
            hint = format!("Clients connect with ws://<lan-ip>:{}/ws", local.port())
        );
        eprintln!(
            "Multiplayer server listening on http://{local}  ws://{local}/ws\nShare ws://<your-lan-ip>:{}/ws\n(Optional TLS: --tls-cert cert.pem --tls-key key.pem for wss://)",
            local.port()
        );

        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    }
}

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let client_id = Uuid::new_v4().to_string();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    state.clients.lock().insert(client_id.clone(), tx);

    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(Message::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let mut room_code: Option<String> = None;
    let mut msg_window_start = std::time::Instant::now();
    let mut msg_window_count: u32 = 0;

    loop {
        // Exit promptly after kick (membership/writer reaped)
        if let Some(ref code) = room_code {
            let still = {
                let rooms = state.rooms.lock();
                rooms
                    .get(code)
                    .map(|r| r.clients.contains_key(&client_id))
                    .unwrap_or(false)
            };
            if !still {
                break;
            }
        }

        let msg = match tokio::time::timeout(Duration::from_millis(250), stream.next()).await {
            Ok(Some(Ok(m))) => m,
            Ok(Some(Err(_))) | Ok(None) => break,
            Err(_) => continue, // timeout — loop back for kick check
        };

        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Binary(_) => {
                warn!(clientId = %client_id, event = "binary_ignored");
                continue;
            }
        };

        if text.len() > MAX_WS_TEXT_BYTES {
            warn!(
                clientId = %client_id,
                bytes = text.len(),
                event = "ws_text_too_large"
            );
            let err = Envelope::new(
                "ERROR",
                json!({"code":"payload_too_large","message":"Message too large"}),
            );
            if let Ok(s) = serde_json::to_string(&err) {
                if let Some(tx) = state.clients.lock().get(&client_id) {
                    let _ = tx.send(s);
                }
            }
            break;
        }

        if msg_window_start.elapsed() >= Duration::from_secs(1) {
            msg_window_start = std::time::Instant::now();
            msg_window_count = 0;
        }
        msg_window_count = msg_window_count.saturating_add(1);
        if msg_window_count > MAX_MSGS_PER_SEC {
            warn!(clientId = %client_id, event = "ws_rate_limited");
            continue;
        }

        let env = match parse_envelope(&text) {
            Ok(e) => e,
            Err(e) => {
                error!(clientId = %client_id, error = %e, event = "malformed");
                let err = Envelope::new("ERROR", json!({"code": e, "message": e}));
                if let Ok(s) = serde_json::to_string(&err) {
                    if let Some(tx) = state.clients.lock().get(&client_id) {
                        let _ = tx.send(s);
                    }
                }
                continue;
            }
        };

        if env.msg_type == "HELLO" {
            let requested = env
                .payload
                .get("roomCode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let display_name = sanitize_display_name(
                env.payload
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            );
            let create = env
                .payload
                .get("create")
                .and_then(|v| v.as_bool())
                .unwrap_or(requested.is_empty());

            let code = if create || requested.is_empty() {
                state.get_or_create_room("")
            } else {
                if !is_valid_room_code(&requested) {
                    let err = Envelope::new(
                        "ERROR",
                        json!({"code":"bad_room","message":"Invalid room code"}),
                    );
                    if let Ok(s) = serde_json::to_string(&err) {
                        if let Some(tx) = state.clients.lock().get(&client_id) {
                            let _ = tx.send(s);
                        }
                    }
                    continue;
                }
                // A code nobody has opened yet becomes that room — joining and
                // hosting are the same action, so peers can agree on a code first.
                let requested = state.get_or_create_room(&requested);
                let rooms = state.rooms.lock();
                if rooms.get(&requested).map(|r| r.clients.len()).unwrap_or(0) >= MAX_CONNECTIONS {
                    drop(rooms);
                    let err = Envelope::new(
                        "ERROR",
                        json!({"code":"room_full","message":"Room is full (30)"}),
                    );
                    if let Ok(s) = serde_json::to_string(&err) {
                        if let Some(tx) = state.clients.lock().get(&client_id) {
                            let _ = tx.send(s);
                        }
                    }
                    continue;
                }
                drop(rooms);
                requested
            };

            let join_result = {
                let mut rooms = state.rooms.lock();
                let room = rooms.get_mut(&code).unwrap();
                room.join(client_id.clone(), display_name, Some(code.clone()))
            };

            match join_result {
                Ok(()) => {
                    state.membership.lock().insert(client_id.clone(), code.clone());
                    room_code = Some(code.clone());
                    state.flush_outbox(&code);
                }
                Err(e) => {
                    let err = Envelope::new("ERROR", json!({"code": e, "message": e}));
                    if let Ok(s) = serde_json::to_string(&err) {
                        if let Some(tx) = state.clients.lock().get(&client_id) {
                            let _ = tx.send(s);
                        }
                    }
                }
            }
            continue;
        }

        let Some(ref code) = room_code else {
            let err = Envelope::new(
                "ERROR",
                json!({"code":"not_joined","message":"Send HELLO first"}),
            );
            if let Ok(s) = serde_json::to_string(&err) {
                if let Some(tx) = state.clients.lock().get(&client_id) {
                    let _ = tx.send(s);
                }
            }
            continue;
        };

        {
            let mut rooms = state.rooms.lock();
            if let Some(room) = rooms.get_mut(code) {
                room.handle(&client_id, &env);
            }
        }
        state.flush_outbox(code);
        state.reap_orphans(code);

        let in_room = {
            let rooms = state.rooms.lock();
            rooms
                .get(code)
                .map(|r| r.clients.contains_key(&client_id))
                .unwrap_or(false)
        };
        if !in_room {
            state.membership.lock().remove(&client_id);
            break;
        }
    }

    if let Some(code) = room_code {
        {
            let mut rooms = state.rooms.lock();
            if let Some(room) = rooms.get_mut(&code) {
                room.leave(&client_id);
            }
        }
        state.flush_outbox(&code);
        state.reap_orphans(&code);
        state.membership.lock().remove(&client_id);
        state.gc_empty_rooms();
    }
    state.clients.lock().remove(&client_id);
    writer.abort();
    info!(clientId = %client_id, event = "disconnect", code = "ws_closed");
}
