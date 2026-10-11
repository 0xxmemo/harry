mod atlas;
mod cli;
mod files;
mod gate;
mod llm;
mod mongo;
mod composio;
mod setup;
mod store;
mod transcript;

use std::path::PathBuf;
use std::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    /// Connection string for the current cluster. In memory only, never sent to the UI.
    pub uri: Mutex<Option<String>>,
    pub roots: Mutex<Vec<PathBuf>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .manage(store::Store::default())
        .invoke_handler(tauri::generate_handler![
            setup::tool_status,
            setup::auth_status,
            setup::install_tool,
            setup::openllm_set_key,
            atlas::atlas_login,
            atlas::atlas_logout,
            atlas::atlas_projects,
            atlas::atlas_clusters,
            atlas::atlas_connect,
            atlas::atlas_restore,
            mongo::mongo_disconnect,
            mongo::mongo_sample,
            mongo::mongo_aggregate,
            gate::gate_check,
            llm::llm_complete,
            files::list_roots,
            files::grant_folder,
            files::revoke_folder,
            files::scan_folder,
            files::read_source,
            files::mem_load,
            files::mem_save,
            composio::composio_status,
            composio::composio_login,
            composio::composio_logout,
            composio::composio_link,
            composio::composio_execute,
            composio::outbox_approve,
            composio::outbox_send,
            composio::fetch_replies,
            gate::gate_playbook,
            store::store_status,
            store::store_list,
            store::store_upsert,
            store::store_mirror,
            store::store_reset,
            transcript::parse_transcript,
            store::call_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Harry");
}
