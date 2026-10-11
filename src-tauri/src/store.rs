//! Harry's own state, persisted only in MongoDB (database `harry`, one collection each) and owned
//! by Rust so the action gate reads the same records the UI approved. Nothing is kept on disk.

use futures_util::TryStreamExt;
use mongodb::bson::{self, doc, Bson, Document};
use mongodb::options::{ClientOptions, ReturnDocument};
use mongodb::{Client, Database};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

pub const COLLECTIONS: &[&str] = &[
    "settings", "outbox", "interactions", "runs", "calls", "insights", "playbooks", "evals", "llm_cache", "optouts", "traces", "memory", "grants", "sync",
    // CRM records mirrored from Composio, keyed by the provider's id so re-syncs never duplicate.
    "crm_accounts", "crm_contacts", "crm_reps", "crm_deals", "crm_activities",
];
const DB: &str = "harry";

#[derive(Default)]
pub struct Store {
    pub(crate) db: RwLock<Option<(Database, String)>>,
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

/// Connect the persistent store. Only ever called with a URI built from the Atlas CLI.
pub async fn connect(app: &AppHandle, uri: &str) -> Result<(), String> {
    let mut opts = ClientOptions::parse(uri).await.map_err(|e| e.to_string())?;
    opts.app_name = Some("harry".into());
    opts.server_selection_timeout = Some(std::time::Duration::from_secs(8));
    let client = Client::with_options(opts).map_err(|e| e.to_string())?;
    let db = client.database(DB);
    db.run_command(doc! { "ping": 1 }).await.map_err(|e| format!("Could not reach the cluster: {e}"))?;
    let host = uri.split('@').next_back().unwrap_or("").split(['/', '?']).next().unwrap_or("").to_string();
    *app.state::<Store>().db.write().await = Some((db, host));
    Ok(())
}

const NOT_CONNECTED: &str = "Connect MongoDB Atlas first: Harry keeps all of its data there";

async fn database(app: &AppHandle) -> Result<Database, String> {
    app.state::<Store>().db.read().await.as_ref().map(|(d, _)| d.clone()).ok_or_else(|| NOT_CONNECTED.into())
}

pub async fn read(app: &AppHandle, coll: &str) -> Result<Vec<Value>, String> {
    let cur = database(app).await?.collection::<Document>(coll).find(doc! {}).await.map_err(|e| e.to_string())?;
    Ok(cur.try_collect::<Vec<_>>().await.map_err(|e| e.to_string())?.into_iter().map(to_value).collect())
}

pub async fn get(app: &AppHandle, coll: &str, id: &str) -> Result<Option<Value>, String> {
    let d = database(app).await?.collection::<Document>(coll).find_one(doc! { "_id": id }).await.map_err(|e| e.to_string())?;
    Ok(d.map(to_value))
}

/// Merge `patch` into the document with the same `_id` (insert if missing).
pub async fn upsert(app: &AppHandle, coll: &str, patch: Value) -> Result<Value, String> {
    check(coll)?;
    let id = patch["_id"].as_str().ok_or("document needs a string _id")?.to_string();
    let db = database(app).await?;
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
    Ok(to_value(d))
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
    read(&app, &coll).await
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
    let db = database(&app).await?;
    for c in colls {
        db.collection::<Document>(&c).delete_many(doc! {}).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Mirror a provider's record set into a `crm_*` collection: replace each record by `_id` and drop
/// records the provider no longer has, so the collection always equals the latest sync.
#[tauri::command]
pub async fn store_mirror(app: AppHandle, coll: String, docs: Vec<Value>) -> Result<usize, String> {
    check(&coll)?;
    if !coll.starts_with("crm_") {
        return Err("only crm_* collections can be mirrored".into());
    }
    let c = database(&app).await?.collection::<Document>(&coll);
    let docs = docs.iter().map(to_doc).collect::<Result<Vec<_>, _>>()?;
    let ids = docs.iter().map(|d| d.get_str("_id").map(str::to_string).map_err(|_| "document needs a string _id".to_string())).collect::<Result<Vec<_>, _>>()?;
    let writes: Vec<_> = docs
        .into_iter()
        .zip(ids.clone())
        .map(|(d, id)| {
            let c = c.clone();
            tokio::spawn(async move { c.replace_one(doc! { "_id": id }, d).upsert(true).await.map(|_| ()).map_err(|e| e.to_string()) })
        })
        .collect();
    for w in writes {
        w.await.map_err(|e| e.to_string())??;
    }
    c.delete_many(doc! { "_id": { "$nin": &ids } }).await.map_err(|e| e.to_string())?;
    Ok(ids.len())
}

pub async fn settings(app: &AppHandle) -> Result<Value, String> {
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
    let mut s = get(app, "settings", "settings").await?.unwrap_or_else(|| defaults.clone());
    for (k, v) in defaults.as_object().unwrap() {
        if s.get(k).is_none() {
            s[k] = v.clone();
        }
    }
    Ok(s)
}
