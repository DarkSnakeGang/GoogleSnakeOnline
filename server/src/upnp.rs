//! IGD / UPnP TCP port mapping for cross-internet play.
//!
//! Opens a WAN→LAN forward for the game bind port and always deletes it on
//! stop so a shut-down host does not leave the router mapping behind.

use igd_next::aio::tokio::{self as igd_tokio, Tokio};
use igd_next::aio::Gateway as AsyncGateway;
use igd_next::{AddPortError, PortMappingProtocol, SearchOptions};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;
use tracing::{info, warn};

/// Fixed IGD mapping description shown in the router UI.
pub const MAPPING_DESCRIPTION: &str = "GoogleSnakeOnline";

/// Active TCP port forward owned by the game process.
pub struct UpnpMapping {
    port: u16,
    gateway: Option<AsyncGateway<Tokio>>,
}

impl UpnpMapping {
    /// Discover the gateway, map TCP `port`→`port` to the LAN IP toward it.
    /// Returns the mapping handle and the router's external IP.
    pub async fn open(port: u16) -> Result<(Self, IpAddr), String> {
        let gateway = igd_tokio::search_gateway(SearchOptions {
            timeout: Some(Duration::from_secs(8)),
            ..Default::default()
        })
        .await
        .map_err(|e| format!("UPnP gateway search failed: {e}"))?;

        let local_ip = local_ipv4_toward(gateway.addr)
            .map_err(|e| format!("could not determine LAN IP for UPnP: {e}"))?;
        let local_addr = SocketAddr::new(IpAddr::V4(local_ip), port);

        ensure_tcp_mapping(&gateway, port, local_addr).await?;

        let external_ip = gateway
            .get_external_ip()
            .await
            .map_err(|e| format!("GetExternalIPAddress failed: {e}"))?;

        info!(
            port,
            %local_ip,
            %external_ip,
            description = MAPPING_DESCRIPTION,
            event = "upnp_mapped"
        );

        Ok((
            Self {
                port,
                gateway: Some(gateway),
            },
            external_ip,
        ))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Delete the mapping (idempotent). Prefer this over relying on Drop alone.
    pub async fn close(&mut self) {
        let port = self.port;
        if let Some(gateway) = self.gateway.take() {
            match gateway
                .remove_port(PortMappingProtocol::TCP, port)
                .await
            {
                Ok(()) => {
                    info!(port, event = "upnp_unmapped");
                }
                Err(e) => {
                    warn!(port, error = %e, event = "upnp_unmap_failed");
                    // Best-effort sync retry (router may still have the entry).
                    let _ = delete_tcp_mapping_sync(port);
                }
            }
        }
    }
}

impl Drop for UpnpMapping {
    fn drop(&mut self) {
        if self.gateway.take().is_none() {
            return;
        }
        let port = self.port;
        // Runtime may already be shutting down — sync search/remove on a
        // detached thread so we still clear the router forward.
        let _ = std::thread::Builder::new()
            .name("upnp-unmap".into())
            .spawn(move || {
                if let Err(e) = delete_tcp_mapping_sync(port) {
                    eprintln!("[upnp] Drop unmap failed for TCP {port}: {e}");
                }
            });
    }
}

/// Best-effort DeletePortMapping for console Stop/Restart (child may be hard-killed).
pub async fn delete_tcp_mapping(port: u16) -> Result<(), String> {
    let gateway = igd_tokio::search_gateway(SearchOptions {
        timeout: Some(Duration::from_secs(5)),
        ..Default::default()
    })
    .await
    .map_err(|e| format!("UPnP gateway search failed: {e}"))?;

    gateway
        .remove_port(PortMappingProtocol::TCP, port)
        .await
        .map_err(|e| format!("DeletePortMapping failed: {e}"))?;
    info!(port, event = "upnp_unmapped");
    Ok(())
}

/// Blocking DeletePortMapping (Drop / sync callers).
pub fn delete_tcp_mapping_sync(port: u16) -> Result<(), String> {
    let gateway = igd_next::search_gateway(SearchOptions {
        timeout: Some(Duration::from_secs(5)),
        ..Default::default()
    })
    .map_err(|e| format!("UPnP gateway search failed: {e}"))?;

    gateway
        .remove_port(PortMappingProtocol::TCP, port)
        .map_err(|e| format!("DeletePortMapping failed: {e}"))?;
    Ok(())
}

async fn ensure_tcp_mapping(
    gateway: &AsyncGateway<Tokio>,
    port: u16,
    local_addr: SocketAddr,
) -> Result<(), String> {
    match gateway
        .add_port(
            PortMappingProtocol::TCP,
            port,
            local_addr,
            0,
            MAPPING_DESCRIPTION,
        )
        .await
    {
        Ok(()) => Ok(()),
        Err(AddPortError::PortInUse) => {
            // Same idea as the Node template: delete then re-add.
            let _ = gateway
                .remove_port(PortMappingProtocol::TCP, port)
                .await;
            gateway
                .add_port(
                    PortMappingProtocol::TCP,
                    port,
                    local_addr,
                    0,
                    MAPPING_DESCRIPTION,
                )
                .await
                .map_err(|e| format!("AddPortMapping failed after replace: {e}"))
        }
        Err(e) => Err(format!("AddPortMapping failed: {e}")),
    }
}

/// Pick the LAN IPv4 used toward the gateway (UDP connect trick).
fn local_ipv4_toward(gateway: SocketAddr) -> Result<Ipv4Addr, String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| e.to_string())?;
    socket.connect(gateway).map_err(|e| e.to_string())?;
    match socket.local_addr().map_err(|e| e.to_string())?.ip() {
        IpAddr::V4(ip) if !ip.is_unspecified() && !ip.is_loopback() => Ok(ip),
        other => Err(format!("unexpected local IP toward gateway: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mapping_description_is_google_snake_online() {
        assert_eq!(MAPPING_DESCRIPTION, "GoogleSnakeOnline");
    }

    #[test]
    fn local_ipv4_toward_loopback_gateway_errors_or_returns() {
        // Connecting toward loopback still yields a local address; just ensure
        // the helper does not panic on a well-formed socket addr.
        let addr: SocketAddr = "127.0.0.1:9".parse().unwrap();
        let _ = local_ipv4_toward(addr);
    }
}
