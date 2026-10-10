//! The TLS trust seam: the extra-CA contract every HTTPS client surface in
//! the app routes through.
//!
//! The TS build inherited `NODE_EXTRA_CA_CERTS` from the Node runtime; the
//! Rust app has no such runtime inheritance, so the app itself is the
//! initiator of extra-CA trust (the reported symptom: the Rust port refused
//! to connect to internal servers whose TLS uses a custom certificate
//! authority).
//!
//! # Contract
//!
//! The trust environment variables, and their precedence when several are
//! set:
//!
//! - [`NODE_EXTRA_CA_CERTS`](EXTRA_CA_CERTS_ENV) (the parity name) names a
//!   PEM file of extra certificate authorities that are **appended** to the
//!   native/system roots.
//! - [`SSL_CERT_FILE`](SSL_CERT_FILE_ENV) / [`SSL_CERT_DIR`](SSL_CERT_DIR_ENV)
//!   (the standard OpenSSL convention, as `rustls-native-certs` implements
//!   it: a file of PEM certificates, and/or a directory of certificate
//!   files) **replace** the root store with exactly the certificates at the
//!   named paths.
//! - Both channels compose: `NODE_EXTRA_CA_CERTS` is appended to whatever
//!   base the `SSL_CERT_*` variables leave.
//! - A missing, unreadable, or invalid source behind an explicitly-set
//!   variable is a loud [`TlsTrustError`] naming the variable and the path
//!   — never a silently ignored trust change.
//! - When none of the variables is set, nothing changes: the helpers report
//!   `Ok(None)` and the caller keeps its existing default TLS behavior.

use std::path::{Path, PathBuf};

use rustls::pki_types::{pem::PemObject, CertificateDer};
use rustls::{ClientConfig, RootCertStore};
use thiserror::Error;

/// The Node parity name: a PEM file of extra certificate authorities
/// appended to the native/system roots.
pub const EXTRA_CA_CERTS_ENV: &str = "NODE_EXTRA_CA_CERTS";
/// The OpenSSL convention: a PEM file of certificates that replaces the
/// root store.
pub const SSL_CERT_FILE_ENV: &str = "SSL_CERT_FILE";
/// The OpenSSL convention: a directory of certificate files that replaces
/// the root store.
pub const SSL_CERT_DIR_ENV: &str = "SSL_CERT_DIR";

/// A trust-source failure. The message names the environment variable and
/// the offending path so the failure is actionable.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TlsTrustError {
    /// An explicitly-set trust variable points at a source that cannot be
    /// loaded or parsed.
    #[error("{variable}={path} cannot be loaded: {cause}")]
    Source {
        /// The trust variable that named the path.
        variable: &'static str,
        /// The path the variable named.
        path: PathBuf,
        /// Why the source cannot be loaded (I/O or PEM parse failure).
        cause: String,
    },
    /// The platform's native root store — the base the extra certificate
    /// authorities are appended to — could not be loaded.
    #[error("the native/system root store cannot be loaded: {0}")]
    NativeStore(String),
}

/// The ALPN protocols the TLS handshake offers. The one transport detail a
/// preconfigured [`ClientConfig`] owns: `reqwest` normally derives it from
/// the builder's HTTP-version settings, and each client surface passes the
/// variant that matches the behavior it has today.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsAlpn {
    /// HTTP/1.1 only: every client built without the `http2` feature and
    /// the `http1_only()` provider clients.
    Http1,
    /// HTTP/2 preferred with HTTP/1.1 fallback: `reqwest`'s default for a
    /// client built with the `http2` feature (the bedrock ALPN client).
    Negotiated,
    /// No ALPN: the websocket transport's own default (tungstenite offers
    /// none).
    None,
}

impl TlsAlpn {
    /// The wire protocols the variant advertises.
    #[must_use]
    pub fn protocols(self) -> Vec<Vec<u8>> {
        match self {
            Self::Http1 => vec![b"http/1.1".to_vec()],
            Self::Negotiated => vec![b"h2".to_vec(), b"http/1.1".to_vec()],
            Self::None => Vec::new(),
        }
    }
}

