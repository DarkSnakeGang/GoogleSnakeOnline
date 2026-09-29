//! IGD / UPnP TCP port mapping for cross-internet play.
//!
//! Direct SSDP + SOAP, same flow as the Node UPnP server template: M-SEARCH is
//! sent from every LAN IPv4 adapter, the first gateway exposing
//! WANIPConnection (or WANPPPConnection) wins, and the adapter that heard the
//! reply is the mapping's internal client. Mappings are permanent (lease 0) and
//! always deleted on stop so a shut-down host does not leave the forward behind.

use socket2::{Domain, Protocol, Socket, Type};
use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinSet;
use tracing::{info, warn};

/// Fixed IGD mapping description shown in the router UI.
pub const MAPPING_DESCRIPTION: &str = "GoogleSnakeOnline";

const SSDP_MULTICAST: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_PORT: u16 = 1900;
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const HTTP_TIMEOUT: Duration = Duration::from_secs(5);
const SEARCH_TARGETS: [&str; 2] = [
    "ssdp:all",
    "urn:schemas-upnp-org:device:InternetGatewayDevice:1",
];

/// UPnP error codes (UPnP IGD WANIPConnection spec).
const ERR_ARRAY_INDEX_INVALID: u32 = 713;
const ERR_NO_SUCH_ENTRY: u32 = 714;
const ERR_CONFLICT_IN_MAPPING: u32 = 718;

#[derive(Debug, Error)]
pub enum UpnpError {
    #[error("UPnP SOAP fault {action}: {description} (code {})", code.map(|c| c.to_string()).unwrap_or_else(|| "?".into()))]
    Soap {
        action: String,
        code: Option<u32>,
        description: String,
    },
    #[error("{0}")]
    Other(String),
}

impl UpnpError {
    fn code(&self) -> Option<u32> {
        match self {
            UpnpError::Soap { code, .. } => *code,
            UpnpError::Other(_) => None,
        }
    }
}

/// Resolved IGD WAN connection service plus the LAN adapter that reached it.
#[derive(Debug, Clone)]
pub struct Gateway {
    pub location: String,
    pub control_url: String,
    pub service_type: String,
    pub local_ip: Ipv4Addr,
}

/// Active TCP port forward owned by the game process.
pub struct UpnpMapping {
    external_port: u16,
    gateway: Option<Gateway>,
}

impl UpnpMapping {
    /// Discover the gateway and map TCP `port`→`port` to this machine.
    /// Returns the mapping handle and the router's external IP.
    pub async fn open(port: u16) -> Result<(Self, IpAddr), String> {
        Self::open_forward(port, port).await
    }

    /// Map external TCP `external_port` → local `internal_port`, replacing any
    /// existing entry for that external port.
    pub async fn open_forward(
        external_port: u16,
        internal_port: u16,
    ) -> Result<(Self, IpAddr), String> {
        Self::open_inner(external_port, internal_port, true).await
    }

    /// Like [`Self::open_forward`] but refuses to replace another app's mapping
    /// (only our own `GoogleSnakeOnline` entries are overwritten).
    pub async fn open_forward_exclusive(
        external_port: u16,
        internal_port: u16,
    ) -> Result<(Self, IpAddr), String> {
        Self::open_inner(external_port, internal_port, false).await
    }

    async fn open_inner(
        external_port: u16,
        internal_port: u16,
        replace_foreign: bool,
    ) -> Result<(Self, IpAddr), String> {
        let client = http_client()?;
        let gateway = discover_gateway_with(&client).await?;

        let external_ip = external_ip_with(&client, &gateway)
            .await
            .map_err(|e| format!("GetExternalIPAddress failed: {e}"))?;
        if let IpAddr::V4(v4) = external_ip {
            if is_private_or_cgnat(v4) {
                warn!(
                    %external_ip,
                    event = "upnp_external_ip_private",
                    hint = "router WAN address is private/CGNAT — double NAT; internet peers may not reach this forward"
                );
            }
        }

        ensure_mapping_with(&client, &gateway, external_port, internal_port, replace_foreign)
            .await
            .map_err(|e| format!("AddPortMapping failed: {e}"))?;

        info!(
            external_port,
            internal_port,
            local_ip = %gateway.local_ip,
            %external_ip,
            control_url = %gateway.control_url,
            description = MAPPING_DESCRIPTION,
            event = "upnp_mapped"
        );

        Ok((
            Self {
                external_port,
                gateway: Some(gateway),
            },
            external_ip,
        ))
    }

