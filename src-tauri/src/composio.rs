//! Composio is Harry's single integration layer (email, CRM, calendar), using the user's own
//! Composio account through the `composio` CLI. Every action goes through `gate::check_action`
//! first; sends additionally require an approved, unmodified outbox item.

use crate::cli;
use crate::gate;
use crate::store;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Serialize)]
pub struct ComposioStatus {
    installed: bool,
    logged_in: bool,
    connections: Value,
}

fn logged_in() -> bool {
    std::fs::read_to_string(cli::home().join(".composio/user_data.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .is_some_and(|v| v["api_key"].as_str().is_some_and(|k| !k.is_empty()))
}

/// Pulls the last JSON object/array out of CLI output (ignoring hints and banners).
pub fn parse_json(text: &str) -> Option<Value> {
    let start = text.find(['{', '['])?;
    serde_json::from_str(text[start..].trim()).ok().or_else(|| {
        text.lines().rev().find_map(|l| {
            let t = l.trim();
            (t.starts_with('{') || t.starts_with('[')).then(|| serde_json::from_str(t).ok()).flatten()
        })
    })
}

#[tauri::command]
pub async fn composio_status(app: AppHandle) -> ComposioStatus {
    let installed = cli::resolve(&app, "composio").is_some();
    let logged_in = installed && logged_in();
    let connections = if logged_in {
        match cli::run(&app, "composio", "composio", &["connections", "list"], &[], None, false).await {
            Ok(o) if o.ok() => parse_json(&o.stdout).unwrap_or(Value::Null),
            _ => Value::Null,
        }
    } else {
        Value::Null
    };
    ComposioStatus { installed, logged_in, connections }
}

/// Spawn a composio command that prints a browser URL, open it, and wait for the command to finish.
async fn browser_flow(app: &AppHandle, event: &str, args: &[&str], timeout_s: u64) -> Result<String, String> {
    let bin = cli::resolve(app, "composio").ok_or("Composio CLI is not installed")?;
    let mut child = Command::new(bin)
        .args(args)
        .env("PATH", cli::search_path(app))
        .env("NO_COLOR", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let url_re = Regex::new(r"https://\S+").unwrap();
    let ansi = Regex::new(r"\x1b\[[0-9;]*m").unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut transcript = String::new();
    let mut opened = false;
    let res = tokio::time::timeout(std::time::Duration::from_secs(timeout_s), async {
        loop {
            let line = tokio::select! {
                l = out.next_line() => l,
                l = err.next_line() => l,
            };
            let Ok(Some(line)) = line else { break };
            let line = ansi.replace_all(&line, "").to_string();
            transcript.push_str(&line);
            transcript.push('\n');
            if !opened {
                if let Some(m) = url_re.find(&line) {
                    let url = m.as_str().trim_end_matches(['.', ')']).to_string();
                    let _ = app.opener().open_url(&url, None::<&str>);
                    let _ = app.emit(event, url);
                    opened = true;
                }
            }
        }
        child.wait().await
    })
    .await;
    match res {
        Ok(Ok(s)) if s.success() => Ok(transcript),
        Ok(_) => Err(transcript.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("Composio command failed").to_string()),
        Err(_) => Err("Timed out waiting for the browser step".into()),
    }
}

#[tauri::command]
pub async fn composio_login(app: AppHandle) -> Result<(), String> {
    // `login --no-browser` prints the URL and caches a login key; `login --poll` waits for completion.
    let first = browser_flow(&app, "composio-url", &["login", "--no-browser"], 30).await;
    if logged_in() {
        return Ok(());
    }
    first?;
    browser_flow(&app, "composio-url", &["login", "--poll"], 600).await?;
    if logged_in() { Ok(()) } else { Err("Composio login did not complete".into()) }
}

#[tauri::command]
pub async fn composio_logout(app: AppHandle) -> Result<(), String> {
    let o = cli::run(&app, "composio", "composio", &["logout"], &[], None, false).await?;
    if o.ok() { Ok(()) } else { Err(o.err_text()) }
}

#[tauri::command]
pub async fn composio_link(app: AppHandle, toolkit: String) -> Result<(), String> {
    if !gate::LINKABLE.contains(&toolkit.as_str()) {
        return Err(format!("{toolkit} is not a toolkit Harry uses"));
    }
    browser_flow(&app, "composio-url", &["link", &toolkit], 600).await.map(|_| ())
}

/// Read-only or note/task actions (fetch email, read CRM, read calendar). Sends use `outbox_send`.
pub async fn execute(app: &AppHandle, slug: &str, data: &Value) -> Result<Value, String> {
    gate::check_action(slug)?;
    let body = data.to_string();
    let o = cli::run(app, "composio", "composio", &["execute", slug, "-d", "-"], &[("NO_COLOR", "1")], Some(&body), false).await?;
    let parsed = parse_json(&o.stdout).or_else(|| parse_json(&o.stderr));
    if !o.ok() {
        return Err(format!("{slug}: {}", o.err_text()));
    }
    let mut v = parsed.ok_or_else(|| format!("{slug}: unexpected output"))?;
    // Large responses are written to disk and only the path is printed.
    if v.get("storedInFile") == Some(&Value::Bool(true)) {
        if let Some(stored) = v["outputFilePath"].as_str().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|s| parse_json(&s)) {
            v = stored;
        }
    }
    if v.get("successful") == Some(&Value::Bool(false)) || v.get("error").is_some_and(|e| !e.is_null()) {
        return Err(format!("{slug}: {}", v.get("error").map(|e| e.to_string()).unwrap_or_default()));
    }
    Ok(v)
}

#[tauri::command]
pub async fn composio_execute(app: AppHandle, slug: String, data: Value) -> Result<Value, String> {
    if gate::SEND_ACTIONS.contains(&slug.as_str()) {
        return Err("Sending only happens through the approved outbox".into());
    }
    execute(&app, &slug, &data).await
}

pub fn content_hash(item: &Value) -> String {
    let mut h = Sha256::new();
    for k in ["to", "subject", "body", "threadId"] {
        h.update(item[k].as_str().unwrap_or_default().as_bytes());
        h.update([0u8]);
    }
    hex::encode(h.finalize())
}

/// Human approval: freezes the exact content that may be sent.
#[tauri::command]
pub async fn outbox_approve(app: AppHandle, id: String) -> Result<Value, String> {
    let item = store::get(&app, "outbox", &id).await?.ok_or("outbox item not found")?;
    if item["status"] != "draft" {
        return Err(format!("item is {}, not a draft", item["status"]));
    }
    gate::check_message(&item, &store::settings(&app).await?)?;
    store::upsert(&app, "outbox", json!({
        "_id": id, "status": "approved", "approvedHash": content_hash(&item),
        "approvedAt": chrono::Utc::now().to_rfc3339(),
    })).await
}

fn find_str(v: &Value, keys: &[&str]) -> Option<String> {
    match v {
        Value::Object(o) => {
            for k in keys {
                if let Some(s) = o.get(*k).and_then(Value::as_str) {
                    return Some(s.to_string());
                }
            }
            o.values().find_map(|x| find_str(x, keys))
        }
        Value::Array(a) => a.iter().find_map(|x| find_str(x, keys)),
        _ => None,
    }
}

/// Was this item already delivered? Used when resuming after a crash mid-send.
async fn already_sent(app: &AppHandle, item: &Value) -> bool {
    let q = format!("in:sent to:{} subject:\"{}\" newer_than:3d", item["to"].as_str().unwrap_or(""), item["subject"].as_str().unwrap_or("").replace('"', ""));
    match execute(app, "GMAIL_FETCH_EMAILS", &json!({ "query": q, "max_results": 3 })).await {
        Ok(v) => find_str(&v, &["threadId", "thread_id", "messageId", "id"]).is_some(),
        Err(_) => false,
    }
}

#[tauri::command]
pub async fn outbox_send(app: AppHandle, id: String) -> Result<Value, String> {
    let item = store::get(&app, "outbox", &id).await?.ok_or("outbox item not found")?;
    let status = item["status"].as_str().unwrap_or("");
    if status == "sent" {
        return Ok(item);
    }
    if status != "approved" && status != "sending" {
        return Err("Only approved items can be sent".into());
    }
    if item["approvedHash"].as_str() != Some(content_hash(&item).as_str()) {
        return Err("The message changed after approval; approve it again".into());
    }
    let settings = store::settings(&app).await?;
    gate::check_message(&item, &settings)?;
    gate::check_caps(&item, &store::read(&app, "outbox").await?, &store::read(&app, "optouts").await?, &settings)?;

    if status == "sending" && already_sent(&app, &item).await {
        return store::upsert(&app, "outbox", json!({ "_id": id, "status": "sent", "recoveredAfterCrash": true })).await;
    }
    store::upsert(&app, "outbox", json!({ "_id": id, "status": "sending", "sendingAt": chrono::Utc::now().to_rfc3339() })).await?;

    let thread = item["threadId"].as_str().filter(|t| !t.is_empty());
    let (slug, data) = match thread {
        Some(t) => ("GMAIL_REPLY_TO_THREAD", json!({ "thread_id": t, "recipient_email": item["to"], "message_body": item["body"] })),
        None => ("GMAIL_SEND_EMAIL", json!({ "recipient_email": item["to"], "subject": item["subject"], "body": item["body"] })),
    };
    gate::check_send_action(slug)?;
    let body = data.to_string();
    let o = cli::run(&app, "composio-send", "composio", &["execute", slug, "-d", "-"], &[("NO_COLOR", "1")], Some(&body), false).await?;
    let parsed = parse_json(&o.stdout);
    let failed = !o.ok() || parsed.as_ref().is_some_and(|v| v.get("successful") == Some(&Value::Bool(false)));
    if failed {
        // Leave it in `sending`: the next attempt checks Sent before retrying, so nothing goes out twice.
        let msg = parsed.as_ref().and_then(|v| v.get("error")).map(|e| e.to_string()).unwrap_or_else(|| o.err_text());
        return Err(format!("Send failed: {msg}"));
    }
    let v = parsed.unwrap_or(Value::Null);
    store::upsert(&app, "outbox", json!({
        "_id": id, "status": "sent", "sentAt": chrono::Utc::now().to_rfc3339(),
        "threadId": find_str(&v, &["threadId", "thread_id"]).or(thread.map(String::from)),
        "messageId": find_str(&v, &["id", "messageId", "message_id"]),
    })).await
}

/// Pull replies for sent threads into `interactions`. Returns the new interactions.
#[tauri::command]
pub async fn fetch_replies(app: AppHandle) -> Result<Vec<Value>, String> {
    let sent: Vec<Value> = store::read(&app, "outbox").await?.into_iter().filter(|o| o["status"] == "sent").collect();
    let known: Vec<String> = store::read(&app, "interactions").await?.iter().filter_map(|i| i["messageId"].as_str().map(String::from)).collect();
    let mut added = vec![];
    for item in sent {
        let to = item["to"].as_str().unwrap_or_default();
        let q = format!("from:{to} newer_than:30d");
        let Ok(v) = execute(&app, "GMAIL_FETCH_EMAILS", &json!({ "query": q, "max_results": 10 })).await else { continue };
        let msgs = v.pointer("/data/messages").or_else(|| v.get("messages")).and_then(Value::as_array).cloned().unwrap_or_default();
        for m in msgs {
            let mid = find_str(&m, &["messageId", "id"]).unwrap_or_default();
            let tid = find_str(&m, &["threadId", "thread_id"]).unwrap_or_default();
            if mid.is_empty() || known.contains(&mid) {
                continue;
            }
            if let Some(t) = item["threadId"].as_str() {
                if !tid.is_empty() && tid != t {
                    continue;
                }
            }
            let text = find_str(&m, &["messageText", "snippet", "body", "preview"]).unwrap_or_default();
            let outcome = classify(&text);
            let doc = json!({
                "_id": format!("in-{mid}"), "direction": "in", "dealId": item["dealId"], "contactId": item["contactId"],
                "stage": item["stage"], "variant": item["variant"], "outboxId": item["_id"], "threadId": tid,
                "messageId": mid, "from": to, "text": text.chars().take(4000).collect::<String>(), "outcome": outcome,
                "at": chrono::Utc::now().to_rfc3339(),
            });
            store::upsert(&app, "interactions", doc.clone()).await?;
            if outcome == "unsubscribe" {
                store::upsert(&app, "optouts", json!({ "_id": to, "at": chrono::Utc::now().to_rfc3339() })).await?;
            }
            added.push(doc);
        }
    }
    Ok(added)
}

/// Deterministic outcome labels; the bandit and the simulator use the same ones.
pub fn classify(text: &str) -> &'static str {
    let t = text.to_lowercase();
    if Regex::new(r"unsubscribe|stop emailing|remove me|not interested").unwrap().is_match(&t) {
        "unsubscribe"
    } else if Regex::new(r"out of (the )?office|auto.?reply|on leave").unwrap().is_match(&t) {
        "auto_reply"
    } else if Regex::new(r"\b(call|meet|meeting|calendar|chat|demo|time|slot|tuesday|wednesday|thursday|monday|friday)\b").unwrap().is_match(&t) {
        "meeting_request"
    } else {
        "reply"
    }
}