/// The root store the trust variables call for, or `None` when none of them
/// is set (the caller keeps its existing default TLS behavior).
///
/// # Errors
///
/// Returns [`TlsTrustError`] when an explicitly-set variable points at a
/// source that cannot be loaded or parsed, or the platform's native root
/// store cannot be loaded.
pub fn extra_ca_store() -> Result<Option<RootCertStore>, TlsTrustError> {
    let extras = env_path(EXTRA_CA_CERTS_ENV);
    let ssl_file = env_path(SSL_CERT_FILE_ENV);
    let ssl_dirs = env_dirs(SSL_CERT_DIR_ENV);

    if extras.is_none() && ssl_file.is_none() && ssl_dirs.is_empty() {
        return Ok(None);
    }

    let mut store = RootCertStore::empty();
    if ssl_file.is_some() || !ssl_dirs.is_empty() {
        // The OpenSSL convention: the explicitly named paths ARE the root
        // store.
        if let Some(path) = &ssl_file {
            add_cert_path(&mut store, Some(path), None, SSL_CERT_FILE_ENV)?;
        }
        for dir in &ssl_dirs {
            add_cert_path(&mut store, None, Some(dir), SSL_CERT_DIR_ENV)?;
        }
    } else {
        // The base the extras are appended to: the platform's native trust
        // store.
        let result = rustls_native_certs::load_native_certs();
        if let Some(error) = result.errors.first() {
            return Err(TlsTrustError::NativeStore(error.to_string()));
        }
        store.add_parsable_certificates(result.certs);
    }
    if let Some(path) = &extras {
        for certificate in load_extra_certificates(path)? {
            store
                .add(certificate)
                .map_err(|error| TlsTrustError::Source {
                    variable: EXTRA_CA_CERTS_ENV,
                    path: path.clone(),
                    cause: error.to_string(),
                })?;
        }
    }
    Ok(Some(store))
}

/// The rustls client config every HTTPS client surface must use when the
/// trust variables are set — native roots plus the extras, with the
/// caller's [`TlsAlpn`] — or `None` when none of them is set.
///
/// # Errors
///
/// Returns [`TlsTrustError`] when [`extra_ca_store`] fails.
pub fn extra_ca_client_config(alpn: TlsAlpn) -> Result<Option<ClientConfig>, TlsTrustError> {
    let Some(store) = extra_ca_store()? else {
        return Ok(None);
    };
    let mut config = ClientConfig::builder()
        .with_root_certificates(store)
        .with_no_client_auth();
    config.alpn_protocols = alpn.protocols();
    Ok(Some(config))
}

/// An explicitly-set variable's path (`None` when unset).
fn env_path(variable: &str) -> Option<PathBuf> {
    std::env::var_os(variable).map(PathBuf::from)
}

