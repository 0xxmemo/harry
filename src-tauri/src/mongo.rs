//! Reads from the user's cluster through `mongosh`. The connection string and pipeline are passed
//! in environment variables so they never show up in process listings.

use crate::{cli, gate, AppState};
use serde_json::Value;
use tauri::{AppHandle, State};

const SAMPLE_JS: &str = r#"
const c = new Mongo(process.env.HARRY_URI);
const skip = new Set(["admin", "local", "config"]);
const dbs = c.getDBNames().filter(n => !skip.has(n)).slice(0, 6);
const out = [];
for (const name of dbs) {
  const db = c.getDB(name);
  const colls = db.getCollectionNames().filter(n => !n.startsWith("system.")).slice(0, 15);
  out.push({ name, collections: colls.map(coll => ({
    name: coll,
    count: db.getCollection(coll).estimatedDocumentCount(),
    samples: db.getCollection(coll).aggregate([{ $sample: { size: 20 } }], { maxTimeMS: 10000 }).toArray(),
  })) });
}
print(EJSON.stringify(out, { relaxed: true }));
"#;

const AGG_JS: &str = r#"
const db = new Mongo(process.env.HARRY_URI).getDB(process.env.HARRY_DB);
const pipeline = EJSON.parse(process.env.HARRY_PIPELINE);
const rows = db.getCollection(process.env.HARRY_COLL).aggregate(pipeline, { maxTimeMS: 15000 }).toArray();
print(EJSON.stringify(rows, { relaxed: true }));
"#;

fn uri(state: &State<'_, AppState>) -> Result<String, String> {
    state.uri.lock().unwrap().clone().ok_or_else(|| "Not connected to a cluster".into())
}

async fn eval(app: &AppHandle, js: &str, envs: &[(&str, &str)]) -> Result<Value, String> {
    let out = cli::run(app, "mongosh", "mongosh", &["--nodb", "--quiet", "--eval", js], envs, None, false).await?;
    if !out.ok() {
        return Err(out.err_text());
    }
    let last = out.stdout.lines().rev().find(|l| l.starts_with('[') || l.starts_with('{')).unwrap_or("[]");
    serde_json::from_str(last).map_err(|e| format!("could not parse mongosh output: {e}"))
}

#[tauri::command]
pub fn mongo_set_uri(state: State<'_, AppState>, uri: String) -> Result<(), String> {
    let uri = uri.trim().to_string();
    if !(uri.starts_with("mongodb://") || uri.starts_with("mongodb+srv://")) {
        return Err("Connection strings start with mongodb:// or mongodb+srv://".into());
    }
    *state.uri.lock().unwrap() = Some(uri);
    Ok(())
}

#[tauri::command]
pub fn mongo_disconnect(state: State<'_, AppState>) {
    *state.uri.lock().unwrap() = None;
}

#[tauri::command]
pub async fn mongo_sample(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let uri = uri(&state)?;
    eval(&app, SAMPLE_JS, &[("HARRY_URI", &uri)]).await
}

#[tauri::command]
pub async fn mongo_aggregate(
    app: AppHandle,
    state: State<'_, AppState>,
    db: String,
    collection: String,
    pipeline: Value,
) -> Result<Value, String> {
    let checked = gate::check_pipeline(&pipeline).map_err(|e| format!("Policy gate: {e}"))?;
    let uri = uri(&state)?;
    let p = checked.to_string();
    eval(&app, AGG_JS, &[("HARRY_URI", &uri), ("HARRY_DB", &db), ("HARRY_COLL", &collection), ("HARRY_PIPELINE", &p)]).await
}