    pub fn port(&self) -> u16 {
        self.external_port
    }

    pub fn gateway(&self) -> Option<&Gateway> {
        self.gateway.as_ref()
    }

    /// Give up ownership without unmapping; caller must delete via
    /// [`delete_mapping_on`] (or [`delete_tcp_mapping`]) later.
    pub fn release(mut self) -> Option<Gateway> {
        self.gateway.take()
    }

    /// Delete the mapping (idempotent). Prefer this over relying on Drop alone.
    pub async fn close(&mut self) {
        let port = self.external_port;
        if let Some(gateway) = self.gateway.take() {
            match delete_mapping_on(&gateway, port).await {
                Ok(()) => info!(port, event = "upnp_unmapped"),
                Err(e) => warn!(port, error = %e, event = "upnp_unmap_failed"),
            }
        }
    }
}

impl Drop for UpnpMapping {
    fn drop(&mut self) {
        let Some(gateway) = self.gateway.take() else {
            return;
        };
        let port = self.external_port;
        // Runtime may already be shutting down — remove on a detached thread
        // with its own runtime so we still clear the router forward.
        let _ = std::thread::Builder::new()
            .name("upnp-unmap".into())
            .spawn(move || {
                let result = block_on(async move { delete_mapping_on(&gateway, port).await });
                if let Err(e) = result {
                    eprintln!("[upnp] Drop unmap failed for TCP {port}: {e}");
                }
            });
    }
}

/// Discover the IGD WAN connection service on the LAN.
pub async fn discover_gateway() -> Result<Gateway, String> {
    let client = http_client()?;
    discover_gateway_with(&client).await
}

/// Router external (WAN) IP via GetExternalIPAddress.
pub async fn external_ip(gateway: &Gateway) -> Result<IpAddr, String> {
    let client = http_client()?;
    external_ip_with(&client, gateway)
        .await
        .map_err(|e| e.to_string())
}

/// DeletePortMapping on an already-resolved gateway (missing entry is Ok).
pub async fn delete_mapping_on(gateway: &Gateway, external_port: u16) -> Result<(), String> {
    let client = http_client()?;
    delete_mapping_with(&client, gateway, external_port)
        .await
        .map_err(|e| format!("DeletePortMapping failed: {e}"))
}

/// Best-effort DeletePortMapping for console Stop/Restart (child may be hard-killed).
pub async fn delete_tcp_mapping(port: u16) -> Result<(), String> {
    let gateway = discover_gateway().await?;
    delete_mapping_on(&gateway, port).await?;
    info!(port, event = "upnp_unmapped");
    Ok(())
}

/// Delete the mapping only if it carries our description. Returns whether one was removed.
pub async fn delete_tcp_mapping_if_ours(port: u16) -> Result<bool, String> {
    let client = http_client()?;
    let gateway = discover_gateway_with(&client).await?;
    let existing = get_mapping_with(&client, &gateway, port)
        .await
        .map_err(|e| format!("GetSpecificPortMappingEntry failed: {e}"))?;
    let ours = existing
        .as_ref()
        .and_then(|m| m.get("NewPortMappingDescription"))
        .is_some_and(|d| d == MAPPING_DESCRIPTION);
    if !ours {
        return Ok(false);
    }
    delete_mapping_with(&client, &gateway, port)
        .await
        .map_err(|e| format!("DeletePortMapping failed: {e}"))?;
    info!(port, event = "upnp_unmapped");
    Ok(true)
}

/// Blocking DeletePortMapping (Drop / sync callers).
pub fn delete_tcp_mapping_sync(port: u16) -> Result<(), String> {
    block_on(delete_tcp_mapping(port))
}

fn block_on<F: std::future::Future<Output = Result<(), String>>>(fut: F) -> Result<(), String> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("tokio runtime: {e}"))?
        .block_on(fut)
}

fn http_client() -> Result<reqwest::Client, String> {
    // reqwest is built with rustls-*-no-provider; plain-HTTP router calls still
    // need a process CryptoProvider before Client::build.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .no_proxy()
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|e| format!("UPnP HTTP client: {e}"))
}

// ---------------------------------------------------------------- discovery