/// An explicitly-set directory list variable's non-empty entries (empty when
/// unset or empty: the platform's own convention treats an empty list as
/// unset).
fn env_dirs(variable: &str) -> Vec<PathBuf> {
    std::env::var_os(variable)
        .map(|value| {
            std::env::split_paths(&value)
                .filter(|path| !path.as_os_str().is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Add the certificates at one named source to `store`, failing loud when
/// the source cannot be read or parsed (the `rustls-native-certs` loader
/// reports per-path I/O and PEM errors; valid-but-irrelevant sections are
/// skipped, the OpenSSL loader's own tolerance).
fn add_cert_path(
    store: &mut RootCertStore,
    file: Option<&Path>,
    dir: Option<&Path>,
    variable: &'static str,
) -> Result<(), TlsTrustError> {
    let result = rustls_native_certs::load_certs_from_paths(file, dir);
    if let Some(error) = result.errors.first() {
        return Err(TlsTrustError::Source {
            variable,
            path: file.or(dir).unwrap_or(Path::new("")).to_path_buf(),
            cause: error.to_string(),
        });
    }
    store.add_parsable_certificates(result.certs);
    Ok(())
}

/// The extra certificate authorities one named PEM file holds. Loud on every
/// failure: unreadable file, read failure, malformed certificate section —
/// and a readable file that holds no certificate at all (an extras file
/// exists to add trust; adding nothing means it is misconfigured).
fn load_extra_certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>, TlsTrustError> {
    let source = |cause: String| TlsTrustError::Source {
        variable: EXTRA_CA_CERTS_ENV,
        path: path.to_path_buf(),
        cause,
    };
    let iterator =
        CertificateDer::pem_file_iter(path).map_err(|error| source(error.to_string()))?;
    let mut certificates = Vec::new();
    for certificate in iterator {
        certificates.push(certificate.map_err(|error| source(error.to_string()))?);
    }
    if certificates.is_empty() {
        return Err(source("no PEM certificates found".to_string()));
    }
    Ok(certificates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::pki_types::PrivateKeyDer;

    /// A self-signed test certificate authority (20-year validity, RSA-2048)
    /// generated for this suite; the leaf below is signed by it.
    const TEST_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIDKTCCAhGgAwIBAgIUa4KpovBg3PBfe4GnVYkG6RDcyecwDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZUHJpbWUgQWdlbnQgVGVzdCBFeHRyYSBDQTAeFw0yNjEw
MTAwNjAxMTlaFw00NjEwMDUwNjAxMTlaMCQxIjAgBgNVBAMMGVByaW1lIEFnZW50
IFRlc3QgRXh0cmEgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCv
e6sDPSx0zUAq4T2guf6PrPILdB652jpLi7qbDCRTz4yBNtgU8NKacknHJMTVWdAb
W4yRqhVlA+sFUu2pZ0zpt7fCzl4GVgvax+MacEwPSxiboz//iLJpKo2G+BImKnkd
f/MnOrdMTWUP1IzW7Qhb/E172XHhepfOOVrCn2Q4n9QbrhWLlW8UqtkENp2d7dnM
A9cuJ+EA/a3F7rj9N+gcVR46mmhsFuRRj04H59E6BzAjvtatfQlEkoLhDdeibU36
oAztR+91Oqbi2diO1tLYrTyjUBk8z0wffxRNMRh7Hxc02tNADiDo89tr0GsRvVoL
6FbHfQyQvEZd/7RSAXpLAgMBAAGjUzBRMB0GA1UdDgQWBBS7+9ao9XOKrAEYUQYQ
9d2sDWaeYDAfBgNVHSMEGDAWgBS7+9ao9XOKrAEYUQYQ9d2sDWaeYDAPBgNVHRMB
Af8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAxKx4EScwnE7gzdqBCs2wJd2Na
5R3bvACrv3dUx2Pp0tAhDmR4ds3woFQ7dqsuQ3QUOJfXOD943QKZXcmi/wsNLwJq
6544oMSVJXN3w1i1KJQyVWLzqwFfSHgDfBw63KkW0Zpo5QUTTzVh518EDd68vvUG
QWTBQ3IYruTFIxAxpfFfGPkAqDB0XKWN/8GqZwBfE4v5k201tRfb1sYKUyHRCu+K
69f7iJiU0FIoOS4sbFPgWcdSWwrQnrJ7uQY4UvA1gqS6hDHP9eyhMDwKYaCl0SBn
/XdlJP8Co8NqueUUVAW6UsBIyTxicaFCpIo4NVeEUZLPYF1/kEOg+dbsgLAu
-----END CERTIFICATE-----
";
    /// A second, distinct test certificate authority.
    const TEST_SECOND_CA_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIDKzCCAhOgAwIBAgIUQfVxOaUC35UBHl6Z6YJqu3viyE8wDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaUHJpbWUgQWdlbnQgVGVzdCBTZWNvbmQgQ0EwHhcNMjYx
MDEwMDYwMzI0WhcNNDYxMDA1MDYwMzI0WjAlMSMwIQYDVQQDDBpQcmltZSBBZ2Vu
dCBUZXN0IFNlY29uZCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AKngv2PiCZJiPt8eFbmumCtLTeEYSq5taWEioDBOu1nbnMOWifjqOEt3kFjFhTls
ygghxzdqkFOVUhL/l4Vmyp0GbrwrU3bg4Bvjc4/TzAJsGi9UOwBsi3WAZeoMoAqy
Iju4KnDJ+77yFj3XTP/fGDsncSNtS5I4j1wMBq/ac68Hv2OoKaf4C7NdQ1nM9gZu
vcgaNaK268exz1D4WgCWAuzRfvVGTZWt45y2+1lE9JRhW+19lCAXh7P4V02ew/3h
0pl06SvhrRCbdhg4AjOxTStP/YKRcYi81lHHZBzW4kpqR/3vZXbMj1iVD41gzCBH
/+yqB0i9wmCgfujZNFnC9vcCAwEAAaNTMFEwHQYDVR0OBBYEFH0uXRX+Xb5Me79p
gjbCPsgoCjN4MB8GA1UdIwQYMBaAFH0uXRX+Xb5Me79pgjbCPsgoCjN4MA8GA1Ud
EwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAIUSf+dxIqtw/VLiHuIOA/Wo
xOwLIWRrRoBhzjsI5zjf6QFvqbT2BB21k/A5J8PdsxpMMhmt3uUK3ngnejiRk/1/
N/36g6q55DTWpYpWRfVaKYty5LBc00OnpgslPKiCpgQVxtc6MtilLRrnVwoda3W0
65TbMK1Pb5gfptOs8nmrH+SGcH6DAm2Nf7lvvgIjzcW9hgJ+s8d7wouJb54JABTz
uXEMChSgKj8/BcEWDbGB+lJ7xiyZLUO9Ns4lsQJq1sWce+yg5UvyMFTzI9HTMIjx
3ATJZq2AVN2GaanltMOMZXAZr28Pgcli9ZLTFl0EMOr8Kz605LhncmVkv2s78B0=
-----END CERTIFICATE-----
";
    /// A leaf certificate for the loopback TLS server, signed by
    /// [`TEST_CA_PEM`], with SANs `DNS:localhost,IP:127.0.0.1`.
    const TEST_LEAF_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIDWTCCAkGgAwIBAgIUNP/suNnnFB5y9ckmo1x7/srdAZ4wDQYJKoZIhvcNAQEL
BQAwJDEiMCAGA1UEAwwZUHJpbWUgQWdlbnQgVGVzdCBFeHRyYSBDQTAeFw0yNjEw
MTAwNjAxMTlaFw00NjEwMDUwNjAxMTlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCC
ASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAJuqqkPGIaXuIsa/2Yk/jMWK
3ISOi+wdPl1LVR0hXBmEB5zg7uRPd/XEMj4p5zBnqrQpQb98M2y4Fz9gZ9K1ctqc
LQ2xNYEK8+9r+QZM2odmU1J+zXa9CLy/Faf/e9gQ8aCSPMVus1P51VqsE1JovUfJ
ong1kBXrrBUJMzy0kdfoN+f65Bb/xo28cREouI3q+6woMxNMtXPSOrPEORDmT0QF
81PLAjT9WOl+3A2OPwC3qtPpAwACl4vDMqUIEfYVoDwa9OD4jjVG8+I5R5UTvcnY
7bXhEga2paaXD5F00UHvrVEYGGCuv5H6SzIkYcmE7vaTvuQQxZAzTKMxfR51/TUC
AwEAAaOBkjCBjzAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TAQH/
BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0O
BBYEFIWz8i6g/cR9GgA/dlIeL0l9cuAcMB8GA1UdIwQYMBaAFLv71qj1c4qsARhR
BhD13awNZp5gMA0GCSqGSIb3DQEBCwUAA4IBAQBB5dFsOa2oYX85aHO0EL0ZsVIK
szwA5M9wtlpN59fSnOT0znX8dz6fW3uRUcvwMN/uWMObTVRyUYaIbmakIEhmgJ0z
JRSI4TahZn58QADEZFEM0/OEJYU+tcbOjdunG0x15VtYpR5GR/2v1+xnym6cJA23
OR6+OgQOF3H9IGe2EJ0R2DvPcIw/4NyI5umjd4htk5K1ldW1uBHXfcTZBJ6V8pDT
5q5OyF++D+A+osJbCX6UA9EyJ67hHl4miKUH8x3PNSNBbEbCUEa9bd/3WH3+FdkM
Ga4oJExAw+u22itfebwphAeEf/TBKFzMTHvYXeLIacgeN5PU9awYfJVD2QMq
-----END CERTIFICATE-----
";
    /// The leaf's PKCS#8 private key.
    const TEST_LEAF_KEY_PEM: &str = "-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCbqqpDxiGl7iLG
v9mJP4zFityEjovsHT5dS1UdIVwZhAec4O7kT3f1xDI+KecwZ6q0KUG/fDNsuBc/
YGfStXLanC0NsTWBCvPva/kGTNqHZlNSfs12vQi8vxWn/3vYEPGgkjzFbrNT+dVa
rBNSaL1HyaJ4NZAV66wVCTM8tJHX6Dfn+uQW/8aNvHERKLiN6vusKDMTTLVz0jqz
xDkQ5k9EBfNTywI0/VjpftwNjj8At6rT6QMAApeLwzKlCBH2FaA8GvTg+I41RvPi
OUeVE73J2O214RIGtqWmlw+RdNFB761RGBhgrr+R+ksyJGHJhO72k77kEMWQM0yj
MX0edf01AgMBAAECggEAAJPne/fEqt6DxrfsI4f7U61R+es15xHenujhPSI/tLAo
MDgbmJbbTHTh9YWtVvB2OewxFkdUHJSFYZFP78+yTmJbuHMA4MkpDLWsvNcnOsR3
ylHUo0ucH+4R0b7BkuoBwauSa4DKD1A0u3bxjnZ1b6vqYzdyuUOgwTWErOEA+ZGv
4ERSPUNH8l1btIu1JHbHmdJ9UKvLJe1/P1RTUl12OPA148dXCBZZYWzUqcI0iLqn
8A8+sa7Pbq5ZLfwYG8whFi7haL5zMv9+HFmfoAl16uFnmG1gqAfLWIKld5WWUc5c
LKdyPwQ2NgVH1SyuxKh7gkoqXPutFXHT+cFpteuFsQKBgQDOKVTTExFJesU9Po2N
76D5lYebbmr6BDTfIIqrAR/xX2V/Hrg3WTlh7hgM5hZFiuoLjqm39vBbr4dEA5MO
zdllxzMSgoW8yBfBWtuTseGv5WHlwmhWL+KEqb1vvlfFNETyDNqRxGv83dIgAvUr
CzL8l/ojtuH86SXbr4ZKAJXNdwKBgQDBTF+rg6Jwt5TMYY7DzBQDdae2/7sIAhSa
dGatT00Qys/Ln6HG2bX9onioi33H3OUtWieL0CiD3PdRT+2ye2FjH72dACzp9q4h
dDM6qOs8cYHbUqxRHFF6Ru6Y3bs3/lE+AhVi8ODXm9VtwzCtaei5hokU9LWHhere
chtsWewFswKBgGCvE3/VzmKmd//L6Tjqa5UBIlKrivHrrRwDN+UQpvlc4s2mC4Cx
kG6z6YWLFmDQ0AhRhJio73ogLJCiGIJ12YGY1QPWQIATWsisIpP2dUA3lBzbenEJ
DfNnY1cXbjQm2jql+o8oDfjN0rB+kpn4K5Y4c+/x4bPpZ37Kp3DnK1nrAoGALiHl
H1D+PrqBp7mM0gvtptm4mkM0RvgAJNCtBKXNdbmBmE5T1Np2xb613zvTXBTLGWTP
1V1rnfTpjZ1u1E7/8iFMJqE5FumJq3BJHbHc2oMYg9iaSY1hoLY3EYKxwO5QQ2VJ
52AnuS125YhVIL4LDeQe6UJx5JNAd7Bx/Q0E+GMCgYAPRIN73NrPDTA0sLmHWaHX
iBNjQk/m0tBNv7gPPveySio2iYr0IV4MwuUQ3gpEAcjJ2qrRzOh71/+QCrXGPqpZ
cUr1frTuGR0oYgZu9bht8iR8dHHn1awEnmJop9oTnFeBq11BnigIAiZHBSs67ddU
V1BRFUaQ1qcqy2T5dC3Irw==
-----END PRIVATE KEY-----
";

    /// The trust variables' current values, to restore after the suite (the
    /// repo's restore-shared-state rule).
    type EnvSnapshot = [Option<std::ffi::OsString>; 3];

    fn snapshot_env() -> EnvSnapshot {
        [
            std::env::var_os(EXTRA_CA_CERTS_ENV),
            std::env::var_os(SSL_CERT_FILE_ENV),
            std::env::var_os(SSL_CERT_DIR_ENV),
        ]
    }

    fn restore_env(snapshot: EnvSnapshot) {
        let [extras, ssl_file, ssl_dir] = snapshot;
        for (variable, value) in [
            (EXTRA_CA_CERTS_ENV, extras),
            (SSL_CERT_FILE_ENV, ssl_file),
            (SSL_CERT_DIR_ENV, ssl_dir),
        ] {
            match value {
                Some(value) => std::env::set_var(variable, value),
                None => std::env::remove_var(variable),
            }
        }
    }

    /// Write a fixture to a temp file, returning its absolute path.
    fn fixture_file(dir: &std::path::Path, name: &str, contents: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, contents).expect("write the fixture");
        path
    }

    /// The whole contract, walked in one sequential test: the trust
    /// variables are process state, so the env-touching scenarios must not
    /// race each other.
    #[tokio::test]
    async fn extra_ca_contract() {
        let snapshot = snapshot_env();
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path();
        let ca = fixture_file(dir, "extra-ca.pem", TEST_CA_PEM);
        let second_ca = fixture_file(dir, "second-ca.pem", TEST_SECOND_CA_PEM);
        let garbage = fixture_file(dir, "garbage.pem", "not a certificate at all\n");
        let no_certs = fixture_file(dir, "no-certs.pem", "hello world\n");
        let missing = dir.join("no-such-ca.pem");

        // Unset variables change nothing: the caller keeps today's default.
        std::env::remove_var(EXTRA_CA_CERTS_ENV);
        std::env::remove_var(SSL_CERT_FILE_ENV);
        std::env::remove_var(SSL_CERT_DIR_ENV);
        assert!(matches!(extra_ca_store(), Ok(None)));

        // NODE_EXTRA_CA_CERTS appends to the native/system roots: a store is
        // configured (its exact size is the machine's native roots plus the
        // one extra; the handshake at the end pins the extras themselves).
        std::env::set_var(EXTRA_CA_CERTS_ENV, &ca);
        assert!(extra_ca_store().expect("the extras store").is_some());

        // A missing file at an explicitly-set variable fails loud, naming
        // the variable and the path.
        std::env::set_var(EXTRA_CA_CERTS_ENV, &missing);
        let error = extra_ca_store().expect_err("a missing extras file fails");
        let TlsTrustError::Source { variable, path, .. } = &error else {
            panic!("the error names its source: {error}");
        };
        assert_eq!(*variable, EXTRA_CA_CERTS_ENV);
        assert_eq!(*path, missing);
        assert!(
            error.to_string().contains(EXTRA_CA_CERTS_ENV)
                && error
                    .to_string()
                    .contains(missing.to_string_lossy().as_ref())
        );

        // A garbage file fails loud (bipolar on parse failures).
        std::env::set_var(EXTRA_CA_CERTS_ENV, &garbage);
        assert!(matches!(
            extra_ca_store(),
            Err(TlsTrustError::Source { .. })
        ));

        // A readable file with no certificates fails loud: an extras file
        // exists to add trust, so one that adds nothing is misconfigured.
        std::env::set_var(EXTRA_CA_CERTS_ENV, &no_certs);
        let error = extra_ca_store().expect_err("an empty extras file fails");
        assert!(error.to_string().contains("no PEM certificates found"));

        // SSL_CERT_FILE replaces the root store: exactly the file's
        // certificates — the loaded PEM is the whole store.
        std::env::remove_var(EXTRA_CA_CERTS_ENV);
        std::env::set_var(SSL_CERT_FILE_ENV, &ca);
        let store = extra_ca_store()
            .expect("the ssl cert file store")
            .expect("a store");
        assert_eq!(store.roots.len(), 1);

        // Both channels compose: NODE_EXTRA_CA_CERTS appends its own PEM to
        // the replaced base (the append count is exact: one base root plus
        // one distinct extra).
        std::env::set_var(EXTRA_CA_CERTS_ENV, &second_ca);
        let store = extra_ca_store()
            .expect("the composed store")
            .expect("a store");
        assert_eq!(store.roots.len(), 2);

        // The composed config's ALPN list is the caller's variant.
        let config = extra_ca_client_config(TlsAlpn::Negotiated)
            .expect("the composed config")
            .expect("a config");
        assert_eq!(
            config.alpn_protocols,
            [b"h2".to_vec(), b"http/1.1".to_vec()]
        );
        let config = extra_ca_client_config(TlsAlpn::Http1)
            .expect("the http1 config")
            .expect("a config");
        assert_eq!(config.alpn_protocols, [b"http/1.1".to_vec()]);
        let config = extra_ca_client_config(TlsAlpn::None)
            .expect("the no-alpn config")
            .expect("a config");
        assert!(config.alpn_protocols.is_empty());

        // A missing file at SSL_CERT_FILE fails loud the same way.
        std::env::set_var(SSL_CERT_FILE_ENV, &missing);
        std::env::remove_var(EXTRA_CA_CERTS_ENV);
        let error = extra_ca_store().expect_err("a missing ssl cert file fails");
        assert!(
            error.to_string().contains(SSL_CERT_FILE_ENV)
                && error
                    .to_string()
                    .contains(missing.to_string_lossy().as_ref())
        );

        // The live-TLS pin: a loopback server presents the leaf signed by
        // the fixture CA. With the CA passed through NODE_EXTRA_CA_CERTS the
        // helper's config completes a real handshake; with the variable
        // unset (the helper reports no config) a default webpki-roots
        // client — today's trust — keeps refusing it.
        std::env::remove_var(SSL_CERT_FILE_ENV);
        std::env::set_var(EXTRA_CA_CERTS_ENV, &ca);
        let extra_ca_config = extra_ca_client_config(TlsAlpn::Http1)
            .expect("the handshake config")
            .expect("the handshake config exists");
        let server = loopback_tls_server().await;
        assert!(
            handshake(server, extra_ca_config).await.is_ok(),
            "the CA from the env var must complete the handshake"
        );

        std::env::remove_var(EXTRA_CA_CERTS_ENV);
        assert!(matches!(extra_ca_client_config(TlsAlpn::Http1), Ok(None)));
        let default_config = ClientConfig::builder()
            .with_root_certificates(RootCertStore {
                roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
            })
            .with_no_client_auth();
        assert!(
            handshake(server, default_config).await.is_err(),
            "today's default trust must keep refusing the custom-CA leaf"
        );

        restore_env(snapshot);
    }

    /// A loopback TLS listener presenting the fixture leaf: every accepted
    /// connection runs the handshake and answers two bytes.
    async fn loopback_tls_server() -> std::net::SocketAddr {
        let certificates: Vec<CertificateDer<'static>> =
            CertificateDer::pem_slice_iter(TEST_LEAF_PEM.as_bytes())
                .collect::<Result<Vec<_>, _>>()
                .expect("the fixture cert parses");
        let key = PrivateKeyDer::from_pem_slice(TEST_LEAF_KEY_PEM.as_bytes())
            .expect("the fixture key parses");
        let server_config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(certificates, key)
            .expect("the fixture cert chain builds");
        let acceptor = tokio_rustls::TlsAcceptor::from(std::sync::Arc::new(server_config));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the loopback listener");
        let address = listener.local_addr().expect("the bound address");
        tokio::spawn(async move {
            use tokio::io::AsyncWriteExt;
            loop {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let acceptor = acceptor.clone();
                tokio::spawn(async move {
                    let Ok(mut stream) = acceptor.accept(socket).await else {
                        return;
                    };
                    let _ = stream.write_all(b"ok").await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        address
    }

    /// One client handshake against the loopback server: connect, complete
    /// the TLS handshake, and read the server's answer.
    async fn handshake(server: std::net::SocketAddr, config: ClientConfig) -> std::io::Result<()> {
        use tokio::io::AsyncReadExt;
        let connector = tokio_rustls::TlsConnector::from(std::sync::Arc::new(config));
        let socket = tokio::net::TcpStream::connect(server).await?;
        let mut stream = connector
            .connect(
                rustls::pki_types::ServerName::try_from("127.0.0.1")
                    .expect("the loopback ip parses")
                    .to_owned(),
                socket,
            )
            .await?;
        let mut answer = [0_u8; 2];
        stream.read_exact(&mut answer).await?;
        Ok(())
    }
}
