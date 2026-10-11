//! Harry's own state, persisted in MongoDB (database `harry`, one collection each) and owned by
//! Rust so the action gate reads the same records the UI approved. Until a cluster is connected,
//! documents live in local JSON files; connecting migrates them into MongoDB.

use futures_util::TryStreamExt;
use mongodb::bson::{self, doc, Bson, Document};
use mongodb::options::{ClientOptions, ReturnDocument};
use mongodb::{Client, Database};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tokio::sync::{Mutex, RwLock};

pub const COLLECTIONS: &[&str] = &[
    "settings", "outbox", "interactions", "runs", "calls", "insights", "playbooks", "evals", "llm_cache", "optouts", "traces",
];
const DB: &str = "harry";

#[derive(Default)]
pub struct Store {
    lock: Mutex<()>,
    db: RwLock<Option<(Database, String)>>,
}

fn dir(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().unwrap_or_else(|_| crate::cli::home().join(".harry")).join("store");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn check(coll: &str) -> Result<(), String> {
    if COLLECTIONS.contains(&coll) { Ok(()) } else { Err(format!("unknown collection {coll}")) }
}

fn to_value(d: Document) -> Value {
    Bson::Document(d).into_relaxed_extjson()
}

fn to_doc(v: &Value) -> Result<Document, String> {
    bson::to_document(v).map_err(|e| e.to_string())
}

fn read_file(app: &AppHandle, coll: &str) -> Vec<Value> {
    std::fs::read_to_string(dir(app).join(format!("{coll}.json")))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_file(app: &AppHandle, coll: &str, docs: &[Value]) -> Result<(), String> {
    let d = dir(app);
    let tmp = d.join(format!("{coll}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(docs).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, d.join(format!("{coll}.json"))).map_err(|e| e.to_string())
}

fn uri_file(app: &AppHandle) -> PathBuf {
    dir(app).join("cluster.uri")
}

/// Connect the persistent store, migrate any local documents into it, and remember the URI.
pub async fn connect(app: &AppHandle, uri: &str) -> Result<(), String> {
    let mut opts = ClientOptions::parse(uri).await.map_err(|e| e.to_string())?;
    opts.app_name = Some("harry".into());
    opts.server_selection_timeout = Some(std::time::Duration::from_secs(8));
    let client = Client::with_options(opts).map_err(|e| e.to_string())?;
    let db = client.database(DB);
    db.run_command(doc! { "ping": 1 }).await.map_err(|e| format!("Could not reach the cluster: {e}"))?;
    let host = uri.split('@').next_back().unwrap_or("").split(['/', '?']).next().unwrap_or("").to_string();

    let store = app.state::<Store>();
    let _g = store.lock.lock().await;
    for coll in COLLECTIONS {
        let local = read_file(app, coll);
        for d in &local {
            if let Some(id) = d["_id"].as_str() {
                let mut set = to_doc(d)?;
                set.remove("_id");
                db.collection::<Document>(coll).update_one(doc! { "_id": id }, doc! { "$set": set }).upsert(true).await.map_err(|e| e.to_string())?;
            }
        }
        if !local.is_empty() {
            let _ = std::fs::remove_file(dir(app).join(format!("{coll}.json")));
        }
    }
    *store.db.write().await = Some((db, host));
    write_private(&uri_file(app), uri)
}

fn write_private(path: &PathBuf, text: &str) -> Result<(), String> {
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The cluster URI saved by a previous `connect`, if any.
pub fn saved_uri(app: &AppHandle) -> Option<String> {
    std::fs::read_to_string(uri_file(app)).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

async fn database(app: &AppHandle) -> Option<Database> {
    app.state::<Store>().db.read().await.as_ref().map(|(d, _)| d.clone())
}

pub async fn read(app: &AppHandle, coll: &str) -> Vec<Value> {
    match database(app).await {
        Some(db) => match db.collection::<Document>(coll).find(doc! {}).await {
            Ok(cur) => cur.try_collect::<Vec<_>>().await.unwrap_or_default().into_iter().map(to_value).collect(),
            Err(_) => vec![],
        },
        None => read_file(app, coll),
    }
}

pub async fn get(app: &AppHandle, coll: &str, id: &str) -> Option<Value> {
    match database(app).await {
        Some(db) => db.collection::<Document>(coll).find_one(doc! { "_id": id }).await.ok().flatten().map(to_value),
        None => read_file(app, coll).into_iter().find(|d| d["_id"] == id),
    }
}

/// Merge `patch` into the document with the same `_id` (insert if missing).
pub async fn upsert(app: &AppHandle, coll: &str, patch: Value) -> Result<Value, String> {
    check(coll)?;
    let id = patch["_id"].as_str().ok_or("document needs a string _id")?.to_string();
    if let Some(db) = database(app).await {
        let mut set = to_doc(&patch)?;
        set.remove("_id");
        let update = if set.is_empty() { doc! { "$setOnInsert": { "_id": &id } } } else { doc! { "$set": set } };
        let d = db
            .collection::<Document>(coll)
            .find_one_and_update(doc! { "_id": &id }, update)
            .upsert(true)
            .return_document(ReturnDocument::After)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("upsert returned nothing")?;
        return Ok(to_value(d));
    }
    let store = app.state::<Store>();
    let _g = store.lock.lock().await;
    let mut docs = read_file(app, coll);
    let merged = match docs.iter_mut().find(|d| d["_id"] == id.as_str()) {
        Some(existing) => {
            let obj: &mut Map<String, Value> = existing.as_object_mut().unwrap();
            for (k, v) in patch.as_object().unwrap() {
                obj.insert(k.clone(), v.clone());
            }
            existing.clone()
        }
        None => {
            docs.push(patch.clone());
            patch
        }
    };
    write_file(app, coll, &docs)?;
    Ok(merged)
}

#[derive(Serialize)]
pub struct StoreStatus {
    persistent: bool,
    host: Option<String>,
}

#[tauri::command]
pub async fn store_status(store: State<'_, Store>) -> Result<StoreStatus, String> {
    let host = store.db.read().await.as_ref().map(|(_, h)| h.clone());
    Ok(StoreStatus { persistent: host.is_some(), host })
}

#[tauri::command]
pub async fn store_list(app: AppHandle, coll: String) -> Result<Vec<Value>, String> {
    check(&coll)?;
    Ok(read(&app, &coll).await)
}

#[tauri::command]
pub async fn store_upsert(app: AppHandle, coll: String, doc: Value) -> Result<Value, String> {
    if coll == "outbox" && doc.get("status").is_some_and(|s| s == "approved" || s == "sending" || s == "sent") {
        return Err("Outbox status can only be advanced by approve/send".into());
    }
    if coll == "outbox" && doc.get("approvedHash").is_some() {
        return Err("approvedHash is set by approval only".into());
    }
    upsert(&app, &coll, doc).await
}

#[tauri::command]
pub async fn store_reset(app: AppHandle, colls: Vec<String>) -> Result<(), String> {
    for c in &colls {
        check(c)?;
    }
    if let Some(db) = database(&app).await {
        for c in colls {
            db.collection::<Document>(&c).delete_many(doc! {}).await.map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let store = app.state::<Store>();
    let _g = store.lock.lock().await;
    for c in colls {
        write_file(&app, &c, &[])?;
    }
    Ok(())
}

pub async fn settings(app: &AppHandle) -> Value {
    let defaults = json!({
        "_id": "settings",
        "demoMode": true,
        "allowlist": [],
        "perContactPerWeek": 2,
        "perMailboxPerDay": 20,
        "businessHours": true,
        "autoSend": {},
        "mailToolkit": "gmail",
    });
    let mut s = get(app, "settings", "settings").await.unwrap_or_else(|| defaults.clone());
    for (k, v) in defaults.as_object().unwrap() {
        if s.get(k).is_none() {
            s[k] = v.clone();
        }
    }
    s
}
