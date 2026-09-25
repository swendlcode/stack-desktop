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
    let element = &rendered[start..];

    // It also hard-codes width/height in pixels, which made the code overflow
    // and clip inside its container. Drop them and let the viewBox scale it to
    // whatever size the layout gives it.
    let head_end = element.find('>')?;
    let (head, body) = element.split_at(head_end);
    let head = head
        .split_whitespace()
        .filter(|attr| !attr.starts_with("width=") && !attr.starts_with("height="))
        .collect::<Vec<_>>()
        .join(" ");
    Some(format!("{head} width=\"100%\" height=\"100%\"{body}"))
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
        // Must scale to its container rather than carry a fixed pixel size,
        // which previously overflowed and clipped the code.
        assert!(svg.contains("viewBox"), "viewBox is what makes it scalable");
        // Check the opening tag only: inner <rect> elements legitimately carry
        // pixel-valued width/height in user units, which scale with the viewBox.
        let open_tag = &svg[..svg.find('>').expect("opening tag")];
        assert!(open_tag.contains("width=\"100%\""), "expected a fluid width");
        assert!(
            !open_tag.contains("width=\"180\""),
            "fixed pixel width must be gone from the root element: {open_tag}"
        );
    }

    #[test]
    fn qr_is_none_for_input_that_cannot_encode() {
        // Far beyond QR's capacity — must degrade to None, not panic.
        assert!(qr_svg(&"x".repeat(10_000)).is_none());
    }
}
