//! Let's Encrypt certificate so HTTPS pages (googlesnakemods.com) can open
//! `wss://<host>:7777/ws`.
//!
//! With DuckDNS configured the certificate is for `<name>.duckdns.org`, validated
//! by DNS-01 through the DuckDNS TXT API — no inbound port besides the game port.
//!
//! Without it the certificate is for the public IP: the `shortlived` profile
//! (~6 days) validated on external TCP 80 (HTTP-01) or 443 (TLS-ALPN-01); no other
//! ports are accepted. HTTP-01 is tried first, then TLS-ALPN-01. During each attempt
//! a temporary UPnP mapping forwards the external port → `challenge_port`.

use crate::upnp::{self, UpnpMapping};
use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use instant_acme::{
    Account, AccountCredentials, AuthorizationStatus, ChallengeType, Identifier, LetsEncrypt,
    NewAccount, NewOrder, Order, OrderStatus, RetryPolicy,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tracing::{info, warn};

/// Let's Encrypt profile that allows IP identifiers.
pub const PROFILE: &str = "shortlived";
const RENEW_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 3600);
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(30 * 60);
const MIN_CHECK_DELAY: Duration = Duration::from_secs(60);
const ORDER_TIMEOUT: Duration = Duration::from_secs(120);
const IP_LOOKUP_URLS: [&str; 2] = ["https://api.ipify.org", "https://ipv4.icanhazip.com"];
const CERT_FILE: &str = "fullchain.pem";
const KEY_FILE: &str = "privkey.pem";
const ACCOUNT_FILE: &str = "account.json";
pub const DUCKDNS_API: &str = "https://www.duckdns.org";
const DUCKDNS_SUFFIX: &str = ".duckdns.org";
const DUCKDNS_IP_REFRESH: Duration = Duration::from_secs(5 * 60);
const DUCKDNS_ATTEMPTS: u32 = 4;
#[cfg(not(test))]
const DUCKDNS_RETRY_DELAY: Duration = Duration::from_secs(2);
#[cfg(test)]
const DUCKDNS_RETRY_DELAY: Duration = Duration::from_millis(10);
const DOH_URLS: [&str; 2] = ["https://dns.google/resolve", "https://cloudflare-dns.com/dns-query"];
const TXT_PROPAGATION_TIMEOUT: Duration = Duration::from_secs(120);
const TXT_POLL_INTERVAL: Duration = Duration::from_secs(4);
/// Extra settle time after the TXT is visible, for Let's Encrypt's other vantage points.
const TXT_SETTLE: Duration = Duration::from_secs(10);

/// What the certificate is issued for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CertHost {
    Ip(IpAddr),
    Dns(String),
}

impl CertHost {
    fn dir_name(&self) -> String {
        match self {
            CertHost::Ip(ip) => ip.to_string().replace(':', "_"),
            CertHost::Dns(name) => name.clone(),
        }
    }

    fn identifier(&self) -> Identifier {
        match self {
            CertHost::Ip(ip) => Identifier::Ip(*ip),
            CertHost::Dns(name) => Identifier::Dns(name.clone()),
        }
    }

    /// Host part of a URL (IPv6 in brackets).
    pub fn url_host(&self) -> String {
        match self {
            CertHost::Ip(IpAddr::V6(ip)) => format!("[{ip}]"),
            CertHost::Ip(ip) => ip.to_string(),
            CertHost::Dns(name) => name.clone(),
        }
    }
}

impl std::fmt::Display for CertHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CertHost::Ip(ip) => write!(f, "{ip}"),
            CertHost::Dns(name) => f.write_str(name),
        }
    }
}

/// DuckDNS subdomain + account token (the token is never logged or formatted).
#[derive(Clone)]
pub struct DuckDns {
    /// Label only, e.g. `yarmiplay` for `yarmiplay.duckdns.org`.
    pub subdomain: String,
    pub token: String,
}

impl std::fmt::Debug for DuckDns {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DuckDns")
            .field("subdomain", &self.subdomain)
            .field("token", &"<redacted>")
            .finish()
    }
}

impl DuckDns {
    /// Accepts `yarmiplay` or `yarmiplay.duckdns.org`.
    pub fn new(domain: &str, token: &str) -> Result<Self, String> {
        let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
        let subdomain = domain.strip_suffix(DUCKDNS_SUFFIX).unwrap_or(&domain).to_string();
        let valid = !subdomain.is_empty()
            && subdomain.len() <= 63
            && !subdomain.starts_with('-')
            && !subdomain.ends_with('-')
            && subdomain.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid {
            return Err(format!("invalid DuckDNS domain {domain:?} (expected e.g. yarmiplay or yarmiplay.duckdns.org)"));
        }
        let token = token.trim();
        if token.is_empty() {
            return Err("DuckDNS token is empty".into());
        }
        Ok(Self { subdomain, token: token.to_string() })
    }

    pub fn fqdn(&self) -> String {
        format!("{}{DUCKDNS_SUFFIX}", self.subdomain)
    }
}

#[derive(Debug, Clone)]
pub struct AcmeOptions {
    /// Fixed public IP; `None` = detect (UPnP external IP, then HTTPS lookup).
    pub ip: Option<IpAddr>,
    pub dir: PathBuf,
    /// Local port that receives the forwarded validation connections.
    pub challenge_port: u16,
    pub staging: bool,
    pub email: Option<String>,
    /// Open/close the external 80/443 → `challenge_port` forward via UPnP.
    pub use_upnp: bool,
    /// Custom ACME directory (e.g. Pebble) instead of Let's Encrypt.
    pub directory: Option<String>,
    /// Extra trusted root for a custom directory's HTTPS endpoint.
    pub directory_root_ca: Option<PathBuf>,
    /// Issue for `<subdomain>.duckdns.org` via DNS-01 instead of the public IP.
    pub duckdns: Option<DuckDns>,
    /// DuckDNS API base URL override (tests); `None` = [`DUCKDNS_API`].
    pub duckdns_api: Option<String>,
}

impl AcmeOptions {
    fn root(&self) -> PathBuf {
        if self.staging {
            self.dir.join("staging")
        } else {
            self.dir.clone()
        }
    }

    fn cert_dir(&self, host: &CertHost) -> PathBuf {
        self.root().join(host.dir_name())
    }

    fn duckdns_api(&self) -> &str {
        self.duckdns_api.as_deref().unwrap_or(DUCKDNS_API)
    }