/// Non-loopback, non-link-local IPv4 adapters.
fn lan_ipv4_adapters() -> Vec<(String, Ipv4Addr)> {
    let Ok(ifaces) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };
    let mut out: Vec<(String, Ipv4Addr)> = Vec::new();
    for iface in ifaces {
        if iface.is_loopback() {
            continue;
        }
        if let IpAddr::V4(ip) = iface.ip() {
            if ip.is_link_local() || ip.is_unspecified() || out.iter().any(|(_, a)| *a == ip) {
                continue;
            }
            out.push((iface.name.clone(), ip));
        }
    }
    out
}

fn search_message(st: &str) -> String {
    format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_MULTICAST}:{SSDP_PORT}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n"
    )
}

fn ssdp_socket(ip: Ipv4Addr) -> std::io::Result<tokio::net::UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.bind(&SocketAddr::V4(SocketAddrV4::new(ip, 0)).into())?;
    socket.set_multicast_if_v4(&ip)?;
    socket.set_nonblocking(true)?;
    tokio::net::UdpSocket::from_std(socket.into())
}

struct SsdpHit {
    location: String,
    adapter: String,
    local_ip: Ipv4Addr,
}

async fn discover_gateway_with(client: &reqwest::Client) -> Result<Gateway, String> {
    let adapters = lan_ipv4_adapters();
    if adapters.is_empty() {
        return Err("no LAN IPv4 adapter found for UPnP discovery".into());
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<SsdpHit>();
    let mut listeners = JoinSet::new();
    for (name, ip) in &adapters {
        let socket = match ssdp_socket(*ip) {
            Ok(s) => s,
            Err(e) => {
                warn!(adapter = %name, %ip, error = %e, event = "upnp_ssdp_iface_failed");
                continue;
            }
        };
        let target = SocketAddr::V4(SocketAddrV4::new(SSDP_MULTICAST, SSDP_PORT));
        for st in SEARCH_TARGETS {
            if let Err(e) = socket.send_to(search_message(st).as_bytes(), target).await {
                warn!(adapter = %name, %ip, error = %e, event = "upnp_ssdp_send_failed");
            }
        }
        info!(adapter = %name, %ip, event = "upnp_ssdp_iface");
        let tx = tx.clone();
        let adapter = name.clone();
        let local_ip = *ip;
        listeners.spawn(async move {
            let mut buf = [0u8; 2048];
            loop {
                let Ok((n, _from)) = socket.recv_from(&mut buf).await else {
                    return;
                };
                let text = String::from_utf8_lossy(&buf[..n]);
                let headers = parse_ssdp_headers(&text);
                if !is_gateway_response(&headers) {
                    continue;
                }
                if let Some(location) = headers.get("location") {
                    let _ = tx.send(SsdpHit {
                        location: location.clone(),
                        adapter: adapter.clone(),
                        local_ip,
                    });
                }
            }
        });
    }
    drop(tx);

    let deadline = tokio::time::Instant::now() + DISCOVERY_TIMEOUT;
    let mut tried = HashSet::new();
    let mut last_err: Option<String> = None;
    while let Ok(Some(hit)) = tokio::time::timeout_at(deadline, rx.recv()).await {
        if !tried.insert(hit.location.clone()) {
            continue;
        }
        match resolve_gateway(client, &hit.location, hit.local_ip).await {
            Ok(gateway) => {
                info!(
                    adapter = %hit.adapter,
                    local_ip = %gateway.local_ip,
                    location = %gateway.location,
                    service_type = %gateway.service_type,
                    event = "upnp_gateway_found"
                );
                return Ok(gateway);
            }
            Err(e) => {
                warn!(location = %hit.location, error = %e, event = "upnp_gateway_rejected");
                last_err = Some(format!("{}: {e}", hit.location));
            }
        }
    }
    listeners.abort_all();

    let tried_adapters = adapters
        .iter()
        .map(|(n, ip)| format!("{n} ({ip})"))
        .collect::<Vec<_>>()
        .join(", ");
    Err(match last_err {
        Some(e) => format!("no usable UPnP gateway (last: {e}); adapters tried: {tried_adapters}"),
        None => format!("no UPnP gateway answered within {}s; adapters tried: {tried_adapters}", DISCOVERY_TIMEOUT.as_secs()),
    })
}

fn parse_ssdp_headers(message: &str) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    for line in message.lines() {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    headers
}

fn is_gateway_response(headers: &HashMap<String, String>) -> bool {
    const MARKERS: [&str; 3] = ["InternetGatewayDevice", "WANIPConnection", "WANPPPConnection"];
    ["st", "usn"].iter().any(|key| {
        headers
            .get(*key)
            .is_some_and(|v| MARKERS.iter().any(|m| v.contains(m)))
    })
}

async fn resolve_gateway(
    client: &reqwest::Client,
    location: &str,
    local_ip: Ipv4Addr,
) -> Result<Gateway, String> {
    let response = client
        .get(location)
        .send()
        .await
        .map_err(|e| format!("description fetch failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("description read failed: {e}"))?;
    if !status.is_success() {
        return Err(format!("description HTTP {status}"));
    }
    let (service_type, control_url) = find_wan_service(&body, location)?;
    Ok(Gateway {
        location: location.to_string(),
        control_url,
        service_type,
        local_ip,
    })
}

// ---------------------------------------------------------------- XML / SOAP

fn parse_xml(xml: &str) -> Result<roxmltree::Document<'_>, String> {
    let trimmed = xml.trim_start_matches('\u{feff}').trim_start();
    let options = roxmltree::ParsingOptions {
        allow_dtd: true,
        ..Default::default()
    };
    roxmltree::Document::parse_with_options(trimmed, options).map_err(|e| format!("bad XML: {e}"))
}

fn child_text<'a>(node: roxmltree::Node<'a, '_>, name: &str) -> Option<&'a str> {
    node.children()
        .find(|c| c.is_element() && c.tag_name().name() == name)
        .and_then(|c| c.text())
        .map(str::trim)
}

/// Find the WAN connection service in an IGD description.
/// Returns `(serviceType, absolute controlURL)`; WANIPConnection preferred.
fn find_wan_service(xml: &str, location: &str) -> Result<(String, String), String> {
    let doc = parse_xml(xml)?;
    let root = doc.root_element();
    let base = child_text(root, "URLBase")
        .filter(|s| !s.is_empty())
        .unwrap_or(location);

    let mut ppp: Option<(String, String)> = None;
    for node in root
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "service")
    {
        let (Some(st), Some(ctrl)) = (child_text(node, "serviceType"), child_text(node, "controlURL"))
        else {
            continue;
        };
        let entry = (st.to_string(), ctrl.to_string());
        if st.contains(":service:WANIPConnection:") {
            return absolutize(base, entry);
        }
        if ppp.is_none() && st.contains(":service:WANPPPConnection:") {
            ppp = Some(entry);
        }
    }
    match ppp {
        Some(entry) => absolutize(base, entry),
        None => Err("no WANIPConnection/WANPPPConnection service in description".into()),
    }
}

fn absolutize(base: &str, (st, ctrl): (String, String)) -> Result<(String, String), String> {
    let url = reqwest::Url::parse(base)
        .and_then(|b| b.join(&ctrl))
        .map_err(|e| format!("bad controlURL {ctrl:?} (base {base:?}): {e}"))?;
    Ok((st, url.to_string()))
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn soap_envelope(service_type: &str, action: &str, args: &[(&str, String)]) -> String {
    let body: String = args
        .iter()
        .map(|(name, value)| format!("<{name}>{}</{name}>", escape_xml(value)))
        .collect();
    format!(
        "<?xml version=\"1.0\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
<s:Body><u:{action} xmlns:u=\"{}\">{body}</u:{action}></s:Body></s:Envelope>",
        escape_xml(service_type)
    )
}

fn parse_soap_response(xml: &str, action: &str) -> Result<HashMap<String, String>, UpnpError> {
    let doc = parse_xml(xml).map_err(UpnpError::Other)?;
    let body = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "Body")
        .ok_or_else(|| UpnpError::Other(format!("{action}: SOAP Body not found")))?;

    if let Some(fault) = body
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == "Fault")
    {
        let find = |name: &str| {
            fault
                .descendants()
                .find(|n| n.is_element() && n.tag_name().name() == name)
                .and_then(|n| n.text())
                .map(|t| t.trim().to_string())
        };
        let code = find("errorCode").and_then(|c| c.parse::<u32>().ok());
        let description = find("errorDescription")
            .or_else(|| find("faultstring"))
            .unwrap_or_else(|| "unknown SOAP fault".into());
        return Err(UpnpError::Soap {
            action: action.to_string(),
            code,
            description,
        });
    }

    let response_name = format!("{action}Response");
    let response = body
        .children()
        .find(|n| n.is_element() && n.tag_name().name() == response_name)
        .ok_or_else(|| UpnpError::Other(format!("{response_name} not found in SOAP body")))?;
    Ok(response
        .children()
        .filter(|n| n.is_element())
        .map(|n| {
            (
                n.tag_name().name().to_string(),
                n.text().unwrap_or("").trim().to_string(),
            )
        })
        .collect())
}

