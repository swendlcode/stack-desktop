//! What the Settings UI needs to hand browser access to a person or a phone:
//! the reachable URLs, with the token already attached.

use std::net::{IpAddr, UdpSocket};

use super::{auth, WebConfig};
use crate::models::WebAccessInfo;

/// This machine's address on the local network.
///
/// Uses the standard connectionless trick: "connecting" a UDP socket to a
/// routable address picks the outbound interface without sending a packet, so
/// we learn the source IP the router would see. No extra dependency, and no
/// traffic. Returns `None` when there is no usable route (offline, or the only
/// route is loopback).
pub fn lan_ip() -> Option<IpAddr> {
    for probe in ["8.8.8.8:80", "1.1.1.1:80", "192.168.1.1:80"] {
        let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
            continue;
        };
        if sock.connect(probe).is_err() {
            continue;
        }
        match sock.local_addr() {
            Ok(addr) if !addr.ip().is_loopback() && !addr.ip().is_unspecified() => {
                return Some(addr.ip())
            }
            _ => continue,
        }
    }
    None
}

fn url(host: &str, port: u16, token: &str) -> String {
    format!("http://{}:{}/?token={}", host, port, token)
}

/// Build the info payload for the given configuration.
pub fn access_info(cfg: WebConfig) -> WebAccessInfo {
    let token = auth::token().to_string();
    let running = super::current();
    let bound_port = running.and_then(|(_, port)| port);
    let lan_ip = if cfg.lan { lan_ip() } else { None };

    WebAccessInfo {
        enabled: cfg.enabled,
        lan: cfg.lan,
        port: cfg.port,
        bound_port,
        running: cfg.enabled && bound_port.is_some(),
        local_url: url("127.0.0.1", cfg.port, &token),
        lan_url: lan_ip.map(|ip| url(&ip.to_string(), cfg.port, &token)),
        lan_ip: lan_ip.map(|ip| ip.to_string()),
        token,
    }
}
