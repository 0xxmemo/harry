//! Call transcript import. Normalizes Meet/Zoom/Teams/Otter/Fireflies exports into speaker turns.

use crate::files;
use crate::AppState;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use tauri::State;

#[derive(Serialize, Clone)]
pub struct Turn {
    speaker: String,
    start: String,
    text: String,
}

#[derive(Serialize)]
pub struct Parsed {
    file: String,
    hash: String,
    format: String,
    turns: Vec<Turn>,
}

const MAX: u64 = 10 * 1024 * 1024;

fn docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("not a .docx: {e}"))?;
    let mut xml = String::new();
    zip.by_name("word/document.xml").map_err(|e| e.to_string())?.read_to_string(&mut xml).map_err(|e| e.to_string())?;
    let para = Regex::new(r"</w:p>").unwrap();
    let br = Regex::new(r"<w:(br|tab)[^>]*/>").unwrap();
    let tags = Regex::new(r"<[^>]+>").unwrap();
    let t = para.replace_all(&xml, "\n");
    let t = br.replace_all(&t, " ");
    let t = tags.replace_all(&t, "");
    Ok(t.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'"))
}

fn cues(text: &str) -> Vec<Turn> {
    // WebVTT / SRT: timing line, then text. Speaker via "<v Name>" or "Name: ".
    let timing = Regex::new(r"^(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->").unwrap();
    let voice = Regex::new(r"^<v\s+([^>]+)>(.*)$").unwrap();
    let named = Regex::new(r"^([A-Z][\w .'-]{1,40}):\s+(.*)$").unwrap();
    let tags = Regex::new(r"</?[^>]+>").unwrap();
    let mut out: Vec<Turn> = vec![];
    let mut start = String::new();
    let mut in_cue = false;
    for line in text.lines() {
        let l = line.trim();
        if timing.is_match(l) {
            start = l.split("-->").next().unwrap().trim().split([',', '.']).next().unwrap().to_string();
            in_cue = true;
            continue;
        }
        if l.is_empty() {
            in_cue = false;
            continue;
        }
        if !in_cue {
            continue;
        }
        let (speaker, body) = if let Some(c) = voice.captures(l) {
            (c[1].trim().to_string(), tags.replace_all(&c[2], "").trim().to_string())
        } else if let Some(c) = named.captures(l) {
            (c[1].trim().to_string(), c[2].trim().to_string())
        } else {
            (out.last().map(|t| t.speaker.clone()).unwrap_or_else(|| "Unknown".into()), tags.replace_all(l, "").trim().to_string())
        };
        match out.last_mut() {
            Some(last) if last.speaker == speaker && last.start == start => {
                last.text.push(' ');
                last.text.push_str(&body);
            }
            Some(last) if last.speaker == speaker => {
                last.text.push(' ');
                last.text.push_str(&body);
            }
            _ => out.push(Turn { speaker, start: start.clone(), text: body }),
        }
    }
    out
}

fn plain(text: &str) -> Vec<Turn> {
    // "Name: text", "Name (00:01:02): text", "00:01:02 Name: text", or a Meet-style "Name\n00:01:02\ntext".
    let line_re = Regex::new(r"^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s+)?([A-Z][\w .'-]{1,40}?)\s*(?:\((\d{1,2}:\d{2}(?::\d{2})?)\))?:\s+(.+)$").unwrap();
    let ts = Regex::new(r"^\d{1,2}:\d{2}(:\d{2})?$").unwrap();
    let mut out: Vec<Turn> = vec![];
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let mut i = 0;
    while i < lines.len() {
        let l = lines[i];
        if let Some(c) = line_re.captures(l) {
            let start = c.get(1).or(c.get(3)).map(|m| m.as_str().to_string()).unwrap_or_default();
            out.push(Turn { speaker: c[2].trim().to_string(), start, text: c[4].trim().to_string() });
        } else if i + 2 < lines.len() && ts.is_match(lines[i + 1]) && !l.is_empty() && l.len() < 40 {
            out.push(Turn { speaker: l.to_string(), start: lines[i + 1].to_string(), text: lines[i + 2].to_string() });
            i += 2;
        } else if !l.is_empty() {
            if let Some(last) = out.last_mut() {
                last.text.push(' ');
                last.text.push_str(l);
            }
        }
        i += 1;
    }
    out
}

