//! Inference through the `openllm` CLI: `openllm -m <model> -p - -s <system> --json`, with the
//! prompt on stdin. `--json` prints one result object with the text, resolved model and usage.

use crate::cli;
use serde::Serialize;
use serde_json::Value;
use std::time::Instant;
use tauri::AppHandle;

pub const DEFAULT_MODEL: &str = "plus";

#[derive(Serialize)]
pub struct Completion {
    text: String,
    model: String,
    ms: u128,
    /// The provider/model the gateway actually routed to, e.g. `grok/grok-4.5` for `plus`.
    resolved_model: String,
    finish_reason: String,
    fallbacks: u64,
    prompt_tokens: u64,
    completion_tokens: u64,
    cached_tokens: u64,
}

#[tauri::command]
pub async fn llm_complete(app: AppHandle, system: String, prompt: String, model: Option<String>) -> Result<Completion, String> {
    let model = model.unwrap_or_else(|| DEFAULT_MODEL.into());
    let started = Instant::now();
    let out = cli::run(
        &app,
        "llm",
        "openllm",
        &["-m", &model, "-p", "-", "-s", &system, "--json"],
        &[],
        Some(&prompt),
        false,
    )
    .await?;
    if !out.ok() {
        return Err(format!("openllm: {}", out.err_text().trim_start_matches("[openllm] ")));
    }
    let last = out.stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or("openllm --json returned no result")?;
    let r: Value = serde_json::from_str(last).map_err(|e| format!("could not parse openllm result: {e}"))?;
    let n = |v: &Value| v.as_u64().unwrap_or(0);
    let u = &r["usage"];
    Ok(Completion {
        text: r["text"].as_str().unwrap_or_default().trim().to_string(),
        model: r["model"].as_str().map(String::from).unwrap_or(model),
        resolved_model: r["resolved_model"].as_str().unwrap_or_default().to_string(),
        finish_reason: r["finish_reason"].as_str().unwrap_or_default().to_string(),
        fallbacks: n(&r["attempted_fallbacks"]),
        prompt_tokens: n(&u["prompt_tokens"]),
        completion_tokens: n(&u["completion_tokens"]),
        cached_tokens: n(&u["prompt_tokens_details"]["cached_tokens"]),
        ms: started.elapsed().as_millis(),
    })
}
