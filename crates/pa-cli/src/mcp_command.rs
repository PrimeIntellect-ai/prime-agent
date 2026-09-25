//! User MCP server management, ported from `core/mcp/mcp-command.ts` together
//! with the minimal `mcpServers` settings store it reads and writes.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::get_agent_dir;
use pa_core::auth::AuthStorageBackend;
use pa_core::settings::SettingsStorage;

/// Built-in MCP integrations that reserve their server name
/// (`BUILTIN_MCP_CATALOG` in packages/ai/src/mcp/catalog.ts).
pub const BUILTIN_MCP_CATALOG: &[&str] = &["linear", "notion"];

const NAME_PATTERN: fn(&str) -> bool = is_valid_server_name;

fn is_valid_server_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    let rest = chars.count();
    rest <= 63
        && name[1..]
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn is_valid_env_name(value: &str) -> bool {
    let mut chars = value.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A user-configured MCP server entry, matching the TS `McpServerConfig`
/// wire shape (camelCase keys).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum McpServerConfig {
    #[serde(rename = "http")]
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bearer_token_env_var: Option<String>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        oauth: bool,
    },
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        args: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        env: Option<BTreeMap<String, EnvRef>>,
    },
}

impl McpServerConfig {
    fn type_name(&self) -> &'static str {
        match self {
            McpServerConfig::Http { .. } => "http",
            McpServerConfig::Stdio { .. } => "stdio",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EnvRef {
    pub env: String,
}

fn settings_path() -> PathBuf {
    get_agent_dir().join("settings.json")
}

fn read_settings() -> serde_json::Value {
    std::fs::read_to_string(settings_path())
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

/// Locked read/modify/write of the global settings document. The TS `mcp`
/// command flushes through the settings manager, whose writes hold the
/// proper-lockfile directory lock on `settings.json` (`acquireLockSyncWithRetry`);
/// writes here must hold the same cross-process lock so TS and Rust never
/// race on the same document. `mutate` returns whether the document changed
/// (an unchanged document is not rewritten); a `mutate` error leaves the
/// file unchanged and surfaces. The storage re-invokes the mutator when a
/// racing first writer lands mid-acquisition, so the mutator must be
/// idempotent for the same input document.
fn mutate_global_settings(
    mut mutate: impl FnMut(&mut serde_json::Value) -> Result<bool>,
) -> Result<()> {
    let storage = pa_core::settings::FileSettingsStorage::new(
        std::env::current_dir().context("resolving the current directory")?,
        get_agent_dir(),
    );
    let mut failure: Option<anyhow::Error> = None;
    storage
        .with_lock(pa_core::settings::SettingsScope::Global, &mut |current| {
            let mut settings = current
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .unwrap_or_else(|| serde_json::json!({}));
            match mutate(&mut settings).and_then(|changed| {
                changed
                    .then(|| serde_json::to_string_pretty(&settings).map_err(Into::into))
                    .transpose()
            }) {
                Ok(next) => next,
                Err(error) => {
                    failure = Some(error);
                    None
                }
            }
        })
        .context("updating settings.json")?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(())
}

fn get_global_mcp_servers() -> BTreeMap<String, McpServerConfig> {
    read_settings()
        .get("mcpServers")
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn set_global_mcp_server(name: &str, config: McpServerConfig) -> Result<()> {
    let value = serde_json::to_value(&config)?;
    mutate_global_settings(|settings| {
        let servers = settings
            .as_object_mut()
            .ok_or_else(|| anyhow!("settings.json must contain a JSON object"))?
            .entry("mcpServers".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !servers.is_object() {
            bail!("the mcpServers setting must be a JSON object");
        }
        servers
            .as_object_mut()
            .unwrap()
            .insert(name.to_string(), value.clone());
        Ok(true)
    })
}

fn remove_global_mcp_server(name: &str) -> Result<bool> {
    let mut removed = false;
    mutate_global_settings(|settings| {
        let Some(servers) = settings
            .get_mut("mcpServers")
            .and_then(|value| value.as_object_mut())
        else {
            return Ok(false);
        };
        removed = servers.remove(name).is_some();
        Ok(removed)
    })?;
    Ok(removed)
}

/// Drop the `mcp:<name>` credential from auth.json under the auth storage
/// lock, mirroring `AuthStorage.removeVerified`: the TS product serializes the
/// current document and writes it back inside `withLock`, so a concurrent TS
/// credential refresh and a Rust credential drop never race on the file.
fn drop_server_credentials(name: &str) -> Result<()> {
    if BUILTIN_MCP_CATALOG.contains(&name) {
        return Ok(());
    }
    let backend = pa_core::auth::FileAuthStorageBackend::new(get_agent_dir().join("auth.json"));
    backend
        .with_lock(&mut |current| {
            let mut auth: serde_json::Value =
                serde_json::from_str(current.as_deref().unwrap_or("{}"))
                    .context("parsing auth.json")?;
            let Some(object) = auth.as_object_mut() else {
                bail!("auth.json must contain a JSON object");
            };
            if object.remove(&format!("mcp:{name}")).is_none() {
                return Ok(((), None));
            }
            Ok((
                (),
                Some(serde_json::to_string_pretty(&auth).context("serializing auth.json")?),
            ))
        })
        .context("updating auth.json")?;
    Ok(())
}

/// Run an `mcp <add|list|get|remove>` command; the returned message is printed
/// by the caller, and errors are printed as `Error: <message>` with exit 1.
pub fn run_mcp_management_command(args: &[String]) -> Result<String> {
    let action = args.first().map(String::as_str).unwrap_or_default();
    match action {
        "list" => {
            require_count(args, 1, "mcp list")?;
            Ok(format_mcp_server_list(get_global_mcp_servers()))
        }
        "get" => {
            require_count(args, 2, "mcp get <name>")?;
            let name = validate_name(&args[1])?;
            let servers = get_global_mcp_servers();
            let config = servers
                .get(name)
                .ok_or_else(|| anyhow!("MCP server \"{name}\" was not found."))?;
            Ok(format!("{name}: {}", config.type_name()))
        }
        "remove" => {
            require_count(args, 2, "mcp remove <name>")?;
            let name = validate_name(&args[1])?;
            let servers = get_global_mcp_servers();
            if !servers.contains_key(name) || !remove_global_mcp_server(name)? {
                bail!("MCP server \"{name}\" was not found.");
            }
            drop_server_credentials(name)?;
            Ok(format!("Removed MCP server \"{name}\"."))
        }
        "add" => {
            let (name, config, force) = parse_mcp_add_args(&args[1..])?;
            let replaced = get_global_mcp_servers().contains_key(name);
            if replaced && !force {
                bail!("MCP server \"{name}\" already exists. Use --force to replace it.");
            }
            drop_server_credentials(name)?;
            set_global_mcp_server(name, config)?;
            Ok(format!(
                "{} MCP server \"{name}\".",
                if replaced { "Replaced" } else { "Added" }
            ))
        }
        _ => bail!("Usage: mcp <add|list|get|remove>."),
    }
}

fn format_mcp_server_list(servers: BTreeMap<String, McpServerConfig>) -> String {
    if servers.is_empty() {
        return "No user-configured MCP servers.".to_string();
    }
    servers
        .iter()
        .map(|(name, config)| format!("{name}: {}", config.type_name()))
        .collect::<Vec<_>>()
        .join("\n")
}

fn require_count(args: &[String], count: usize, usage: &str) -> Result<()> {
    if args.len() != count {
        bail!("Usage: {usage}");
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<&str> {
    if NAME_PATTERN(name) {
        Ok(name)
    } else {
        bail!("MCP server names must be 1-64 letters, numbers, underscores, or hyphens and start with a letter or number.")
    }
}

fn parse_mcp_add_args(args: &[String]) -> Result<(&str, McpServerConfig, bool)> {
    let name = validate_name(args.first().map_or("", String::as_str))?;
    if BUILTIN_MCP_CATALOG.contains(&name) {
        bail!("MCP server name \"{name}\" is reserved for a built-in integration.");
    }
    let separator = args.iter().position(|arg| arg == "--");
    let option_args = &args[1..separator.unwrap_or(args.len())];
    let command_args: &[String] = separator.map_or(&[], |sep| &args[sep + 1..]);
    let mut url: Option<String> = None;
    let mut bearer_token_env_var: Option<String> = None;
    let mut oauth = false;
    let mut force = false;
    let mut cwd: Option<String> = None;
    let mut env: BTreeMap<String, EnvRef> = BTreeMap::new();
    let mut seen_options: Vec<&str> = Vec::new();

    let mut index = 0;
    while index < option_args.len() {
        let option = option_args[index].as_str();
        if option != "--env" && seen_options.contains(&option) {
            bail!("Duplicate MCP add option: {option}");
        }
        seen_options.push(option);
        if option == "--oauth" || option == "--force" {
            if option == "--oauth" {
                oauth = true;
            } else {
                force = true;
            }
            index += 1;
            continue;
        }
        if option != "--url"
            && option != "--bearer-token-env-var"
            && option != "--cwd"
            && option != "--env"
        {
            bail!("Unknown MCP add option: {option}");
        }
        let Some(value) = option_args.get(index + 1).filter(|v| !v.is_empty()) else {
            bail!("{option} requires a value.");
        };
        match option {
            "--url" => url = Some(value.clone()),
            "--bearer-token-env-var" => {
                bearer_token_env_var = Some(validate_env_name(value, option)?);
            }
            "--cwd" => cwd = Some(value.clone()),
            _ => {
                let equals = value.find('=').filter(|&e| e > 0 && e < value.len() - 1);
                let Some(equals) = equals else {
                    bail!("--env must use CHILD=SOURCE, where both sides are environment variable names.");
                };
                let child = validate_env_name(&value[..equals], "--env child")?;
                let source = validate_env_name(&value[equals + 1..], "--env source")?;
                if env.contains_key(child.as_str()) {
                    bail!("Duplicate child environment variable: {child}");
                }
                env.insert(
                    child.to_string(),
                    EnvRef {
                        env: source.to_string(),
                    },
                );
            }
        }
        index += 2;
    }

    if separator.is_some() {
        if url.is_some() || bearer_token_env_var.is_some() || oauth {
            bail!("Stdio MCP servers cannot use HTTP options.");
        }
        let command = command_args.first().filter(|c| !c.trim().is_empty());
        let Some(command) = command else {
            bail!("A command is required after --.");
        };
        return Ok((
            name,
            McpServerConfig::Stdio {
                command: command.clone(),
                args: (!command_args[1..].is_empty()).then(|| command_args[1..].to_vec()),
                cwd,
                env: (!env.is_empty()).then_some(env),
            },
            force,
        ));
    }

    if cwd.is_some() || !env.is_empty() {
        bail!("--cwd and --env require a stdio command after --.");
    }
    let Some(url) = url else {
        bail!("Use --url <url> for HTTP or -- <command> [args...] for stdio.");
    };
    if bearer_token_env_var.is_some() && oauth {
        bail!("--oauth and --bearer-token-env-var cannot be combined.");
    }
    Ok((
        name,
        McpServerConfig::Http {
            url: validate_http_url(&url)?,
            bearer_token_env_var,
            oauth,
        },
        force,
    ))
}

fn validate_env_name(value: &str, option: &str) -> Result<String> {
    if is_valid_env_name(value) {
        Ok(value.to_string())
    } else {
        bail!("{option} requires an environment variable name.")
    }
}

fn validate_http_url(value: &str) -> Result<String> {
    // WHATWG-style checks matching `new URL(value)` in the TS product:
    // - no scheme, or an empty host after skipping extra slashes, fails to parse
    //   ("Invalid MCP URL: <value>");
    // - a parsed URL with a non-http(s) protocol, no hostname, or embedded
    //   credentials is rejected by the http(s) requirement instead.
    let Some((scheme, rest)) = split_scheme(value) else {
        bail!("Invalid MCP URL: {value}");
    };
    if !matches!(scheme, "http" | "https") {
        bail!("MCP URL must be an http(s) URL without embedded credentials.");
    }
    // The parser skips any extra slashes and backslashes after the scheme.
    let after_authority = rest
        .trim_start_matches(['/', '\\'])
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let host = after_authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    if after_authority
        .rsplit_once('@')
        .is_some_and(|(user, _)| user.is_empty())
    {
        // `user@host` and `:pw@host` both carry credentials.
        bail!("MCP URL must be an http(s) URL without embedded credentials.");
    }
    if host.is_empty() {
        bail!("Invalid MCP URL: {value}");
    }
    if after_authority.contains('@') {
        bail!("MCP URL must be an http(s) URL without embedded credentials.");
    }
    // Normalize the way `url.toString()` does: lowercase scheme and host,
    // default path to "/".
    let authority = after_authority;
    let host_lower = authority.to_ascii_lowercase();
    let path = &rest[rest.find(authority).unwrap_or(0) + authority.len()..];
    let path = if path.is_empty() || path.starts_with('?') || path.starts_with('#') {
        format!("/{path}")
    } else {
        path.to_string()
    };
    Ok(format!("{scheme}://{host_lower}{path}"))
}

fn split_scheme(value: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = value.split_once(':')?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
    {
        return None;
    }
    if !scheme
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    {
        return None;
    }
    Some((scheme, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip() {
        let value: BTreeMap<String, McpServerConfig> = serde_json::from_value(serde_json::json!({
            "y": {"type": "http", "url": "https://example.com/mcp"}
        }))
        .unwrap();
        assert_eq!(
            value.get("y"),
            Some(&McpServerConfig::Http {
                url: "https://example.com/mcp".to_string(),
                bearer_token_env_var: None,
                oauth: false
            })
        );
        let serialized = serde_json::to_value(&value).unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({"y": {"type": "http", "url": "https://example.com/mcp"}})
        );
    }

    #[test]
    fn name_patterns() {
        assert!(is_valid_server_name("a"));
        assert!(is_valid_server_name("A-b_9"));
        assert!(!is_valid_server_name(""));
        assert!(!is_valid_server_name("-abc"));
        assert!(!is_valid_server_name("a".repeat(65).as_str()));
    }

    #[test]
    fn http_url_validation() {
        assert!(validate_http_url("https://example.com/mcp").is_ok());
        assert!(validate_http_url("http://localhost:8080").is_ok());
        let err = validate_http_url("notaurl").unwrap_err().to_string();
        assert_eq!(err, "Invalid MCP URL: notaurl");
        let err = validate_http_url("ftp://example.com")
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "MCP URL must be an http(s) URL without embedded credentials."
        );
        let err = validate_http_url("http://u:p@example.com")
            .unwrap_err()
            .to_string();
        assert_eq!(
            err,
            "MCP URL must be an http(s) URL without embedded credentials."
        );
        let err = validate_http_url("http://").unwrap_err().to_string();
        assert_eq!(err, "Invalid MCP URL: http://");
        let err = validate_http_url("https:///").unwrap_err().to_string();
        assert_eq!(err, "Invalid MCP URL: https:///");
        assert_eq!(validate_http_url("http:///path").unwrap(), "http://path/");
    }
}