fn json_turns(v: &Value) -> Vec<Turn> {
    let arr = v.as_array().cloned().or_else(|| {
        ["transcript", "turns", "segments", "utterances", "sentences", "monologues"].iter().find_map(|k| v.get(*k).and_then(Value::as_array).cloned())
    });
    arr.unwrap_or_default()
        .iter()
        .filter_map(|t| {
            let text = ["text", "sentence", "content", "words"].iter().find_map(|k| t.get(*k).and_then(Value::as_str))?;
            let speaker = ["speaker", "speaker_name", "name", "participant"].iter().find_map(|k| t.get(*k).map(|s| s.as_str().map(String::from).unwrap_or_else(|| s.to_string()))).unwrap_or_else(|| "Unknown".into());
            let start = ["start", "start_time", "timestamp", "startTime"].iter().find_map(|k| t.get(*k).map(|s| s.as_str().map(String::from).unwrap_or_else(|| s.to_string()))).unwrap_or_default();
            Some(Turn { speaker, start, text: text.to_string() })
        })
        .collect()
}

fn parse_bytes(name: &str, bytes: &[u8]) -> Result<(String, Vec<Turn>), String> {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    let text = || String::from_utf8_lossy(bytes).replace('\u{feff}', "");
    let turns = match ext.as_str() {
        "vtt" | "srt" => cues(&text()),
        "json" => json_turns(&serde_json::from_str(&text()).map_err(|e| e.to_string())?),
        "docx" => plain(&docx_text(bytes)?),
        "txt" | "md" => {
            let t = text();
            if t.contains("-->") { cues(&t) } else { plain(&t) }
        }
        _ => return Err(format!(".{ext} isn't a supported transcript format")),
    };
    if turns.is_empty() {
        return Err("Couldn't find any speaker turns in this file".into());
    }
    Ok((ext, turns))
}

/// Bundled sample transcripts for the demo.
#[tauri::command]
pub fn sample_calls() -> Vec<String> {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../demo-crm/calls");
    let mut v: Vec<String> = std::fs::read_dir(&dir)
        .map(|r| r.flatten().filter_map(|e| std::fs::canonicalize(e.path()).ok()).map(|p| p.to_string_lossy().into()).collect())
        .unwrap_or_default();
    v.sort();
    v
}

/// Parse a transcript from a granted folder, or one the user dropped onto the window.
/// Drag-drop is an explicit grant for that single file.
#[tauri::command]
pub fn parse_transcript(state: State<'_, AppState>, path: String, dropped: bool) -> Result<Parsed, String> {
    let p = if dropped {
        let p = std::fs::canonicalize(&path).map_err(|e| e.to_string())?;
        let name = p.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        if name.starts_with('.') || name.contains("secret") || name.ends_with(".key") || name.ends_with(".pem") {
            return Err("Hidden and secret files are never read".into());
        }
        p
    } else {
        files::within_roots(&state, &path)?
    };
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX {
        return Err("Pick a transcript file under 10 MB".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    let name = p.file_name().unwrap().to_string_lossy().to_string();
    let (format, turns) = parse_bytes(&name, &bytes)?;
    Ok(Parsed { file: name, hash: hex::encode(Sha256::digest(&bytes)), format, turns })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_samples() {
        for f in ["granite-bank-discovery.vtt", "helios-health-renewal.docx"] {
            let bytes = std::fs::read(format!("../demo-crm/calls/{f}")).unwrap();
            let (_, turns) = parse_bytes(f, &bytes).unwrap();
            println!("{f}: {} turns, first {}: {}", turns.len(), turns[0].speaker, &turns[0].text[..30]);
            assert!(turns.len() >= 6);
            assert!(turns.iter().any(|t| t.speaker.contains("Park") || t.speaker.contains("Novak")));
        }
        let t = plain("Jane Doe: hi there\nBob (00:01): hello\n[00:02] Jane Doe: more\ncontinued");
        assert_eq!(t.len(), 3);
        assert!(t[2].text.ends_with("continued"));
    }
}
