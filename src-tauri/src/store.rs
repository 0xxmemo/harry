//! Harry's own state, one JSON file per collection, owned by Rust so the action gate reads the
//! same records the UI approved. Collection names mirror the Atlas data model in PLAN.md.

use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub const COLLECTIONS: &[&str] = &[
    "settings", "outbox", "interactions", "runs", "calls", "insights", "playbooks", "evals", "llm_cache", "optouts", "traces",
];

#[derive(Default)]
pub struct Store {
    lock: Mutex<()>,
}

fn dir(app: &AppHandle) -> PathBuf {
    let d = app.path().app_data_dir().unwrap_or_else(|_| crate::cli::home().join(".harry")).join("store");
    let _ = std::fs::create_dir_all(&d);
    d
}

fn check(coll: &str) -> Result<(), String> {
    if COLLECTIONS.contains(&coll) { Ok(()) } else { Err(format!("unknown collection {coll}")) }
}

pub fn read(app: &AppHandle, coll: &str) -> Vec<Value> {
    std::fs::read_to_string(dir(app).join(format!("{coll}.json")))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write(app: &AppHandle, coll: &str, docs: &[Value]) -> Result<(), String> {
    let d = dir(app);
    let tmp = d.join(format!("{coll}.json.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(docs).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, d.join(format!("{coll}.json"))).map_err(|e| e.to_string())
}

pub fn get(app: &AppHandle, coll: &str, id: &str) -> Option<Value> {
    read(app, coll).into_iter().find(|d| d["_id"] == id)
}

/// Merge `patch` into the document with the same `_id` (insert if missing).
pub fn upsert(app: &AppHandle, store: &Store, coll: &str, patch: Value) -> Result<Value, String> {
    check(coll)?;
    let _g = store.lock.lock().unwrap();
    let id = patch["_id"].as_str().ok_or("document needs a string _id")?.to_string();
    let mut docs = read(app, coll);
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
    write(app, coll, &docs)?;
    Ok(merged)
}

#[tauri::command]
pub fn store_list(app: AppHandle, coll: String) -> Result<Vec<Value>, String> {
    check(&coll)?;
    Ok(read(&app, &coll))
}

#[tauri::command]
pub fn store_upsert(app: AppHandle, store: State<'_, Store>, coll: String, doc: Value) -> Result<Value, String> {
    if coll == "outbox" && doc.get("status").is_some_and(|s| s == "approved" || s == "sending" || s == "sent") {
        return Err("Outbox status can only be advanced by approve/send".into());
    }
    if coll == "outbox" && doc.get("approvedHash").is_some() {
        return Err("approvedHash is set by approval only".into());
    }
    upsert(&app, &store, &coll, doc)
}

#[tauri::command]
pub fn store_reset(app: AppHandle, store: State<'_, Store>, colls: Vec<String>) -> Result<(), String> {
    let _g = store.lock.lock().unwrap();
    for c in colls {
        check(&c)?;
        write(&app, &c, &[])?;
    }
    Ok(())
}

pub fn settings(app: &AppHandle) -> Value {
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
    let mut s = get(app, "settings", "settings").unwrap_or_else(|| defaults.clone());
    for (k, v) in defaults.as_object().unwrap() {
        if s.get(k).is_none() {
            s[k] = v.clone();
        }
    }
    s
}