async fn soap_call(
    client: &reqwest::Client,
    gateway: &Gateway,
    action: &str,
    args: &[(&str, String)],
) -> Result<HashMap<String, String>, UpnpError> {
    let response = client
        .post(&gateway.control_url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPAction", format!("\"{}#{action}\"", gateway.service_type))
        .body(soap_envelope(&gateway.service_type, action, args))
        .send()
        .await
        .map_err(|e| UpnpError::Other(format!("{action} request failed: {e}")))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| UpnpError::Other(format!("{action} read failed: {e}")))?;
    if !status.is_success() && status.as_u16() != 500 {
        return Err(UpnpError::Other(format!("{action}: HTTP {status}")));
    }
    parse_soap_response(&text, action)
}

// ---------------------------------------------------------------- actions

async fn external_ip_with(client: &reqwest::Client, gateway: &Gateway) -> Result<IpAddr, UpnpError> {
    let fields = soap_call(client, gateway, "GetExternalIPAddress", &[]).await?;
    let raw = fields
        .get("NewExternalIPAddress")
        .map(String::as_str)
        .unwrap_or("");
    match raw.parse::<IpAddr>() {
        Ok(ip) if !ip.is_unspecified() => Ok(ip),
        _ => Err(UpnpError::Other(format!(
            "router reported no usable external IP ({raw:?}) — WAN may be down"
        ))),
    }
}

