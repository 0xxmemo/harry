//! Detects, installs, and authenticates the CLIs Harry relies on: openllm, atlas, mongosh.

use crate::cli::{self, home, resolve};
use serde::Serialize;
use std::collections::HashMap;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct ToolStatus {
    name: &'static str,
    path: Option<String>,
    version: Option<String>,
}

#[derive(Serialize)]
pub struct AuthStatus {
    openllm: bool,
    openllm_detail: String,
    atlas: bool,
    atlas_detail: String,
}

async fn version(app: &AppHandle, tool: &str) -> Option<String> {
    let out = cli::run(app, "version", tool, &["--version"], &[], None, false).await.ok()?;
    let text = format!("{}{}", out.stdout, out.stderr);
    text.lines().find(|l| !l.trim().is_empty()).map(|l| l.trim().to_string())
}

#[tauri::command]
pub async fn tool_status(app: AppHandle) -> Vec<ToolStatus> {
    let mut out = vec![];
    for name in ["openllm", "atlas", "mongosh", "composio"] {
        let path = resolve(&app, name);
        let version = if path.is_some() { version(&app, name).await } else { None };
        out.push(ToolStatus { name, path: path.map(|p| p.to_string_lossy().into()), version });
    }
    out
}

/// ~/.openllm/.env, the file the OpenLLM installer and daemon share.
pub fn openllm_env() -> HashMap<String, String> {
    std::fs::read_to_string(home().join(".openllm/.env"))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .collect()
}

fn openllm_has_key() -> bool {
    openllm_env().get("OPENLLM_API_KEY").is_some_and(|k| !k.is_empty())
}

/// Cheap round trip through `openllm -p` to prove the key and daemon work.
async fn verify_openllm(app: &AppHandle) -> Result<(), String> {
    let out = cli::run(app, "openllm-verify", "openllm", &["-p", "-", "-m", "claude-haiku-5-5", "--no-stream"], &[], Some("reply ok"), false).await?;
    if out.ok() { Ok(()) } else { Err(out.err_text().trim_start_matches("[openllm] ").to_string()) }
}

#[tauri::command]
pub async fn auth_status(app: AppHandle) -> AuthStatus {
    let (openllm, openllm_detail) = match (resolve(&app, "openllm"), openllm_has_key()) {
        (None, _) => (false, "openllm CLI is not installed".to_string()),
        (Some(_), false) => (false, "Not logged in: paste your API key".to_string()),
        (Some(_), true) => (true, "Logged in".to_string()),
    };
    let (atlas, atlas_detail) = match cli::run(&app, "whoami", "atlas", &["auth", "whoami"], &[], None, false).await {
        Ok(o) if o.ok() => (true, o.stdout.trim().replace("Logged in as ", "")),
        Ok(o) => (false, o.err_text()),
        Err(e) => (false, e),
    };
    AuthStatus { openllm, openllm_detail, atlas, atlas_detail }
}

#[tauri::command]
pub async fn install_tool(app: AppHandle, name: String) -> Result<String, String> {
    let id = format!("install-{name}");
    let out = match name.as_str() {
        "atlas" | "mongosh" => {
            let formula = if name == "atlas" { "mongodb-atlas-cli" } else { "mongosh" };
            if resolve(&app, "brew").is_none() {
                return Err("Homebrew is required to install the MongoDB CLIs: https://brew.sh".into());
            }
            cli::run(&app, &id, "brew", &["install", formula], &[("HOMEBREW_NO_AUTO_UPDATE", "1")], None, true).await?
        }
        "openllm" => run_openllm_installer(&app, &id).await?,
        "composio" => cli::run(&app, &id, "/bin/bash", &["-c", "set -o pipefail; curl -fsSL https://composio.dev/install | sh"], &[], None, true).await?,
        _ => return Err(format!("unknown tool {name}")),
    };
    if out.ok() { Ok(format!("{name} installed")) } else { Err(out.err_text()) }
}

async fn run_openllm_installer(app: &AppHandle, id: &str) -> Result<cli::Output, String> {
    let origin = openllm_env()
        .get("OPENLLM_CLOUD_ORIGIN")
        .cloned()
        .unwrap_or_else(|| "https://www.openllm.sh".into());
    let script = "set -o pipefail; curl -fsSL \"$HARRY_ORIGIN/install\" | bash";
    cli::run(app, id, "/bin/bash", &["-c", script], &[("HARRY_ORIGIN", origin.as_str())], None, true).await
}

/// `openllm login` with the key on stdin (never argv), then a cheap `openllm -p` to verify.
#[tauri::command]
pub async fn openllm_set_key(app: AppHandle, key: String) -> Result<String, String> {
    let key = key.trim().to_string();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return Err("That doesn't look like an API key".into());
    }
    let out = cli::run(&app, "openllm-auth", "openllm", &["login"], &[], Some(&format!("{key}\n")), false).await?;
    if !out.ok() {
        return Err(out.err_text());
    }
    verify_openllm(&app).await.map_err(|e| format!("Key saved, but a test prompt failed: {e}"))?;
    Ok("Logged in".into())
}
