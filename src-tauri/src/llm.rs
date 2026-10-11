//! Inference through the `openllm` CLI: `openllm -p - -m <model> -s <system> --no-stream`,
//! with the prompt on stdin.

use crate::cli;
use serde::Serialize;
use std::time::Instant;
use tauri::AppHandle;

pub const DEFAULT_MODEL: &str = "claude-sonnet-5-5";

#[derive(Serialize)]
pub struct Completion {
    text: String,
    model: String,
    ms: u128,
    prompt_tokens: u64,
    completion_tokens: u64,
}

#[tauri::command]
pub async fn llm_complete(app: AppHandle, system: String, prompt: String, model: Option<String>) -> Result<Completion, String> {
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.into());
    let started = Instant::now();
    let out = cli::run(
        &app,
        "llm",
        "openllm",
        &["-p", "-", "-m", &model, "-s", &system, "--no-stream"],
        &[],
        Some(&prompt),
        false,
    )
    .await?;
    if !out.ok() {
        return Err(format!("openllm: {}", out.err_text().trim_start_matches("[openllm] ")));
    }
    // The CLI doesn't report usage; estimate ~4 chars per token so traces still show cost.
    let est = |s: &str| (s.len() as u64).div_ceil(4);
    Ok(Completion {
        prompt_tokens: est(&system) + est(&prompt),
        completion_tokens: est(&out.stdout),
        text: out.stdout.trim().to_string(),
        model,
        ms: started.elapsed().as_millis(),
    })
}