async fn get_mapping_with(
    client: &reqwest::Client,
    gateway: &Gateway,
    external_port: u16,
) -> Result<Option<HashMap<String, String>>, UpnpError> {
    let args = [
        ("NewRemoteHost", String::new()),
        ("NewExternalPort", external_port.to_string()),
        ("NewProtocol", "TCP".to_string()),
    ];
    match soap_call(client, gateway, "GetSpecificPortMappingEntry", &args).await {
        Ok(fields) => Ok(Some(fields)),
        Err(e) if matches!(e.code(), Some(ERR_NO_SUCH_ENTRY | ERR_ARRAY_INDEX_INVALID)) => Ok(None),
        Err(e) => Err(e),
    }
}

async fn delete_mapping_with(
    client: &reqwest::Client,
    gateway: &Gateway,
    external_port: u16,
) -> Result<(), UpnpError> {
    let args = [
        ("NewRemoteHost", String::new()),
        ("NewExternalPort", external_port.to_string()),
        ("NewProtocol", "TCP".to_string()),
    ];
    match soap_call(client, gateway, "DeletePortMapping", &args).await {
        Ok(_) => Ok(()),
        Err(e) if e.code() == Some(ERR_NO_SUCH_ENTRY) => Ok(()),
        Err(e) => Err(e),
    }
}

async fn add_mapping_with(
    client: &reqwest::Client,
    gateway: &Gateway,
    external_port: u16,
    internal_port: u16,
) -> Result<(), UpnpError> {
    let args = [
        ("NewRemoteHost", String::new()),
        ("NewExternalPort", external_port.to_string()),
        ("NewProtocol", "TCP".to_string()),
        ("NewInternalPort", internal_port.to_string()),
        ("NewInternalClient", gateway.local_ip.to_string()),
        ("NewEnabled", "1".to_string()),
        ("NewPortMappingDescription", MAPPING_DESCRIPTION.to_string()),
        ("NewLeaseDuration", "0".to_string()),
    ];
    soap_call(client, gateway, "AddPortMapping", &args)
        .await
        .map(|_| ())
}

