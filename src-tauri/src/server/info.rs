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

/// QR code for a URL, as an inline SVG string.
///
/// The LAN URL carries a 64-character token, so it is far too long to type on
/// a phone — pointing a camera at it is the only comfortable way in. Rendered
/// server-side to avoid adding a QR library to the frontend bundle.
fn qr_svg(target: &str) -> Option<String> {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};

    // Low error correction: the payload is long and this is displayed on a
    // screen, not printed, so redundancy buys nothing but density.
    let code = QrCode::with_error_correction_level(target, EcLevel::L).ok()?;
    let rendered = code
        .render()
        .min_dimensions(180, 180)
        .dark_color(svg::Color("#0c0c0c"))
        .light_color(svg::Color("#ffffff"))
        .quiet_zone(true)
        .build();

    // The renderer prefixes an `<?xml …?>` prolog, which is meaningless once
    // the markup is injected into an HTML document — hand back the bare
    // element so the frontend can drop it straight into the DOM.
    let start = rendered.find("<svg")?;
    Some(rendered[start..].to_string())
}

/// Build the info payload for the given configuration.
pub fn access_info(cfg: WebConfig) -> WebAccessInfo {
    let token = auth::token().to_string();
    let running = super::current();
    let bound_port = running.and_then(|(_, port)| port);
    let lan_ip = if cfg.lan { lan_ip() } else { None };

    let lan_url = lan_ip.map(|ip| url(&ip.to_string(), cfg.port, &token));
    let lan_qr_svg = lan_url.as_deref().and_then(qr_svg);

    WebAccessInfo {
        enabled: cfg.enabled,
        lan: cfg.lan,
        port: cfg.port,
        bound_port,
        running: cfg.enabled && bound_port.is_some(),
        local_url: url("127.0.0.1", cfg.port, &token),
        lan_url,
        lan_ip: lan_ip.map(|ip| ip.to_string()),
        lan_qr_svg,
        token,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_renders_scannable_svg_for_a_token_url() {
        // A real LAN URL: the 64-char token is what makes this too long to
        // type and therefore worth a QR code at all.
        let url = format!("http://192.168.1.50:9870/?token={}", "a".repeat(64));
        let svg = qr_svg(&url).expect("QR should render");
        assert!(svg.starts_with("<svg"), "expected an SVG document");
        assert!(svg.contains("</svg>"));
        // Modules are drawn as paths/rects; an empty canvas would mean the
        // payload silently failed to encode.
        assert!(svg.contains("#0c0c0c"), "expected dark modules in the output");
        assert!(!svg.contains("<?xml"), "XML prolog must be stripped for HTML embedding");
        assert!(svg.len() > 500, "suspiciously small QR: {} bytes", svg.len());
    }

    #[test]
    fn qr_is_none_for_input_that_cannot_encode() {
        // Far beyond QR's capacity — must degrade to None, not panic.
        assert!(qr_svg(&"x".repeat(10_000)).is_none());
    }
}
