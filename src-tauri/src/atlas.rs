//! Atlas account and cluster operations, all through the official `atlas` CLI.

use crate::store;
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
}

const USER: &str = "harry";
const DESC: &str = "Harry store, cluster=";

fn new_password() -> String {
    rand::thread_rng().sample_iter(&Alphanumeric).take(28).map(char::from).collect()
}

/// Makes `cluster` Harry's database: a single `harry` user (read any database, write only `harry`)
/// whose description records the cluster, so the next launch can find it through the Atlas CLI.
/// The password is rotated on every connect and only ever held in memory.
async fn link(app: &AppHandle, state: &State<'_, AppState>, project_id: &str, cluster: &str) -> Result<Connected, String> {
    let log = "atlas-connect";
    let password = new_password();
    let desc = format!("{DESC}{cluster}");
    let role = "readAnyDatabase@admin,readWrite@harry";
    let exists = cli::run(app, log, "atlas", &["dbusers", "describe", USER, "--projectId", project_id, "--output", "json"], &[], None, false).await?.ok();
    let verb = if exists { "update" } else { "create" };
    let mut args = vec!["dbusers", verb];
    if exists {
        args.extend([USER, "--password", &password]);
    } else {
        args.extend(["--username", USER, "--password", &password]);
    }
    args.extend(["--role", role, "--desc", &desc, "--projectId", project_id, "--output", "json"]);
    let user = cli::run(app, log, "atlas", &args, &[], None, false).await?;
    if !user.ok() {
        return Err(format!("Could not set up Harry's database user: {}", user.err_text()));
    }

    let acl = cli::run(app, log, "atlas", &["accessLists", "create", "--currentIp", "--projectId", project_id, "--comment", "Harry", "--output", "json"], &[], None, false).await?;
    if !acl.ok() && !acl.err_text().contains("already") {
        return Err(format!("Could not add this machine to the access list: {}", acl.err_text()));
    }

    let cs = atlas_json(app, &["clusters", "connectionStrings", "describe", cluster, "--projectId", project_id, "--output", "json"]).await?;
    let srv = cs["standardSrv"].as_str().ok_or("cluster has no SRV connection string")?;
    let host = srv.trim_start_matches("mongodb+srv://").trim_end_matches('/').to_string();
    let uri = format!("mongodb+srv://{USER}:{password}@{host}/?appName=harry");
    // A password change can take a few seconds to propagate across the cluster.
    let mut last = String::new();
    for _ in 0..10 {
        match store::connect(app, &uri).await {
            Ok(()) => { last.clear(); break; }
            Err(e) => { last = e; tokio::time::sleep(std::time::Duration::from_secs(3)).await; }
        }
    }
    if !last.is_empty() {
        return Err(last);
    }
    *state.uri.lock().unwrap() = Some(uri);
    crate::files::restore_roots(app).await;
    Ok(Connected { username: USER.into(), host })
}

#[tauri::command]
pub async fn atlas_connect(app: AppHandle, state: State<'_, AppState>, project_id: String, cluster: String) -> Result<Connected, String> {
    link(&app, &state, &project_id, &cluster).await
}

/// On launch: find the cluster Harry was linked to (via the `harry` user's description) and
/// reconnect. Returns None when the Atlas CLI isn't signed in or nothing was linked yet.
#[tauri::command]
pub async fn atlas_restore(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Connected>, String> {
    let Ok(v) = atlas_json(&app, &["projects", "list", "--output", "json"]).await else { return Ok(None) };
    let projects = v.get("results").cloned().unwrap_or(v);
    for p in projects.as_array().cloned().unwrap_or_default() {
        let Some(pid) = p["id"].as_str() else { continue };
        let Ok(u) = atlas_json(&app, &["dbusers", "describe", USER, "--projectId", pid, "--output", "json"]).await else { continue };
        if let Some(cluster) = u["description"].as_str().and_then(|d| d.strip_prefix(DESC)) {
            return link(&app, &state, pid, cluster).await.map(Some);
        }
    }
    Ok(None)
}
