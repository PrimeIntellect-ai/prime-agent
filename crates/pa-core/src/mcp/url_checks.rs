//! Literal-address URL checks for the MCP catalog validator and the local
//! source loader (port of `packages/ai/src/mcp/url-checks.ts`).
//!
//! Structural checks only: loopback, RFC1918 private, link-local and
//! unspecified IPs, plus plain `localhost` names. This is NOT DNS, redirect
//! or rebinding SSRF enforcement — request-time network policy stays with the
//! host/runtime. DNS names that resolve to private space are out of scope.

/// True when the host is a literal private, loopback, link-local or
/// unspecified address (structural check only).
pub(crate) fn is_literal_private_or_loopback_host(hostname: &str) -> bool {
    let bare = hostname
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if bare == "localhost" || bare.ends_with(".localhost") {
        return true;
    }
    if let Some(parsed) = parse_ipv4(&bare) {
        let parts = match parsed {
            ParsedIpv4::Refused => return true,
            ParsedIpv4::Quad(quad) => quad,
        };
        let [a, b, _, _] = parts;
        return a == 127
            || a == 10
            || a == 0
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254);
    }
    if bare.contains(':') {
        match expand_ipv6(&bare) {
            None => return true,
            Some(words) => {
                if words.iter().all(|word| word == &0) {
                    return true;
                }
                if words[..7].iter().all(|word| word == &0) && words[7] == 1 {
                    return true;
                }
                if words[..6].iter().all(|word| word == &0) && words[5] == 0xffff {
                    let v4 = [
                        words[6] >> 8,
                        words[6] & 0xff,
                        words[7] >> 8,
                        words[7] & 0xff,
                    ];
                    return is_literal_private_or_loopback_host(&format!(
                        "{}.{}.{}.{}",
                        v4[0], v4[1], v4[2], v4[3]
                    ));
                }
                if (words[0] & 0xffc0) == 0xfe80 {
                    return true;
                }
                // IPv6 unique-local fc00::/7.
                if (words[0] & 0xfe00) == 0xfc00 {
                    return true;
                }
            }
        }
    }
    false
}

/// A dotted-quad IPv4 literal: `Ok` for a canonical quad, `Refused` for a
/// malformed or out-of-range quad (refused like TS), `None` when the host is
/// not quad-shaped at all.
enum ParsedIpv4 {
    Quad([u8; 4]),
    Refused,
}

fn parse_ipv4(host: &str) -> Option<ParsedIpv4> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    for (index, part) in parts.iter().enumerate() {
        let value: u32 = part.parse().ok()?;
        if value > 255 {
            // Out-of-range quad: refuse (matching TS Number.isInteger/<=255).
            return Some(ParsedIpv4::Refused);
        }
        octets[index] = value as u8;
    }
    Some(ParsedIpv4::Quad(octets))
}

/// Expand an IPv6 address into eight numeric 16-bit words; `None` when
/// malformed (the caller refuses malformed addresses).
fn expand_ipv6(address: &str) -> Option<[u16; 8]> {
    let (head, tail) = match address.split_once("::") {
        Some((head, tail)) => (head, Some(tail)),
        None => (address, None),
    };
    let head_parts: Vec<&str> = if head.is_empty() {
        Vec::new()
    } else {
        head.split(':').collect()
    };
    let tail_parts: Vec<&str> = match tail {
        None | Some("") => Vec::new(),
        Some(tail) => tail.split(':').collect(),
    };
    let total = head_parts.len() + tail_parts.len();
    let mut words = [0u16; 8];
    let fill = if tail.is_none() {
        // No "::": all eight groups must be present and non-empty.
        if total != 8 || head_parts.iter().any(|part| part.is_empty()) {
            return None;
        }
        0
    } else if total > 7 {
        return None;
    } else {
        8 - total
    };
    for (index, part) in head_parts.iter().enumerate() {
        words[index] = parse_ipv6_word(part)?;
    }
    for index in 0..fill {
        words[head_parts.len() + index] = 0;
    }
    for (index, part) in tail_parts.iter().enumerate() {
        words[head_parts.len() + fill + index] = parse_ipv6_word(part)?;
    }
    Some(words)
}

fn parse_ipv6_word(part: &str) -> Option<u16> {
    u16::from_str_radix(if part.is_empty() { "0" } else { part }, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_hosts_are_refused() {
        for host in [
            "localhost",
            "LocalHost",
            "app.localhost",
            "127.0.0.1",
            "10.0.0.5",
            "0.0.0.0",
            "172.16.1.2",
            "192.168.0.1",
            "169.254.1.1",
            "[::1]",
            "[::]",
            "[fe80::1]",
            "[fc00::1]",
            "[fd12::1]",
            "[::ffff:127.0.0.1]",
            "999.1.1.1", // malformed quads refuse
            "[zz::1]",   // malformed v6 refuses
        ] {
            assert!(
                is_literal_private_or_loopback_host(host),
                "{host} must be refused"
            );
        }
    }

    #[test]
    fn public_hosts_pass() {
        for host in [
            "mcp.linear.app",
            "api.githubcopilot.com",
            "8.8.8.8",
            "172.32.0.1",
            "172.32.1.2",
            "[2606:4700::6810:85e5]",
            "[2001:db8::1]",
        ] {
            assert!(
                !is_literal_private_or_loopback_host(host),
                "{host} must pass"
            );
        }
    }
}
