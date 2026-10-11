//! Local folders the user explicitly granted. Every read is re-checked against the granted roots
//! after resolving symlinks, so nothing outside them is reachable.

use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

const EXTS: &[&str] = &["csv", "tsv", "json", "md", "txt", "vtt", "srt", "docx"];
const MAX_BYTES: u64 = 5 * 1024 * 1024;
const MAX_FILES: usize = 400;

#[derive(Serialize)]
pub struct FileEntry {
    path: String,
    rel: String,
    ext: String,
    size: u64,
}

fn denied(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with('.')
        || n.contains("secret")
        || n.contains("credential")
        || n.ends_with(".pem")
        || n.ends_with(".key")
        || n == "node_modules"
        || n == "target"
}

async fn persist(app: &AppHandle, roots: &[PathBuf]) -> Result<(), String> {
    let v: Vec<String> = roots.iter().map(|p| p.to_string_lossy().into()).collect();
    crate::store::upsert(app, "grants", json!({ "_id": "roots", "paths": v })).await.map(|_| ())
}

/// Load folder grants saved in MongoDB, once the store is connected.
pub async fn restore_roots(app: &AppHandle) {
    let paths = crate::store::get(app, "grants", "roots").await.ok().flatten();
    let roots: Vec<PathBuf> = paths
        .and_then(|d| d["paths"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.as_str().map(PathBuf::from))
        .filter(|p| p.is_dir())
        .collect();
    *app.state::<AppState>().roots.lock().unwrap() = roots;
}

#[tauri::command]
pub fn list_roots(state: State<'_, AppState>) -> Vec<String> {
    state.roots.lock().unwrap().iter().map(|p| p.to_string_lossy().into()).collect()
}

#[tauri::command]
pub async fn grant_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !p.is_dir() {
        return Err("Not a folder".into());
    }
    if p == crate::cli::home() || p == Path::new("/") {
        return Err("Pick a specific folder, not your whole home directory".into());
    }
    let roots = {
        let mut roots = state.roots.lock().unwrap();
        if !roots.contains(&p) {
            roots.push(p);
        }
        roots.clone()
    };
    persist(&app, &roots).await?;
    Ok(roots.iter().map(|p| p.to_string_lossy().into()).collect())
}

#[tauri::command]
pub async fn revoke_folder(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Vec<String>, String> {
    let roots = {
        let mut roots = state.roots.lock().unwrap();
        roots.retain(|r| r.to_string_lossy() != path);
        roots.clone()
    };
    persist(&app, &roots).await?;
    Ok(roots.iter().map(|p| p.to_string_lossy().into()).collect())
}

pub fn within_roots(state: &State<'_, AppState>, path: &str) -> Result<PathBuf, String> {
    let p = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let roots = state.roots.lock().unwrap();
    let rel = roots
        .iter()
        .find_map(|r| p.strip_prefix(r).ok())
        .ok_or("That file is outside the folders you granted")?;
    if rel.components().any(|c| denied(&c.as_os_str().to_string_lossy())) {
        return Err("Hidden and secret files are never read".into());
    }
    Ok(p)
}

#[tauri::command]
pub fn scan_folder(state: State<'_, AppState>, root: String) -> Result<Vec<FileEntry>, String> {
    let root = within_roots(&state, &root)?;
    let mut out = vec![];
    let mut stack = vec![(root.clone(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if denied(&name) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(e.path()) else { continue };
            let path = e.path();
            if meta.is_dir() {
                if depth < 4 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let ext = path.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if !EXTS.contains(&ext.as_str()) || meta.len() > MAX_BYTES {
                continue;
            }
            // Resolved target must still live inside the granted root (symlink escape check).
            let Ok(real) = std::fs::canonicalize(&path) else { continue };
            if !real.starts_with(&root) {
                continue;
            }
            out.push(FileEntry {
                rel: path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().into(),
                path: real.to_string_lossy().into(),
                ext,
                size: meta.len(),
            });
            if out.len() >= MAX_FILES {
                return Ok(out);
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[tauri::command]
pub fn read_source(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let p = within_roots(&state, &path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err("File is larger than 5 MB".into());
    }
    std::fs::read_to_string(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn mem_load(app: AppHandle) -> Result<Value, String> {
    Ok(crate::store::get(&app, "memory", "memory").await?.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn mem_save(app: AppHandle, memory: Value) -> Result<(), String> {
    let mut m = memory;
    m["_id"] = json!("memory");
    crate::store::upsert(&app, "memory", m).await.map(|_| ())
}