/// Template order: look up existing entry, delete it if present, then add.
/// With `replace_foreign = false`, another app's entry is an error instead.
async fn ensure_mapping_with(
    client: &reqwest::Client,
    gateway: &Gateway,
    external_port: u16,
    internal_port: u16,
    replace_foreign: bool,
) -> Result<(), UpnpError> {
    match get_mapping_with(client, gateway, external_port).await {
        Ok(Some(existing)) => {
            let internal_client = existing.get("NewInternalClient").map(String::as_str).unwrap_or("?");
            let description = existing.get("NewPortMappingDescription").map(String::as_str).unwrap_or("?");
            if !replace_foreign && description != MAPPING_DESCRIPTION {
                return Err(UpnpError::Other(format!(
                    "external TCP {external_port} is already forwarded to {internal_client} ({description:?}); remove that router mapping first"
                )));
            }
            info!(
                external_port,
                internal_client,
                description,
                event = "upnp_existing_mapping_replaced"
            );
            delete_mapping_with(client, gateway, external_port).await?;
        }
        Ok(None) => {}
        Err(e) => warn!(external_port, error = %e, event = "upnp_get_mapping_failed"),
    }

    match add_mapping_with(client, gateway, external_port, internal_port).await {
        Err(e) if e.code() == Some(ERR_CONFLICT_IN_MAPPING) => {
            delete_mapping_with(client, gateway, external_port).await?;
            add_mapping_with(client, gateway, external_port, internal_port).await
        }
        other => other,
    }
}

