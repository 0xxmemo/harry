//! Atlas account and cluster operations, all through the official `atlas` CLI.

use crate::cli;
use crate::AppState;
use rand::{distributions::Alphanumeric, Rng};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Serialize)]
struct LoginPrompt {
    code: Option<String>,
    url: Option<String>,
}

/// Browser login. The CLI prints a one-time code and URL; Harry shows the code and opens the URL.
#[tauri::command]
pub async fn atlas_login(app: AppHandle) -> Result<String, String> {
    let bin = cli::resolve(&app, "atlas").ok_or("atlas CLI is not installed")?;
    let mut child = Command::new(bin)
        .args(["auth", "login", "--authType", "UserAccount", "--output", "json", "--noBrowser"])
        .env("PATH", cli::search_path(&app))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let code_re = Regex::new(r"^[A-Z0-9]{4}-[A-Z0-9]{4}$").unwrap();
    let url_re = Regex::new(r"https://\S+").unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut prompt = LoginPrompt { code: None, url: None };
    let mut transcript = String::new();
    let wait = tokio::time::timeout(std::time::Duration::from_secs(240), async {
        while let Ok(Some(line)) = lines.next_line().await {
            transcript.push_str(&line);
            transcript.push('\n');
            let t = line.trim();
            if code_re.is_match(t) {
                prompt.code = Some(t.to_string());
            }
            if let Some(m) = url_re.find(t) {
                let url = m.as_str().trim_end_matches('.').to_string();
                if prompt.url.is_none() {
                    let _ = app.opener().open_url(&url, None::<&str>);
                }
                prompt.url = Some(url);
            }
            let _ = app.emit("atlas-login", prompt.clone());
        }
        child.wait().await
    })
    .await;
    match wait {
        Ok(Ok(status)) if status.success() => {}
        Ok(_) => {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = tokio::io::AsyncReadExt::read_to_string(&mut e, &mut err).await;
            }
            return Err(format!("Atlas login failed. {}", if err.trim().is_empty() { transcript } else { err }).trim().to_string());
        }
        Err(_) => return Err("Atlas login timed out. The code expires after 3 minutes; try again.".into()),
    }
    let who = cli::run(&app, "whoami", "atlas", &["auth", "whoami"], &[], None, false).await?;
    Ok(who.stdout.trim().replace("Logged in as ", ""))
}

#[tauri::command]
pub async fn atlas_logout(app: AppHandle) -> Result<(), String> {
    let out = cli::run(&app, "logout", "atlas", &["auth", "logout", "--force"], &[], None, false).await?;
    if out.ok() { Ok(()) } else { Err(out.err_text()) }
}

async fn atlas_json(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let out = cli::run(app, "atlas", "atlas", args, &[], None, false).await?;
    if !out.ok() {
        return Err(out.err_text());
    }
    serde_json::from_str(&out.stdout).map_err(|e| format!("unexpected atlas output: {e}"))
}

#[tauri::command]
pub async fn atlas_projects(app: AppHandle) -> Result<Value, String> {
    atlas_json(&app, &["projects", "list", "--output", "json"]).await
}

#[tauri::command]
pub async fn atlas_clusters(app: AppHandle, project_id: String) -> Result<Value, String> {
    atlas_json(&app, &["clusters", "list", "--projectId", &project_id, "--output", "json"]).await
}

#[derive(Serialize)]
pub struct Connected {
    username: String,
    host: String,
    expires: String,
}

/// Creates a temporary read-only database user and access-list entry, both auto-deleted by Atlas,
/// then keeps the resulting connection string in memory only.
#[tauri::command]
pub async fn atlas_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    cluster: String,
) -> Result<Connected, String> {
    let suffix: String = rand::thread_rng().sample_iter(&Alphanumeric).take(6).map(char::from).collect();
    let username = format!("harry-{}", suffix.to_lowercase());
    let password: String = rand::thread_rng().sample_iter(&Alphanumeric).take(28).map(char::from).collect();
    let expires = (chrono::Utc::now() + chrono::Duration::hours(24)).format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let log = "atlas-connect";

    let user = cli::run(
        &app, log, "atlas",
        &["dbusers", "create", "readAnyDatabase", "--username", &username, "--password", &password,
          "--deleteAfter", &expires, "--projectId", &project_id, "--desc", "Harry temporary read-only user", "--output", "json"],
        &[], None, false,
    ).await?;
    if !user.ok() {
        return Err(format!("Could not create a read-only database user: {}", user.err_text()));
    }

    let acl = cli::run(
        &app, log, "atlas",
        &["accessLists", "create", "--currentIp", "--deleteAfter", &expires, "--projectId", &project_id,
          "--comment", "Harry (auto-expires)", "--output", "json"],
        &[], None, false,
    ).await?;
    if !acl.ok() && !acl.err_text().contains("already") {
        return Err(format!("Could not add this machine to the access list: {}", acl.err_text()));
    }

    let cs = atlas_json(&app, &["clusters", "connectionStrings", "describe", &cluster, "--projectId", &project_id, "--output", "json"]).await?;
    let srv = cs["standardSrv"].as_str().ok_or("cluster has no SRV connection string")?;
    let host = srv.trim_start_matches("mongodb+srv://").trim_end_matches('/').to_string();
    let uri = format!("mongodb+srv://{username}:{password}@{host}/?appName=harry");
    *state.uri.lock().unwrap() = Some(uri);
    Ok(Connected { username, host, expires })
}