    fn directory_url(&self) -> String {
        match &self.directory {
            Some(url) => url.clone(),
            None if self.staging => LetsEncrypt::Staging.url().to_owned(),
            None => LetsEncrypt::Production.url().to_owned(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct IssuedCert {
    pub host: CertHost,
    pub cert_pem: String,
    pub key_pem: String,
    /// Unix seconds.
    pub not_before: i64,
    pub not_after: i64,
}

impl IssuedCert {
    pub fn needs_renewal(&self, now: i64) -> bool {
        needs_renewal(self.not_before, self.not_after, now)
    }

    pub fn wss_url(&self, port: u16) -> String {
        format!("wss://{}:{port}/ws", self.host.url_host())
    }
}

/// Renew once half of the certificate lifetime has elapsed.
pub fn needs_renewal(not_before: i64, not_after: i64, now: i64) -> bool {
    if not_after <= not_before {
        return true;
    }
    now >= renew_at(not_before, not_after)
}

fn renew_at(not_before: i64, not_after: i64) -> i64 {
    not_before + (not_after - not_before) / 2
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Let's Encrypt only validates globally reachable addresses.
pub fn check_public_ip(ip: IpAddr) -> Result<(), String> {
    let bad = match ip {
        IpAddr::V4(v4) => {
            upnp::is_private_or_cgnat(v4)
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4 == Ipv4Addr::LOCALHOST
        }
        IpAddr::V6(v6) => {
            let seg0 = v6.segments()[0];
            v6.is_unspecified()
                || v6 == Ipv6Addr::LOCALHOST
                || v6.is_multicast()
                || (seg0 & 0xfe00) == 0xfc00
                || (seg0 & 0xffc0) == 0xfe80
        }
    };
    if bad {
        return Err(format!(
            "{ip} is not a public internet address — if this is your router's WAN IP, your ISP uses CGNAT/double NAT and an IP certificate cannot be issued"
        ));
    }
    Ok(())
}

/// Public IP: explicit option, else router WAN IP via UPnP, else HTTPS lookup.
pub async fn resolve_public_ip(opts: &AcmeOptions) -> Result<IpAddr, String> {
    if let Some(ip) = opts.ip {
        check_public_ip(ip)?;
        return Ok(ip);
    }
    if opts.use_upnp {
        match upnp::discover_gateway().await {
            Ok(gw) => match upnp::external_ip(&gw).await {
                Ok(ip) => {
                    // A private WAN address means port 80 can never reach us.
                    check_public_ip(ip)?;
                    return Ok(ip);
                }
                Err(e) => warn!(error = %e, event = "acme_upnp_external_ip_failed"),
            },
            Err(e) => warn!(error = %e, event = "acme_upnp_gateway_failed"),
        }
    }
    let ip = lookup_public_ip_https().await?;
    check_public_ip(ip)?;
    Ok(ip)
}

async fn lookup_public_ip_https() -> Result<IpAddr, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("IP lookup client: {e}"))?;
    let mut errors = Vec::new();
    for url in IP_LOOKUP_URLS {
        match client.get(url).send().await {
            Ok(res) if res.status().is_success() => match res.text().await {
                Ok(body) => match body.trim().parse::<IpAddr>() {
                    Ok(ip) => return Ok(ip),
                    Err(_) => errors.push(format!("{url}: unexpected body {:?}", body.trim())),
                },
                Err(e) => errors.push(format!("{url}: {e}")),
            },
            Ok(res) => errors.push(format!("{url}: HTTP {}", res.status())),
            Err(e) => errors.push(format!("{url}: {e}")),
        }
    }
    Err(format!("could not determine public IP ({})", errors.join("; ")))
}

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP client: {e}"))
}

/// DuckDNS `/update` with retries on network errors and 5xx. Errors never include the
/// request URL (it holds the token).
async fn duckdns_update(api: &str, duck: &DuckDns, extra: &[(&str, &str)]) -> Result<String, String> {
    let mut delay = DUCKDNS_RETRY_DELAY;
    for attempt in 1..=DUCKDNS_ATTEMPTS {
        match duckdns_update_once(api, duck, extra).await {
            Ok(body) => return Ok(body),
            Err((e, true)) if attempt < DUCKDNS_ATTEMPTS => {
                warn!(error = %e, attempt, event = "duckdns_retry");
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err((e, _)) => return Err(e),
        }
    }
    unreachable!("DUCKDNS_ATTEMPTS is at least 1")
}

/// One `/update` call; the flag marks transient failures worth retrying.
async fn duckdns_update_once(
    api: &str,
    duck: &DuckDns,
    extra: &[(&str, &str)],
) -> Result<String, (String, bool)> {
    let client = http_client(Duration::from_secs(15)).map_err(|e| (e, false))?;
    let mut query: Vec<(&str, &str)> = vec![("domains", &duck.subdomain), ("token", &duck.token)];
    query.extend_from_slice(extra);
    query.push(("verbose", "true"));
    let res = client
        .get(format!("{}/update", api.trim_end_matches('/')))
        .query(&query)
        .send()
        .await
        .map_err(|e| (format!("DuckDNS request failed: {}", e.without_url()), true))?;
    let status = res.status();
    let body = res
        .text()
        .await
        .map_err(|e| (format!("DuckDNS response: {}", e.without_url()), true))?;
    if !status.is_success() {
        return Err((format!("DuckDNS HTTP {status}"), status.is_server_error()));
    }
    if body.trim_start().starts_with("OK") {
        Ok(body)
    } else {
        Err((
            format!(
                "DuckDNS rejected the update for {} (KO) — check that the token belongs to the account that owns this domain",
                duck.fqdn()
            ),
            false,
        ))
    }
}

/// Point `<subdomain>.duckdns.org` at `ip` (`None` = DuckDNS uses the caller's IPv4).
pub async fn duckdns_set_ip(api: &str, duck: &DuckDns, ip: Option<IpAddr>) -> Result<(), String> {
    let ip = ip.map(|ip| ip.to_string());
    let extra: Vec<(&str, &str)> = ip.as_deref().map(|ip| ("ip", ip)).into_iter().collect();
    let body = duckdns_update(api, duck, &extra).await?;
    if body.contains("UPDATED") {
        info!(domain = %duck.fqdn(), ip = ?ip, event = "duckdns_ip_updated");
    }
    Ok(())
}

pub async fn duckdns_set_txt(api: &str, duck: &DuckDns, value: &str) -> Result<(), String> {
    duckdns_update(api, duck, &[("txt", value)]).await.map(|_| ())
}

pub async fn duckdns_clear_txt(api: &str, duck: &DuckDns) -> Result<(), String> {
    duckdns_update(api, duck, &[("txt", "cleared"), ("clear", "true")]).await.map(|_| ())
}

/// TXT strings from a DNS-over-HTTPS JSON answer (quotes and chunking removed).
fn doh_txt_values(json: &serde_json::Value) -> Vec<String> {
    json.get("Answer")
        .and_then(|a| a.as_array())
        .map(|answers| {
            answers
                .iter()
                .filter(|a| a.get("type").and_then(|t| t.as_u64()) == Some(16))
                .filter_map(|a| a.get("data").and_then(|d| d.as_str()))
                .map(|d| d.split('"').enumerate().filter(|(i, _)| i % 2 == 1).map(|(_, s)| s).collect::<String>())
                .map(|joined| joined.trim().to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// Wait until public resolvers return `value` for `name`, so Let's Encrypt will too.
async fn wait_for_txt(name: &str, value: &str) -> Result<(), String> {
    let client = http_client(Duration::from_secs(10))?;
    let deadline = tokio::time::Instant::now() + TXT_PROPAGATION_TIMEOUT;
    loop {
        for url in DOH_URLS {
            let res = client
                .get(url)
                .query(&[("name", name), ("type", "TXT")])
                .header("accept", "application/dns-json")
                .send()
                .await;
            let Ok(res) = res else { continue };
            let Ok(json) = res.json::<serde_json::Value>().await else { continue };
            if doh_txt_values(&json).iter().any(|v| v == value) {
                info!(%name, resolver = url, event = "acme_dns_txt_visible");
                tokio::time::sleep(TXT_SETTLE).await;
                return Ok(());
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(format!(
                "TXT record for {name} did not appear in public DNS within {}s — DuckDNS may be slow or down; try again later",
                TXT_PROPAGATION_TIMEOUT.as_secs()
            ));
        }
        tokio::time::sleep(TXT_POLL_INTERVAL).await;
    }
}

/// Certificate subject: the DuckDNS name (after pointing it at our public IP), else the public IP.
pub async fn resolve_host(opts: &AcmeOptions) -> Result<CertHost, String> {
    let Some(duck) = &opts.duckdns else {
        return Ok(CertHost::Ip(resolve_public_ip(opts).await?));
    };
    let ip = match resolve_public_ip(opts).await {
        Ok(ip) => Some(ip),
        Err(e) => {
            warn!(error = %e, event = "duckdns_ip_detect_failed_using_autodetect");
            None
        }
    };
    // The name is fixed, so a DuckDNS outage must not block serving a cached cert;
    // the periodic refresh re-points the A record once DuckDNS answers again.
    if let Err(e) = duckdns_set_ip(opts.duckdns_api(), duck, ip).await {
        warn!(error = %e, event = "duckdns_ip_update_failed");
    }
    Ok(CertHost::Dns(duck.fqdn()))
}

/// Keeps the DuckDNS A record on the current public IP between renewals.
fn spawn_duckdns_ip_refresh(opts: AcmeOptions) {
    let Some(duck) = opts.duckdns.clone() else { return };
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(DUCKDNS_IP_REFRESH).await;
            if let Err(e) = duckdns_set_ip(opts.duckdns_api(), &duck, None).await {
                warn!(error = %e, event = "duckdns_ip_refresh_failed");
            }
        }
    });
}

/// Parse a PEM chain; the leaf must carry `expected` as an IP or DNS SAN.
pub fn parse_cert(cert_pem: &str, key_pem: &str, expected: &CertHost) -> Result<IssuedCert, String> {
    let (_, pem) = x509_parser::pem::parse_x509_pem(cert_pem.as_bytes())
        .map_err(|e| format!("certificate PEM: {e}"))?;
    let cert = pem
        .parse_x509()
        .map_err(|e| format!("certificate DER: {e}"))?;
    let covers = cert
        .subject_alternative_name()
        .ok()
        .flatten()
        .is_some_and(|san| {
            san.value.general_names.iter().any(|name| match (name, expected) {
                (x509_parser::extensions::GeneralName::IPAddress(bytes), CertHost::Ip(ip)) => {
                    ip_from_bytes(bytes) == Some(*ip)
                }
                (x509_parser::extensions::GeneralName::DNSName(dns), CertHost::Dns(want)) => {
                    dns.eq_ignore_ascii_case(want)
                }
                _ => false,
            })
        });
    if !covers {
        return Err(format!("certificate does not cover {expected}"));
    }
    if !key_pem.contains("PRIVATE KEY") {
        return Err("private key PEM missing".into());
    }
    Ok(IssuedCert {
        host: expected.clone(),
        cert_pem: cert_pem.to_string(),
        key_pem: key_pem.to_string(),
        not_before: cert.validity().not_before.timestamp(),
        not_after: cert.validity().not_after.timestamp(),
    })
}

fn ip_from_bytes(bytes: &[u8]) -> Option<IpAddr> {
    match bytes.len() {
        4 => Some(IpAddr::V4(Ipv4Addr::new(bytes[0], bytes[1], bytes[2], bytes[3]))),
        16 => {
            let arr: [u8; 16] = bytes.try_into().ok()?;
            Some(IpAddr::V6(Ipv6Addr::from(arr)))
        }
        _ => None,
    }
}

fn load_cached(opts: &AcmeOptions, host: &CertHost) -> Option<IssuedCert> {
    let dir = opts.cert_dir(host);
    let cert = std::fs::read_to_string(dir.join(CERT_FILE)).ok()?;
    let key = std::fs::read_to_string(dir.join(KEY_FILE)).ok()?;
    match parse_cert(&cert, &key, host) {
        Ok(c) => Some(c),
        Err(e) => {
            warn!(dir = %dir.display(), error = %e, event = "acme_cache_invalid");
            None
        }
    }
}

fn save_cert(opts: &AcmeOptions, host: &CertHost, cert_pem: &str, key_pem: &str) -> Result<(), String> {
    let dir = opts.cert_dir(host);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    write_atomic(&dir.join(KEY_FILE), key_pem)?;
    write_atomic(&dir.join(CERT_FILE), cert_pem)
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("rename to {}: {e}", path.display()))
}

async fn load_or_create_account(opts: &AcmeOptions) -> Result<Account, String> {
    let root = opts.root();
    let path = root.join(ACCOUNT_FILE);
    let builder = || {
        match &opts.directory_root_ca {
            Some(ca) => Account::builder_with_root(ca),
            None => Account::builder(),
        }
        .map_err(|e| format!("ACME HTTP client: {e}"))
    };

    if let Ok(raw) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<AccountCredentials>(&raw) {
            Ok(creds) => {
                return builder()?
                    .from_credentials(creds)
                    .await
                    .map_err(|e| format!("restore ACME account {}: {e}", path.display()));
            }
            Err(e) => warn!(path = %path.display(), error = %e, event = "acme_account_unreadable"),
        }
    }

    let contact = opts.email.as_ref().map(|e| format!("mailto:{e}"));
    let contacts: Vec<&str> = contact.iter().map(String::as_str).collect();
    let (account, creds) = builder()?
        .create(
            &NewAccount {
                contact: &contacts,
                terms_of_service_agreed: true,
                only_return_existing: false,
            },
            opts.directory_url(),
            None,
        )
        .await
        .map_err(|e| format!("create ACME account: {e}"))?;
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let json = serde_json::to_string_pretty(&creds).map_err(|e| e.to_string())?;
    write_atomic(&path, &json)?;
    info!(path = %path.display(), staging = opts.staging, event = "acme_account_created");
    Ok(account)
}

/// token → key authorization for HTTP-01.
pub type ChallengeTokens = Arc<Mutex<HashMap<String, String>>>;

/// Serves `GET /.well-known/acme-challenge/{token}`.
pub fn challenge_router(tokens: ChallengeTokens) -> Router {
    Router::new()
        .route("/.well-known/acme-challenge/{token}", get(serve_challenge))
        .with_state(tokens)
}

async fn serve_challenge(
    State(tokens): State<ChallengeTokens>,
    UrlPath(token): UrlPath<String>,
) -> (StatusCode, String) {
    let found = tokens.lock().get(&token).cloned();
    match found {
        Some(key_auth) => {
            info!(event = "acme_challenge_served");
            (StatusCode::OK, key_auth)
        }
        None => (StatusCode::NOT_FOUND, String::new()),
    }
}

/// ACME validation methods: HTTP-01 / TLS-ALPN-01 (the only two allowed for IPs)
/// and DNS-01 (names only, via the DuckDNS TXT API).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Validation {
    /// HTTP-01: plain HTTP on external TCP 80.
    Http01,
    /// TLS-ALPN-01: TLS handshake with ALPN `acme-tls/1` on external TCP 443.
    TlsAlpn01,
    /// DNS-01: TXT record at `_acme-challenge.<name>`; no inbound connection.
    Dns01,
}

impl Validation {
    pub fn external_port(self) -> Option<u16> {
        match self {
            Validation::Http01 => Some(80),
            Validation::TlsAlpn01 => Some(443),
            Validation::Dns01 => None,
        }
    }

    fn challenge_type(self) -> ChallengeType {
        match self {
            Validation::Http01 => ChallengeType::Http01,
            Validation::TlsAlpn01 => ChallengeType::TlsAlpn01,
            Validation::Dns01 => ChallengeType::Dns01,
        }
    }
}

/// ALPN protocol id for TLS-ALPN-01 (RFC 8737).
pub const ACME_TLS_ALPN: &[u8] = b"acme-tls/1";

type AlpnSlot = Arc<Mutex<Option<Arc<rustls::ServerConfig>>>>;

/// Self-signed validation certificate: IP SAN plus the critical acmeIdentifier
/// extension carrying SHA-256(key authorization); offered only for `acme-tls/1`.
pub fn tls_alpn_config(ip: IpAddr, key_auth_digest: &[u8]) -> Result<Arc<rustls::ServerConfig>, String> {
    let mut params = rcgen::CertificateParams::new(vec![ip.to_string()])
        .map_err(|e| format!("TLS-ALPN cert params: {e}"))?;
    params.custom_extensions = vec![rcgen::CustomExtension::new_acme_identifier(key_auth_digest)];
    let key = rcgen::KeyPair::generate().map_err(|e| format!("TLS-ALPN key: {e}"))?;
    let cert = params.self_signed(&key).map_err(|e| format!("TLS-ALPN cert: {e}"))?;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let signing_key = provider
        .key_provider
        .load_private_key(rustls::pki_types::PrivateKeyDer::Pkcs8(key.serialize_der().into()))
        .map_err(|e| format!("TLS-ALPN signing key: {e}"))?;
    // `with_single_cert` parses the cert and rejects the unknown critical acmeIdentifier extension.
    let certified = rustls::sign::CertifiedKey::new(vec![cert.der().clone()], signing_key);
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS-ALPN protocols: {e}"))?
        .with_no_client_auth()
        .with_cert_resolver(Arc::new(rustls::sign::SingleCertAndKey::from(certified)));
    config.alpn_protocols = vec![ACME_TLS_ALPN.to_vec()];
    Ok(Arc::new(config))
}

/// Accepts connections until `stop` fires, completing the TLS handshake with
/// the current validation certificate (that handshake is the whole check).
async fn serve_tls_alpn(listener: tokio::net::TcpListener, slot: AlpnSlot, mut stop: oneshot::Receiver<()>) {
    loop {
        tokio::select! {
            _ = &mut stop => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let Some(config) = slot.lock().clone() else { continue };
                tokio::spawn(async move {
                    let acceptor = tokio_rustls::TlsAcceptor::from(config);
                    match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await {
                        Ok(Ok(_)) => info!(%peer, event = "acme_tls_alpn_served"),
                        Ok(Err(e)) => warn!(%peer, error = %e, event = "acme_tls_alpn_handshake_failed"),
                        Err(_) => warn!(%peer, event = "acme_tls_alpn_handshake_timeout"),
                    }
                });
            }
        }
    }
}

fn reachability_hint(host: &CertHost, opts: &AcmeOptions, method: Validation) -> String {
    let Some(ext) = method.external_port() else {
        return format!(
            "Let's Encrypt must see the TXT record _acme-challenge.{host} set through DuckDNS. Check the DuckDNS token and that DuckDNS is up."
        );
    };
    let forward = if opts.use_upnp {
        format!("the UPnP forward of external TCP {ext} → local {}", opts.challenge_port)
    } else {
        format!("a manual router forward of external TCP {ext} → this PC's port {}", opts.challenge_port)
    };
    let target = match method {
        Validation::Http01 => format!("http://{}/.well-known/acme-challenge/", host.url_host()),
        _ => format!("{}:{ext} (TLS)", host.url_host()),
    };
    format!(
        "Let's Encrypt must reach {target} via {forward}. Likely causes: ISP blocks inbound port {ext}, the router keeps port {ext} for itself, UPnP disabled, or CGNAT."
    )
}

/// DuckDNS names use DNS-01. IPs try HTTP-01 on port 80, then TLS-ALPN-01 on 443.
async fn issue(opts: &AcmeOptions, host: &CertHost) -> Result<(String, String), String> {
    let account = load_or_create_account(opts).await?;
    if let CertHost::Dns(_) = host {
        return issue_with(&account, opts, host, Validation::Dns01).await;
    }
    let http_err = match issue_with(&account, opts, host, Validation::Http01).await {
        Ok(issued) => return Ok(issued),
        Err(e) => e,
    };
    warn!(error = %http_err, event = "acme_http01_failed");
    eprintln!("ACME: port 80 check failed — retrying on port 443 (TLS-ALPN-01)…");
    issue_with(&account, opts, host, Validation::TlsAlpn01)
        .await
        .map_err(|tls_err| format!("port 80: {http_err} | port 443: {tls_err}"))
}

async fn issue_with(
    account: &Account,
    opts: &AcmeOptions,
    host: &CertHost,
    method: Validation,
) -> Result<(String, String), String> {
    let identifiers = [host.identifier()];
    let mut new_order = NewOrder::new(&identifiers);
    if let CertHost::Ip(_) = host {
        new_order = new_order.profile(PROFILE);
    }
    let mut order = account
        .new_order(&new_order)
        .await
        .map_err(|e| format!("new order for {host}: {e}"))?;

    let tokens: ChallengeTokens = Arc::default();
    let alpn: AlpnSlot = Arc::default();

    let Some(ext) = method.external_port() else {
        let duck = opts
            .duckdns
            .as_ref()
            .ok_or_else(|| format!("DNS-01 for {host} needs DuckDNS settings"))?;
        info!(%host, ?method, staging = opts.staging, event = "acme_order_started");
        let result = drive_order(&mut order, method, &tokens, &alpn, host, opts).await;
        if let Err(e) = duckdns_clear_txt(opts.duckdns_api(), duck).await {
            warn!(error = %e, event = "duckdns_txt_clear_failed");
        }
        return result;
    };

    let bind = SocketAddr::from(([0, 0, 0, 0], opts.challenge_port));
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .map_err(|e| format!("bind ACME challenge port {bind}: {e}"))?;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let server = match method {
        Validation::Http01 => {
            let serve = axum::serve(listener, challenge_router(tokens.clone())).with_graceful_shutdown(async {
                let _ = stop_rx.await;
            });
            tokio::spawn(async move {
                let _ = serve.await;
            })
        }
        _ => tokio::spawn(serve_tls_alpn(listener, alpn.clone(), stop_rx)),
    };

    let mut mapping = None;
    if opts.use_upnp {
        match UpnpMapping::open_forward_exclusive(ext, opts.challenge_port).await {
            Ok((m, _)) => mapping = Some(m),
            Err(e) => {
                let _ = stop_tx.send(());
                let _ = server.await;
                return Err(format!(
                    "UPnP could not forward external TCP {ext} → {}: {e}",
                    opts.challenge_port
                ));
            }
        }
    }
    info!(%host, ?method, external_port = ext, challenge_port = opts.challenge_port, staging = opts.staging, event = "acme_order_started");

    let result = drive_order(&mut order, method, &tokens, &alpn, host, opts).await;

    if let Some(m) = mapping.as_mut() {
        m.close().await;
    }
    let _ = stop_tx.send(());
    let _ = server.await;
    result
}

async fn drive_order(
    order: &mut Order,
    method: Validation,
    tokens: &ChallengeTokens,
    alpn: &AlpnSlot,
    host: &CertHost,
    opts: &AcmeOptions,
) -> Result<(String, String), String> {
    {
        let mut authorizations = order.authorizations();
        while let Some(result) = authorizations.next().await {
            let mut authz = result.map_err(|e| format!("fetch authorization: {e}"))?;
            match authz.status {
                AuthorizationStatus::Pending => {}
                AuthorizationStatus::Valid => continue,
                other => return Err(format!("authorization for {host} is {other:?}")),
            }
            let mut challenge = authz
                .challenge(method.challenge_type())
                .ok_or_else(|| format!("no {method:?} challenge offered for {host}"))?;
            let key_auth = challenge.key_authorization();
            match (method, host) {
                (Validation::Http01, _) => {
                    tokens
                        .lock()
                        .insert(challenge.token.clone(), key_auth.as_str().to_string());
                }
                (Validation::TlsAlpn01, CertHost::Ip(ip)) => {
                    *alpn.lock() = Some(tls_alpn_config(*ip, key_auth.digest().as_ref())?);
                }
                (Validation::TlsAlpn01, CertHost::Dns(_)) => {
                    return Err("TLS-ALPN-01 is only wired up for IP certificates".into());
                }
                (Validation::Dns01, _) => {
                    let duck = opts
                        .duckdns
                        .as_ref()
                        .ok_or_else(|| format!("DNS-01 for {host} needs DuckDNS settings"))?;
                    let value = key_auth.dns_value();
                    duckdns_set_txt(opts.duckdns_api(), duck, &value).await?;
                    info!(%host, event = "duckdns_txt_set");
                    wait_for_txt(&format!("_acme-challenge.{host}"), &value).await?;
                }
            }
            challenge
                .set_ready()
                .await
                .map_err(|e| format!("challenge ready: {e}"))?;
        }
    }

    let policy = RetryPolicy::new().timeout(ORDER_TIMEOUT);
    let status = order
        .poll_ready(&policy)
        .await
        .map_err(|e| format!("validation failed: {e}. {}", reachability_hint(host, opts, method)))?;
    if status != OrderStatus::Ready {
        let detail = challenge_errors(order).await;
        return Err(format!(
            "validation failed ({status:?}){detail}. {}",
            reachability_hint(host, opts, method)
        ));
    }

    let key_pem = order
        .finalize()
        .await
        .map_err(|e| format!("finalize: {e}"))?;
    let cert_pem = order
        .poll_certificate(&policy)
        .await
        .map_err(|e| format!("download certificate: {e}"))?;
    Ok((cert_pem, key_pem))
}

async fn challenge_errors(order: &mut Order) -> String {
    let mut details = Vec::new();
    let mut authorizations = order.authorizations();
    while let Some(Ok(mut authz)) = authorizations.next().await {
        if let Ok(state) = authz.refresh().await {
            details.extend(
                state
                    .challenges
                    .iter()
                    .filter_map(|c| c.error.as_ref().map(|p| p.to_string())),
            );
        }
    }
    if details.is_empty() {
        String::new()
    } else {
        format!(": {}", details.join("; "))
    }
}

/// Resolve the certificate host, then reuse a cached certificate or issue a new one.
pub async fn load_or_issue(opts: &AcmeOptions) -> Result<IssuedCert, String> {
    let host = resolve_host(opts).await?;
    load_or_issue_for(opts, &host).await
}

async fn load_or_issue_for(opts: &AcmeOptions, host: &CertHost) -> Result<IssuedCert, String> {
    let now = unix_now();
    let cached = load_cached(opts, host);
    if let Some(c) = &cached {
        if !c.needs_renewal(now) {
            info!(%host, not_after = c.not_after, event = "acme_cert_cached");
            return Ok(c.clone());
        }
    }
    match issue(opts, host).await {
        Ok((cert_pem, key_pem)) => {
            let issued = parse_cert(&cert_pem, &key_pem, host)?;
            save_cert(opts, host, &cert_pem, &key_pem)?;
            info!(%host, not_after = issued.not_after, staging = opts.staging, event = "acme_cert_issued");
            Ok(issued)
        }
        Err(e) => match cached {
            Some(c) if now < c.not_after => {
                warn!(%host, error = %e, not_after = c.not_after, event = "acme_renew_failed_keeping_cached");
                Ok(c)
            }
            _ => Err(e),
        },
    }
}

fn next_check_delay(cert: &IssuedCert, now: i64, failed: bool) -> Duration {
    if failed {
        return RETRY_AFTER_FAILURE;
    }
    let until_renew = renew_at(cert.not_before, cert.not_after).saturating_sub(now).max(0) as u64;
    Duration::from_secs(until_renew)
        .clamp(MIN_CHECK_DELAY, RENEW_CHECK_INTERVAL)
}

/// Background renewal: reissues at half-life or when the certificate host changes
/// (public IP mode), then hot-swaps the served certificate via `reload_from_pem`.
/// In DuckDNS mode the A record is also kept on the current public IP.
pub fn spawn_renewal(opts: AcmeOptions, config: RustlsConfig, mut current: IssuedCert, port: u16) -> JoinHandle<()> {
    spawn_duckdns_ip_refresh(opts.clone());
    tokio::spawn(async move {
        let mut failed = false;
        loop {
            tokio::time::sleep(next_check_delay(&current, unix_now(), failed)).await;
            let host = match resolve_host(&opts).await {
                Ok(host) => host,
                Err(e) => {
                    warn!(error = %e, event = "acme_renew_host_failed");
                    failed = true;
                    continue;
                }
            };
            if host == current.host && !current.needs_renewal(unix_now()) {
                failed = false;
                continue;
            }
            match load_or_issue_for(&opts, &host).await {
                Ok(next) if next.cert_pem != current.cert_pem => {
                    if let Err(e) = config
                        .reload_from_pem(next.cert_pem.clone().into_bytes(), next.key_pem.clone().into_bytes())
                        .await
                    {
                        warn!(error = %e, event = "acme_reload_failed");
                        failed = true;
                        continue;
                    }
                    let url = next.wss_url(port);
                    info!(%url, not_after = next.not_after, event = "acme_renewed");
                    if next.host != current.host {
                        warn!(old = %current.host, new = %next.host, event = "acme_host_changed");
                        eprintln!("Public join URL: {url}");
                    }
                    current = next;
                    failed = false;
                }
                Ok(_) => failed = true,
                Err(e) => {
                    warn!(error = %e, event = "acme_renew_failed");
                    failed = true;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    fn opts(dir: &Path) -> AcmeOptions {
        AcmeOptions {
            ip: None,
            dir: dir.to_path_buf(),
            challenge_port: 0,
            staging: true,
            email: None,
            use_upnp: false,
            directory: None,
            directory_root_ca: None,
            duckdns: None,
            duckdns_api: None,
        }
    }

    fn ip_host(s: &str) -> CertHost {
        CertHost::Ip(s.parse().unwrap())
    }

    fn self_signed(host: &CertHost, not_before: (i32, u8, u8), not_after: (i32, u8, u8)) -> (String, String) {
        let mut params = rcgen::CertificateParams::new(vec![host.to_string()]).unwrap();
        params.not_before = rcgen::date_time_ymd(not_before.0, not_before.1, not_before.2);
        params.not_after = rcgen::date_time_ymd(not_after.0, not_after.1, not_after.2);
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = params.self_signed(&key).unwrap();
        (cert.pem(), key.serialize_pem())
    }

    #[test]
    fn renewal_at_half_life() {
        let nb = 1_000_000;
        let na = nb + 6 * DAY;
        assert!(!needs_renewal(nb, na, nb));
        assert!(!needs_renewal(nb, na, nb + 3 * DAY - 1));
        assert!(needs_renewal(nb, na, nb + 3 * DAY));
        assert!(needs_renewal(nb, na, na + 1));
        assert!(needs_renewal(na, nb, nb), "inverted validity always renews");
    }

    #[test]
    fn next_check_delay_bounds() {
        let now = 10_000_000;
        let cert = IssuedCert {
            host: ip_host("8.8.8.8"),
            cert_pem: String::new(),
            key_pem: String::new(),
            not_before: now,
            not_after: now + 6 * DAY,
        };
        assert_eq!(next_check_delay(&cert, now, false), RENEW_CHECK_INTERVAL);
        assert_eq!(next_check_delay(&cert, now + 3 * DAY - 120, false), Duration::from_secs(120));
        assert_eq!(next_check_delay(&cert, now + 4 * DAY, false), MIN_CHECK_DELAY);
        assert_eq!(next_check_delay(&cert, now, true), RETRY_AFTER_FAILURE);
    }

    #[test]
    fn rejects_private_cgnat_and_local_ips() {
        for ip in ["10.0.0.1", "172.16.5.4", "192.168.1.9", "100.64.1.1", "127.0.0.1", "0.0.0.0", "169.254.1.1", "::1", "fd00::1", "fe80::1"] {
            assert!(check_public_ip(ip.parse().unwrap()).is_err(), "{ip} should be rejected");
        }
        let err = check_public_ip("100.100.0.1".parse().unwrap()).unwrap_err();
        assert!(err.contains("CGNAT"));
        for ip in ["203.0.113.10", "8.8.8.8", "2606:4700::1111"] {
            assert!(check_public_ip(ip.parse().unwrap()).is_ok(), "{ip} should be accepted");
        }
    }

    #[tokio::test]
    async fn explicit_ip_short_circuits_lookup() {
        let dir = std::env::temp_dir();
        let mut o = opts(&dir);
        o.ip = Some("8.8.4.4".parse().unwrap());
        assert_eq!(resolve_public_ip(&o).await.unwrap(), "8.8.4.4".parse::<IpAddr>().unwrap());
        o.ip = Some("192.168.1.2".parse().unwrap());
        assert!(resolve_public_ip(&o).await.is_err());
    }

    #[test]
    fn parse_cert_reads_validity_and_ip_san() {
        let ip = ip_host("203.0.113.10");
        let (cert, key) = self_signed(&ip, (2026, 9, 1), (2026, 9, 7));
        let parsed = parse_cert(&cert, &key, &ip).unwrap();
        assert_eq!(parsed.not_after - parsed.not_before, 6 * DAY);
        assert_eq!(parsed.wss_url(7777), "wss://203.0.113.10:7777/ws");
        assert!(parse_cert(&cert, &key, &ip_host("8.8.8.8")).is_err());
        assert!(parse_cert(&cert, &key, &CertHost::Dns("203.0.113.10".into())).is_err());
        assert!(parse_cert(&cert, "nope", &ip).is_err());
    }

    #[test]
    fn parse_cert_reads_dns_san() {
        let host = CertHost::Dns("yarmiplay.duckdns.org".into());
        let (cert, key) = self_signed(&host, (2026, 9, 1), (2026, 11, 30));
        let parsed = parse_cert(&cert, &key, &CertHost::Dns("YarmiPlay.duckdns.org".into())).unwrap();
        assert_eq!(parsed.wss_url(7777), "wss://YarmiPlay.duckdns.org:7777/ws");
        assert!(parse_cert(&cert, &key, &CertHost::Dns("other.duckdns.org".into())).is_err());
        assert!(parse_cert(&cert, &key, &ip_host("203.0.113.10")).is_err());
    }

    #[test]
    fn cache_roundtrip_and_renewal_choice() {
        let dir = std::env::temp_dir().join(format!("acme-test-{}", uuid::Uuid::new_v4()));
        let o = opts(&dir);
        let ip = ip_host("203.0.113.10");
        assert!(load_cached(&o, &ip).is_none());

        let (cert, key) = self_signed(&ip, (2026, 1, 1), (2099, 1, 1));
        save_cert(&o, &ip, &cert, &key).unwrap();
        assert!(dir.join("staging").join("203.0.113.10").join(CERT_FILE).is_file());
        let cached = load_cached(&o, &ip).unwrap();
        assert!(!cached.needs_renewal(unix_now()));
        // Cache is per-host: a new public IP has no cert yet.
        assert!(load_cached(&o, &ip_host("8.8.8.8")).is_none());

        let (old_cert, old_key) = self_signed(&ip, (2020, 1, 1), (2020, 1, 7));
        save_cert(&o, &ip, &old_cert, &old_key).unwrap();
        assert!(load_cached(&o, &ip).unwrap().needs_renewal(unix_now()));

        let name = CertHost::Dns("yarmiplay.duckdns.org".into());
        let (dns_cert, dns_key) = self_signed(&name, (2026, 1, 1), (2099, 1, 1));
        save_cert(&o, &name, &dns_cert, &dns_key).unwrap();
        assert!(dir.join("staging").join("yarmiplay.duckdns.org").join(CERT_FILE).is_file());
        assert_eq!(load_cached(&o, &name).unwrap().host, name);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ipv6_cache_dir_and_url() {
        let o = opts(Path::new("acme"));
        let ip = ip_host("2606:4700::1111");
        assert!(o.cert_dir(&ip).ends_with("2606_4700__1111"));
        let c = IssuedCert { host: ip, cert_pem: String::new(), key_pem: String::new(), not_before: 0, not_after: 1 };
        assert_eq!(c.wss_url(7777), "wss://[2606:4700::1111]:7777/ws");
    }

    /// Full order → finalize → serve → hot-reload against Pebble:
    /// `docker run -d --rm --name pebble -p 14000:14000 -p 15000:15000 -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_WFE_NONCEREJECT=0 ghcr.io/letsencrypt/pebble`
    /// then `PEBBLE_CA=<test/certs/pebble.minica.pem> cargo test pebble_ -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn pebble_issue_serve_and_reload() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let ca = PathBuf::from(std::env::var("PEBBLE_CA").expect("PEBBLE_CA=<pebble.minica.pem>"));
        let tmp = std::env::temp_dir().join(format!("acme-pebble-{}", uuid::Uuid::new_v4()));
        let mut o = opts(&tmp);
        o.staging = false;
        o.directory = Some(
            std::env::var("PEBBLE_DIRECTORY").unwrap_or_else(|_| "https://localhost:14000/dir".into()),
        );
        o.directory_root_ca = Some(ca.clone());
        let ip = ip_host("127.0.0.1");

        let first = load_or_issue_for(&o, &ip).await.expect("pebble issuance");
        let lifetime = first.not_after - first.not_before;
        assert!((6 * DAY - 120..=6 * DAY + 120).contains(&lifetime), "shortlived lifetime {lifetime}");
        assert!(tmp.join("127.0.0.1").join(CERT_FILE).is_file());
        assert!(tmp.join(ACCOUNT_FILE).is_file());
        let again = load_or_issue_for(&o, &ip).await.unwrap();
        assert_eq!(again.cert_pem, first.cert_pem, "fresh cert is reused from cache");

        let config = RustlsConfig::from_pem(first.cert_pem.clone().into_bytes(), first.key_pem.clone().into_bytes())
            .await
            .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = Router::new().route("/health", get(|| async { "ok" }));
        let server = axum_server::from_tcp_rustls(listener, config.clone());
        tokio::spawn(async move { server.serve(app.into_make_service()).await });

        let minica = reqwest::Certificate::from_pem(&std::fs::read(&ca).unwrap()).unwrap();
        let root_pem = reqwest::Client::builder()
            .add_root_certificate(minica)
            .no_proxy()
            .build()
            .unwrap()
            .get("https://localhost:15000/roots/0")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        let verify = || async {
            reqwest::Client::builder()
                .add_root_certificate(reqwest::Certificate::from_pem(root_pem.as_bytes()).unwrap())
                .tls_built_in_root_certs(false)
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("https://127.0.0.1:{port}/health"))
                .send()
                .await
                .expect("TLS handshake verifies against the issuing root")
                .text()
                .await
                .unwrap()
        };
        assert_eq!(verify().await, "ok");

        let (cert2, key2) = issue(&o, &ip).await.expect("second issuance");
        assert_ne!(cert2, first.cert_pem);
        config.reload_from_pem(cert2.into_bytes(), key2.into_bytes()).await.unwrap();
        assert_eq!(verify().await, "ok");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[derive(Debug)]
    struct AcceptAnyCert(Arc<rustls::crypto::CryptoProvider>);

    impl rustls::client::danger::ServerCertVerifier for AcceptAnyCert {
        fn verify_server_cert(
            &self,
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &[rustls::pki_types::CertificateDer<'_>],
            _: &rustls::pki_types::ServerName<'_>,
            _: &[u8],
            _: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }

        // webpki refuses to parse certs with the critical acmeIdentifier extension.
        fn verify_tls12_signature(
            &self,
            _: &[u8],
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _: &[u8],
            _: &rustls::pki_types::CertificateDer<'_>,
            _: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    #[tokio::test]
    async fn tls_alpn_responder_serves_acme_identifier_cert() {
        let ip: IpAddr = "203.0.113.10".parse().unwrap();
        let digest = [7u8; 32];
        let slot: AlpnSlot = Arc::new(Mutex::new(Some(tls_alpn_config(ip, &digest).unwrap())));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop_tx, stop_rx) = oneshot::channel();
        let server = tokio::spawn(serve_tls_alpn(listener, slot, stop_rx));

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let mut client = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert(provider)))
            .with_no_client_auth();
        client.alpn_protocols = vec![ACME_TLS_ALPN.to_vec()];
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let sni = rustls::pki_types::ServerName::try_from("10.113.0.203.in-addr.arpa").unwrap();
        let tls = tokio_rustls::TlsConnector::from(Arc::new(client))
            .connect(sni, stream)
            .await
            .expect("acme-tls/1 handshake");
        let (_, conn) = tls.get_ref();
        assert_eq!(conn.alpn_protocol(), Some(ACME_TLS_ALPN));
        let leaf = conn.peer_certificates().unwrap()[0].clone();
        let (_, cert) = x509_parser::parse_x509_certificate(leaf.as_ref()).unwrap();

        let acme_ext = cert
            .extensions()
            .iter()
            .find(|e| e.oid.to_id_string() == "1.3.6.1.5.5.7.1.31")
            .expect("acmeIdentifier extension");
        assert!(acme_ext.critical);
        assert!(acme_ext.value.ends_with(&digest));
        let san = cert.subject_alternative_name().unwrap().unwrap();
        assert!(san.value.general_names.iter().any(|n| matches!(
            n,
            x509_parser::extensions::GeneralName::IPAddress(b) if ip_from_bytes(b) == Some(ip)
        )));

        let _ = stop_tx.send(());
        server.await.unwrap();
    }

    const TEST_TOKEN: &str = "0000aaaa-token-secret-1111";

    /// Fake DuckDNS `/update`: records query strings, answers OK for `yarmiplay` + TEST_TOKEN.
    async fn fake_duckdns() -> (String, Arc<Mutex<Vec<HashMap<String, String>>>>) {
        let seen: Arc<Mutex<Vec<HashMap<String, String>>>> = Arc::default();
        let log = seen.clone();
        let app = Router::new().route(
            "/update",
            get(move |axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>| {
                let log = log.clone();
                async move {
                    let ok = q.get("domains").map(String::as_str) == Some("yarmiplay")
                        && q.get("token").map(String::as_str) == Some(TEST_TOKEN);
                    log.lock().push(q);
                    if ok { "OK\n203.0.113.10\n\nUPDATED" } else { "KO" }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    #[tokio::test]
    async fn duckdns_api_sets_ip_txt_and_clears() {
        let (api, seen) = fake_duckdns().await;
        let duck = DuckDns::new("yarmiplay.duckdns.org", TEST_TOKEN).unwrap();

        duckdns_set_ip(&api, &duck, Some("203.0.113.10".parse().unwrap())).await.unwrap();
        duckdns_set_ip(&api, &duck, None).await.unwrap();
        duckdns_set_txt(&api, &duck, "abc-DNS01-value").await.unwrap();
        duckdns_clear_txt(&api, &duck).await.unwrap();

        let calls = seen.lock().clone();
        assert_eq!(calls.len(), 4);
        assert_eq!(calls[0].get("ip").map(String::as_str), Some("203.0.113.10"));
        assert!(!calls[1].contains_key("ip"), "None lets DuckDNS auto-detect");
        assert_eq!(calls[2].get("txt").map(String::as_str), Some("abc-DNS01-value"));
        assert!(!calls[2].contains_key("clear"));
        assert_eq!(calls[3].get("clear").map(String::as_str), Some("true"));
        assert!(calls.iter().all(|q| q.get("domains").map(String::as_str) == Some("yarmiplay")));
    }

    #[tokio::test]
    async fn duckdns_ko_and_errors_never_leak_token() {
        let (api, _) = fake_duckdns().await;
        let wrong = DuckDns::new("yarmiplay", "wrong-token-value-9999").unwrap();
        let err = duckdns_set_txt(&api, &wrong, "v").await.unwrap_err();
        assert!(err.contains("KO") && err.contains("yarmiplay.duckdns.org"), "{err}");
        assert!(!err.contains("wrong-token-value-9999"));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let dead = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let duck = DuckDns::new("yarmiplay", TEST_TOKEN).unwrap();
        let err = duckdns_set_ip(&dead, &duck, None).await.unwrap_err();
        assert!(err.starts_with("DuckDNS request failed"), "{err}");
        assert!(!err.contains(TEST_TOKEN), "token leaked: {err}");

        let debug = format!("{:?}", AcmeOptions { duckdns: Some(duck), ..opts(Path::new("acme")) });
        assert!(!debug.contains(TEST_TOKEN) && debug.contains("<redacted>"));
    }

    #[tokio::test]
    async fn duckdns_retries_5xx_but_not_ko() {
        let hits = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counter = hits.clone();
        let app = Router::new().route(
            "/update",
            get(move |axum::extract::Query(q): axum::extract::Query<HashMap<String, String>>| {
                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                async move {
                    if q.get("token").map(String::as_str) != Some(TEST_TOKEN) {
                        (axum::http::StatusCode::OK, "KO")
                    } else if n < 2 {
                        (axum::http::StatusCode::BAD_GATEWAY, "")
                    } else {
                        (axum::http::StatusCode::OK, "OK")
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let duck = DuckDns::new("yarmiplay", TEST_TOKEN).unwrap();
        duckdns_set_ip(&api, &duck, None).await.unwrap();
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 3);

        hits.store(10, std::sync::atomic::Ordering::SeqCst);
        let wrong = DuckDns::new("yarmiplay", "wrong-token").unwrap();
        assert!(duckdns_set_ip(&api, &wrong, None).await.unwrap_err().contains("KO"));
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 11, "KO must not retry");
    }

    #[test]
    fn duckdns_domain_normalization() {
        for input in ["yarmiplay", "YarmiPlay.duckdns.org", " yarmiplay.duckdns.org. "] {
            let d = DuckDns::new(input, " t ").unwrap();
            assert_eq!(d.subdomain, "yarmiplay");
            assert_eq!(d.fqdn(), "yarmiplay.duckdns.org");
            assert_eq!(d.token, "t");
        }
        for bad in ["", ".duckdns.org", "bad name", "-x", "a.b"] {
            assert!(DuckDns::new(bad, "t").is_err(), "{bad:?} should be rejected");
        }
        assert!(DuckDns::new("yarmiplay", "  ").is_err());
    }

    #[test]
    fn doh_answer_parsing() {
        let json = serde_json::json!({
            "Status": 0,
            "Answer": [
                { "name": "_acme-challenge.yarmiplay.duckdns.org.", "type": 16, "TTL": 60, "data": "\"abc\" \"def\"" },
                { "name": "x", "type": 5, "data": "cname.example." },
                { "name": "y", "type": 16, "data": "\"other\"" }
            ]
        });
        assert_eq!(doh_txt_values(&json), vec!["abcdef".to_string(), "other".to_string()]);
        assert!(doh_txt_values(&serde_json::json!({ "Status": 3 })).is_empty());
    }

    #[test]
    fn dns_host_url_and_cache_dir() {
        let host = CertHost::Dns("yarmiplay.duckdns.org".into());
        let c = IssuedCert { host: host.clone(), cert_pem: String::new(), key_pem: String::new(), not_before: 0, not_after: 1 };
        assert_eq!(c.wss_url(7777), "wss://yarmiplay.duckdns.org:7777/ws");
        assert!(opts(Path::new("acme")).cert_dir(&host).ends_with("yarmiplay.duckdns.org"));
        assert!(matches!(host.identifier(), Identifier::Dns(ref n) if n == "yarmiplay.duckdns.org"));
    }

    #[test]
    fn validation_ports_are_the_only_two_lets_encrypt_allows() {
        assert_eq!(Validation::Http01.external_port(), Some(80));
        assert_eq!(Validation::TlsAlpn01.external_port(), Some(443));
        assert_eq!(Validation::Dns01.external_port(), None);
    }

    #[tokio::test]
    async fn challenge_route_serves_known_token_only() {
        let tokens: ChallengeTokens = Arc::default();
        tokens.lock().insert("tok123".into(), "tok123.thumb".into());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, challenge_router(tokens)).await.unwrap() });

        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let ok = client
            .get(format!("http://{addr}/.well-known/acme-challenge/tok123"))
            .send()
            .await
            .unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.text().await.unwrap(), "tok123.thumb");
        let missing = client
            .get(format!("http://{addr}/.well-known/acme-challenge/other"))
            .send()
            .await
            .unwrap();
        assert_eq!(missing.status(), 404);
        let root = client.get(format!("http://{addr}/")).send().await.unwrap();
        assert_eq!(root.status(), 404);
    }
}