/// RFC 1918 private or RFC 6598 carrier-grade NAT (100.64.0.0/10).
pub fn is_private_or_cgnat(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private() || ip.is_loopback() || ip.is_link_local() || (a == 100 && (64..128).contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{extract::State, http::HeaderMap, routing::{get, post}, Router};
    use parking_lot::Mutex;
    use std::sync::Arc;

    const IGD_DESC: &str = r#"<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANPPPConnection:1</serviceType>
            <controlURL>/ctl/PPP</controlURL>
          </service>
          <service>
            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>
            <controlURL>/ctl/IPConn</controlURL>
          </service>
        </serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>"#;

    #[test]
    fn mapping_description_is_google_snake_online() {
        assert_eq!(MAPPING_DESCRIPTION, "GoogleSnakeOnline");
    }

    #[test]
    fn ssdp_headers_parse_and_gateway_match() {
        let reply = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nLocation: http://192.168.1.1:5000/rootDesc.xml\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
        let h = parse_ssdp_headers(reply);
        assert_eq!(h.get("location").unwrap(), "http://192.168.1.1:5000/rootDesc.xml");
        assert!(is_gateway_response(&h));

        let chromecast = parse_ssdp_headers(
            "HTTP/1.1 200 OK\r\nST: urn:dial-multiscreen-org:service:dial:1\r\nUSN: uuid:x::urn:dial-multiscreen-org:service:dial:1\r\nLOCATION: http://192.168.1.9:8008/ssdp/device-desc.xml\r\n",
        );
        assert!(!is_gateway_response(&chromecast));

        let usn_only = parse_ssdp_headers("ST: upnp:rootdevice\r\nUSN: uuid:y::urn:schemas-upnp-org:service:WANPPPConnection:1\r\n");
        assert!(is_gateway_response(&usn_only));
    }

    #[test]
    fn wan_service_prefers_ip_connection_and_resolves_relative() {
        let (st, ctrl) = find_wan_service(IGD_DESC, "http://192.168.1.1:5000/rootDesc.xml").unwrap();
        assert_eq!(st, "urn:schemas-upnp-org:service:WANIPConnection:1");
        assert_eq!(ctrl, "http://192.168.1.1:5000/ctl/IPConn");
    }

    #[test]
    fn wan_service_ppp_fallback_absolute_and_urlbase() {
        let ppp_only = IGD_DESC.replace(
            "<service>\n            <serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>\n            <controlURL>/ctl/IPConn</controlURL>\n          </service>",
            "",
        );
        let (st, ctrl) = find_wan_service(&ppp_only, "http://10.0.0.1/desc.xml").unwrap();
        assert!(st.contains("WANPPPConnection"));
        assert_eq!(ctrl, "http://10.0.0.1/ctl/PPP");

        let absolute = IGD_DESC.replace("/ctl/IPConn", "http://192.168.0.1:49152/upnp/control/WANIPConn1");
        let (_, ctrl) = find_wan_service(&absolute, "http://192.168.1.1:5000/rootDesc.xml").unwrap();
        assert_eq!(ctrl, "http://192.168.0.1:49152/upnp/control/WANIPConn1");

        let with_base = IGD_DESC.replace(
            "<device>\n    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1",
            "<URLBase>http://192.168.2.1:8080/</URLBase><device>\n    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1",
        );
        let (_, ctrl) = find_wan_service(&with_base, "http://192.168.1.1:5000/rootDesc.xml").unwrap();
        assert_eq!(ctrl, "http://192.168.2.1:8080/ctl/IPConn");
    }

    #[test]
    fn wan_service_missing_errors_and_bom_ok() {
        let no_wan = "\u{feff}  <?xml version=\"1.0\"?><root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList></device></root>";
        assert!(find_wan_service(no_wan, "http://192.168.1.1/").is_err());
    }

    #[test]
    fn soap_envelope_escapes_values() {
        let env = soap_envelope(
            "urn:schemas-upnp-org:service:WANIPConnection:1",
            "AddPortMapping",
            &[("NewPortMappingDescription", "a<b>&\"c'".into())],
        );
        assert!(env.contains("<u:AddPortMapping xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\">"));
        assert!(env.contains("<NewPortMappingDescription>a&lt;b&gt;&amp;&quot;c&apos;</NewPortMappingDescription>"));
        assert!(parse_xml(&env).is_ok());
    }

    #[test]
    fn soap_fault_714_parses_code() {
        let fault = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>
<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>714</errorCode><errorDescription>NoSuchEntryInArray</errorDescription></UPnPError></detail>
</s:Fault></s:Body></s:Envelope>"#;
        let err = parse_soap_response(fault, "GetSpecificPortMappingEntry").unwrap_err();
        assert_eq!(err.code(), Some(ERR_NO_SUCH_ENTRY));
        assert!(err.to_string().contains("NoSuchEntryInArray"));
    }

    #[test]
    fn soap_success_external_ip() {
        let ok = r#"<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:GetExternalIPAddressResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">
<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>
</u:GetExternalIPAddressResponse></s:Body></s:Envelope>"#;
        let fields = parse_soap_response(ok, "GetExternalIPAddress").unwrap();
        assert_eq!(fields.get("NewExternalIPAddress").unwrap(), "203.0.113.7");
    }

    #[test]
    fn private_and_cgnat_detection() {
        assert!(is_private_or_cgnat("192.168.1.5".parse().unwrap()));
        assert!(is_private_or_cgnat("10.1.2.3".parse().unwrap()));
        assert!(is_private_or_cgnat("100.64.0.1".parse().unwrap()));
        assert!(is_private_or_cgnat("100.127.255.254".parse().unwrap()));
        assert!(!is_private_or_cgnat("100.128.0.1".parse().unwrap()));
        assert!(!is_private_or_cgnat("203.0.113.7".parse().unwrap()));
    }

    /// Fake IGD control endpoint: records SOAP actions, reports an existing entry.
    #[derive(Default)]
    struct FakeRouter {
        actions: Vec<String>,
        mapped: bool,
        last_add_body: String,
    }

    async fn fake_control(
        State(router): State<Arc<Mutex<FakeRouter>>>,
        headers: HeaderMap,
        body: String,
    ) -> (axum::http::StatusCode, String) {
        let action = headers
            .get("SOAPAction")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim_matches('"').split('#').nth(1))
            .unwrap_or("")
            .to_string();
        let mut r = router.lock();
        r.actions.push(action.clone());
        let envelope = |inner: String| {
            format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body>{inner}</s:Body></s:Envelope>")
        };
        let fault = |code: u32| {
            envelope(format!("<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{code}</errorCode><errorDescription>err</errorDescription></UPnPError></detail></s:Fault>"))
        };
        let ok = |inner: &str| {
            envelope(format!("<u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\">{inner}</u:{action}Response>"))
        };
        match action.as_str() {
            "GetSpecificPortMappingEntry" if r.mapped => (
                axum::http::StatusCode::OK,
                ok("<NewInternalClient>192.168.1.50</NewInternalClient><NewPortMappingDescription>old</NewPortMappingDescription>"),
            ),
            "GetSpecificPortMappingEntry" => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, fault(714)),
            "DeletePortMapping" if !r.mapped => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, fault(714)),
            "DeletePortMapping" => {
                r.mapped = false;
                (axum::http::StatusCode::OK, ok(""))
            }
            "AddPortMapping" if r.mapped => (axum::http::StatusCode::INTERNAL_SERVER_ERROR, fault(718)),
            "AddPortMapping" => {
                r.mapped = true;
                r.last_add_body = body;
                (axum::http::StatusCode::OK, ok(""))
            }
            "GetExternalIPAddress" => (
                axum::http::StatusCode::OK,
                ok("<NewExternalIPAddress>203.0.113.7</NewExternalIPAddress>"),
            ),
            _ => (axum::http::StatusCode::BAD_REQUEST, String::new()),
        }
    }

    #[tokio::test]
    async fn ensure_mapping_replaces_existing_in_template_order() {
        let router = Arc::new(Mutex::new(FakeRouter {
            mapped: true,
            ..Default::default()
        }));
        let app = Router::new()
            .route("/rootDesc.xml", get(|| async { IGD_DESC }))
            .route("/ctl/IPConn", post(fake_control))
            .with_state(router.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = http_client().unwrap();
        let location = format!("http://{addr}/rootDesc.xml");
        let gw = resolve_gateway(&client, &location, Ipv4Addr::new(192, 168, 1, 77))
            .await
            .unwrap();
        assert_eq!(gw.control_url, format!("http://{addr}/ctl/IPConn"));

        let ip = external_ip_with(&client, &gw).await.unwrap();
        assert_eq!(ip, "203.0.113.7".parse::<IpAddr>().unwrap());

        // Foreign entry ("old") blocks the exclusive variant and is left untouched.
        let err = ensure_mapping_with(&client, &gw, 7777, 7777, false).await.unwrap_err();
        assert!(err.to_string().contains("192.168.1.50"));
        assert!(router.lock().mapped);
        router.lock().actions.truncate(1);

        ensure_mapping_with(&client, &gw, 7777, 7777, true).await.unwrap();
        {
            let r = router.lock();
            assert_eq!(
                r.actions[1..],
                ["GetSpecificPortMappingEntry", "DeletePortMapping", "AddPortMapping"]
            );
            assert!(r.mapped);
            assert!(r.last_add_body.contains("<NewInternalClient>192.168.1.77</NewInternalClient>"));
            assert!(r.last_add_body.contains("<NewLeaseDuration>0</NewLeaseDuration>"));
            assert!(r.last_add_body.contains("<NewPortMappingDescription>GoogleSnakeOnline</NewPortMappingDescription>"));
        }

        delete_mapping_with(&client, &gw, 7777).await.unwrap();
        // Deleting a missing entry (714) is not an error.
        delete_mapping_with(&client, &gw, 7777).await.unwrap();
        assert!(!router.lock().mapped);
    }

    /// Real router round-trip: `cargo test live_router_roundtrip -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_router_roundtrip() {
        let port = 17_777;
        let (mut mapping, external_ip) = UpnpMapping::open(port).await.expect("open");
        let gw = mapping.gateway().cloned().unwrap();
        eprintln!("gateway {gw:?} external {external_ip}");
        let client = http_client().unwrap();
        let entry = get_mapping_with(&client, &gw, port).await.unwrap().expect("entry present");
        eprintln!("entry {entry:?}");
        assert_eq!(entry.get("NewInternalClient").unwrap(), &gw.local_ip.to_string());
        mapping.close().await;
        assert!(get_mapping_with(&client, &gw, port).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn ensure_mapping_adds_when_absent() {
        let router = Arc::new(Mutex::new(FakeRouter::default()));
        let app = Router::new()
            .route("/rootDesc.xml", get(|| async { IGD_DESC }))
            .route("/ctl/IPConn", post(fake_control))
            .with_state(router.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = http_client().unwrap();
        let gw = resolve_gateway(&client, &format!("http://{addr}/rootDesc.xml"), Ipv4Addr::new(192, 168, 1, 77))
            .await
            .unwrap();
        ensure_mapping_with(&client, &gw, 80, 7780, false).await.unwrap();
        let r = router.lock();
        assert_eq!(r.actions, ["GetSpecificPortMappingEntry", "AddPortMapping"]);
        assert!(r.last_add_body.contains("<NewExternalPort>80</NewExternalPort>"));
        assert!(r.last_add_body.contains("<NewInternalPort>7780</NewInternalPort>"));
    }
}
