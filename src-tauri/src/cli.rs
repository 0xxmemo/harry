//! Spawns local CLIs with a predictable PATH and streams their output to the UI.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Clone, Serialize)]
pub struct LogLine {
    pub id: String,
    pub stream: &'static str,
    pub line: String,
}

pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    pub fn ok(&self) -> bool {
        self.code == 0
    }
    pub fn err_text(&self) -> String {
        let s = if self.stderr.trim().is_empty() { &self.stdout } else { &self.stderr };
        s.trim().lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn app_bin(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| home().join(".harry")).join("bin")
}

/// Finder-launched apps don't inherit the shell PATH, so build one explicitly.
pub fn search_path(app: &AppHandle) -> String {
    let h = home();
    let mut parts: Vec<String> = vec![
        app_bin(app).to_string_lossy().into(),
        h.join(".openllm/bin").to_string_lossy().into(),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        h.join(".local/bin").to_string_lossy().into(),
        h.join(".composio").to_string_lossy().into(),
    ];
    if let Ok(p) = std::env::var("PATH") {
        parts.push(p);
    }
    parts.push("/usr/bin:/bin:/usr/sbin:/sbin".into());
    parts.join(":")
}

pub fn resolve(app: &AppHandle, tool: &str) -> Option<PathBuf> {
    search_path(app)
        .split(':')
        .map(|d| PathBuf::from(d).join(tool))
        .find(|p| p.is_file())
}

/// Run a program to completion. Secrets go through `envs` or `stdin`, never argv.
pub async fn run(
    app: &AppHandle,
    id: &str,
    program: &str,
    args: &[&str],
    envs: &[(&str, &str)],
    stdin: Option<&str>,
    stream: bool,
) -> Result<Output, String> {
    let bin = if program.starts_with('/') {
        PathBuf::from(program)
    } else {
        resolve(app, program).ok_or_else(|| format!("{program} is not installed"))?
    };
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .env("PATH", search_path(app))
        .stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().map_err(|e| format!("failed to start {program}: {e}"))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        pipe.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
        drop(pipe);
    }
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let (a1, a2) = (app.clone(), app.clone());
    let (id1, id2) = (id.to_string(), id.to_string());
    let t_out = tokio::spawn(async move { collect(a1, id1, "stdout", out, stream).await });
    let t_err = tokio::spawn(async move { collect(a2, id2, "stderr", err, stream).await });
    let status = child.wait().await.map_err(|e| e.to_string())?;
    Ok(Output {
        code: status.code().unwrap_or(-1),
        stdout: t_out.await.unwrap_or_default(),
        stderr: t_err.await.unwrap_or_default(),
    })
}

async fn collect<R: tokio::io::AsyncRead + Unpin>(
    app: AppHandle,
    id: String,
    stream: &'static str,
    reader: R,
    emit: bool,
) -> String {
    let mut lines = BufReader::new(reader).lines();
    let mut buf = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if emit {
            let _ = app.emit("cli-log", LogLine { id: id.clone(), stream, line: line.clone() });
        }
        buf.push_str(&line);
        buf.push('\n');
    }
    buf
}
