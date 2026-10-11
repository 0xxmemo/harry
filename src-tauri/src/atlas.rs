//! Atlas account and cluster operations, all through the official `atlas` CLI.

use crate::store;
use crate::cli;
use crate::AppState;
use rand::{distributions::Alphanumeric, Rng};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
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

/// Makes `cluster` Harry's database: a single `harry` user that can read and write
/// only the `harry` database and nothing else on the cluster,
/// whose description records the cluster, so the next launch can find it through the Atlas CLI.
/// The working connection string is saved in a file in Harry's app data folder that only the
/// current user can read (no keychain, so no password prompts). Later launches reconnect
/// immediately instead of rotating the password and waiting for Atlas to propagate it.
/// Bumped when the user's role changes, so saved credentials from an older role re-link once
/// (which updates the role) instead of being reused.
const SCOPE: &str = "harry-only";

fn link_file(app: &AppHandle) -> std::path::PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| crate::cli::home().join(".harry")).join("atlas-link.json")
}

fn saved(app: &AppHandle) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(link_file(app)).ok()?).ok()
}

fn save(app: &AppHandle, project_id: &str, cluster: &str, uri: &str, host: &str) {
    let path = link_file(app);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::json!({ "scope": SCOPE, "project": project_id, "cluster": cluster, "uri": uri, "host": host }).to_string();
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    if let Ok(mut f) = opts.open(&path) {
        let _ = std::io::Write::write_all(&mut f, body.as_bytes());
    }
}

/// Reconnect with the saved credentials if they are for `cluster` (or any cluster when None).
async fn reuse(app: &AppHandle, state: &State<'_, AppState>, cluster: Option<&str>) -> Option<Connected> {
    let s = saved(app)?;
    if s["scope"].as_str() != Some(SCOPE) {
        return None;
    }
    if cluster.is_some_and(|c| s["cluster"].as_str() != Some(c)) {
        return None;
    }
    let (uri, host) = (s["uri"].as_str()?, s["host"].as_str()?);
    store::connect(app, uri).await.ok()?;
    *state.uri.lock().unwrap() = Some(uri.to_string());
    crate::files::restore_roots(app).await;
    Some(Connected { username: USER.into(), host: host.into() })
}

async fn link(app: &AppHandle, state: &State<'_, AppState>, project_id: &str, cluster: &str) -> Result<Connected, String> {
    // Each link rotates the password, so two overlapping links (launch restore, post-sign-in
    // restore, Connect button) would invalidate each other's credentials. Run one at a time.
    static LINKING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LINKING.lock().await;
    if let Some(c) = reuse(app, state, Some(cluster)).await {
        return Ok(c);
    }
    let log = "atlas-connect";
    let password = new_password();
    let desc = format!("{DESC}{cluster}");
    let role = "readWrite@harry";
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
    // A new user or password change takes a while to propagate; only auth failures are worth retrying.
    let mut last = String::new();
    for _ in 0..40 {
        match store::connect(app, &uri).await {
            Ok(()) => { last.clear(); break; }
            Err(e) if e.contains("Authentication failed") => { last = e; tokio::time::sleep(std::time::Duration::from_secs(2)).await; }
            Err(e) => return Err(e),
        }
    }
    if !last.is_empty() {
        return Err(last);
    }
    save(app, project_id, cluster, &uri, &host);
    *state.uri.lock().unwrap() = Some(uri);
    crate::files::restore_roots(app).await;
    Ok(Connected { username: USER.into(), host })
}

#[tauri::command]
pub async fn atlas_connect(app: AppHandle, state: State<'_, AppState>, project_id: String, cluster: String) -> Result<Connected, String> {
    link(&app, &state, &project_id, &cluster).await
}

/// On launch or right after sign-in: reconnect to the cluster Harry was linked to (via the `harry`
/// user's description). If nothing was linked yet, link the first cluster found so the user never
/// has a separate "connect the store" step. Returns None when not signed in or there are no clusters.
#[tauri::command]
pub async fn atlas_restore(app: AppHandle, state: State<'_, AppState>) -> Result<Option<Connected>, String> {
    if let Some(host) = app.state::<store::Store>().db.read().await.as_ref().map(|(_, h)| h.clone()) {
        return Ok(Some(Connected { username: USER.into(), host }));
    }
    if let Some(c) = reuse(&app, &state, None).await {
        return Ok(Some(c));
    }
    let Ok(v) = atlas_json(&app, &["projects", "list", "--output", "json"]).await else { return Ok(None) };
    let projects = v.get("results").cloned().unwrap_or(v).as_array().cloned().unwrap_or_default();
    let ids: Vec<String> = projects.iter().filter_map(|p| p["id"].as_str().map(String::from)).collect();
    for pid in &ids {
        let Ok(u) = atlas_json(&app, &["dbusers", "describe", USER, "--projectId", pid, "--output", "json"]).await else { continue };
        if let Some(cluster) = u["description"].as_str().and_then(|d| d.strip_prefix(DESC)) {
            return link(&app, &state, pid, cluster).await.map(Some);
        }
    }
    for pid in &ids {
        let Ok(v) = atlas_json(&app, &["clusters", "list", "--projectId", pid, "--output", "json"]).await else { continue };
        let clusters = v.get("results").cloned().unwrap_or(v);
        if let Some(name) = clusters.as_array().and_then(|c| c.first()).and_then(|c| c["name"].as_str()) {
            return link(&app, &state, pid, name).await.map(Some);
        }
    }
    Ok(None)
}
