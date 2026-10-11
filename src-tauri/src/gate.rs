//! Deterministic policy gate. Every pipeline passes through here before it reaches a database,
//! regardless of what the model proposed.

use serde_json::{json, Value};

const ALLOWED_STAGES: &[&str] = &[
    "$match", "$project", "$group", "$sort", "$limit", "$skip", "$lookup", "$unwind", "$addFields",
    "$set", "$unset", "$count", "$facet", "$bucket", "$bucketAuto", "$sortByCount", "$replaceRoot",
    "$replaceWith", "$sample", "$setWindowFields",
];
const FORBIDDEN: &[&str] = &["$out", "$merge", "$where", "$function", "$accumulator", "$currentOp", "$listSessions"];
pub const MAX_ROWS: u64 = 500;

pub fn check_pipeline(pipeline: &Value) -> Result<Value, String> {
    let stages = pipeline.as_array().ok_or("pipeline must be an array")?;
    if stages.len() > 30 {
        return Err("pipeline has more than 30 stages".into());
    }
    for (i, stage) in stages.iter().enumerate() {
        let obj = stage.as_object().ok_or(format!("stage {i} is not an object"))?;
        if obj.len() != 1 {
            return Err(format!("stage {i} must have exactly one operator"));
        }
        let op = obj.keys().next().unwrap();
        if !ALLOWED_STAGES.contains(&op.as_str()) {
            return Err(format!("stage {op} is not on the read-only allowlist"));
        }
    }
    scan(pipeline)?;
    let mut out = stages.clone();
    let capped = matches!(out.last(), Some(Value::Object(o)) if o.get("$limit").and_then(Value::as_u64).is_some_and(|n| n <= MAX_ROWS));
    if !capped {
        out.push(json!({ "$limit": MAX_ROWS }));
    }
    Ok(Value::Array(out))
}

fn scan(v: &Value) -> Result<(), String> {
    match v {
        Value::Object(o) => {
            for (k, child) in o {
                if FORBIDDEN.contains(&k.as_str()) {
                    return Err(format!("operator {k} is forbidden"));
                }
                scan(child)?;
            }
            Ok(())
        }
        Value::Array(a) => a.iter().try_for_each(scan),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn gate_check(pipeline: Value) -> Result<Value, String> {
    check_pipeline(&pipeline)
}

// ---- Agent actions -------------------------------------------------------------------------

/// Composio toolkits Harry may link.
pub const LINKABLE: &[&str] = &["gmail", "outlook", "hubspot", "salesforce", "pipedrive", "googlecalendar", "outlook_calendar"];

/// Actions that deliver email. Only `outbox_send` may run these.
pub const SEND_ACTIONS: &[&str] = &["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD", "OUTLOOK_SEND_EMAIL", "OUTLOOK_REPLY_EMAIL"];

/// Everything else Harry may call: reads, plus CRM notes and tasks. Never updates, deletes, or stage changes.
const READ_OR_NOTE_ACTIONS: &[&str] = &[
    "GMAIL_FETCH_EMAILS", "GMAIL_FETCH_MESSAGE_BY_THREAD_ID", "GMAIL_GET_PROFILE",
    "OUTLOOK_LIST_MESSAGES", "OUTLOOK_GET_PROFILE",
    "GOOGLECALENDAR_FIND_EVENT", "GOOGLECALENDAR_EVENTS_LIST",
    "HUBSPOT_LIST_CONTACTS", "HUBSPOT_LIST_DEALS", "HUBSPOT_LIST_COMPANIES", "HUBSPOT_RETRIEVE_PIPELINE_STAGES", "HUBSPOT_SEARCH_CRM_OBJECTS_BY_CRITERIA", "HUBSPOT_CREATE_NOTE", "HUBSPOT_CREATE_TASK",
    "SALESFORCE_QUERY", "PIPEDRIVE_GET_ALL_DEALS", "PIPEDRIVE_ADD_A_NOTE",
];

pub fn check_action(slug: &str) -> Result<(), String> {
    if SEND_ACTIONS.contains(&slug) {
        return Err("Sends must go through the approved outbox".into());
    }
    if READ_OR_NOTE_ACTIONS.contains(&slug) { Ok(()) } else { Err(format!("Policy gate: {slug} is not an allowed action")) }
}

pub fn check_send_action(slug: &str) -> Result<(), String> {
    if SEND_ACTIONS.contains(&slug) { Ok(()) } else { Err(format!("Policy gate: {slug} is not a send action")) }
}

fn valid_email(s: &str) -> bool {
    regex::Regex::new(r"^[^@\s]+@[^@\s]+\.[^@\s]+$").unwrap().is_match(s)
}

/// Content rules that hold for every outgoing message, approved or not.
pub fn check_message(item: &Value, settings: &Value) -> Result<(), String> {
    let to = item["to"].as_str().unwrap_or_default().trim().to_lowercase();
    if !valid_email(&to) {
        return Err(format!("Policy gate: \"{to}\" is not a valid recipient"));
    }
    if to.ends_with(".example.com") || to.ends_with("@example.com") {
        return Err("Policy gate: demo contacts have placeholder addresses. Set a real recipient you control.".into());
    }
    if settings["demoMode"].as_bool().unwrap_or(true) {
        let allowed = settings["allowlist"].as_array().map(|a| a.iter().filter_map(Value::as_str).any(|e| e.trim().eq_ignore_ascii_case(&to))).unwrap_or(false);
        if !allowed {
            return Err(format!("Policy gate: demo mode only sends to the allowlist; {to} isn't on it"));
        }
    }
    let body = item["body"].as_str().unwrap_or_default();
    if body.trim().len() < 10 || item["subject"].as_str().unwrap_or_default().trim().is_empty() && item["threadId"].is_null() {
        return Err("Policy gate: subject and body are required".into());
    }
    let pricing = regex::Regex::new(r"(?i)(\$\s?\d|\d+\s?% off|\bdiscount|\bfree month|\bpromo code)").unwrap();
    if pricing.is_match(body) {
        return Err("Policy gate: no prices or discounts in automated follow-ups".into());
    }
    Ok(())
}

/// Volume, opt-out, and timing rules, evaluated against what was actually sent.
pub fn check_caps(item: &Value, outbox: &[Value], optouts: &[Value], settings: &Value) -> Result<(), String> {
    let to = item["to"].as_str().unwrap_or_default().to_lowercase();
    if optouts.iter().any(|o| o["_id"].as_str().is_some_and(|e| e.eq_ignore_ascii_case(&to))) {
        return Err("Policy gate: this contact opted out".into());
    }
    let now = chrono::Utc::now();
    let sent_at = |o: &Value| o["sentAt"].as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&chrono::Utc));
    let sent: Vec<&Value> = outbox.iter().filter(|o| o["status"] == "sent" && o["_id"] != item["_id"]).collect();
    let week = sent.iter().filter(|o| o["to"].as_str().is_some_and(|t| t.eq_ignore_ascii_case(&to)) && sent_at(o).is_some_and(|d| now - d < chrono::Duration::days(7))).count();
    let day = sent.iter().filter(|o| sent_at(o).is_some_and(|d| now - d < chrono::Duration::hours(24))).count();
    let per_contact = settings["perContactPerWeek"].as_u64().unwrap_or(2) as usize;
    let per_day = settings["perMailboxPerDay"].as_u64().unwrap_or(20) as usize;
    if week >= per_contact {
        return Err(format!("Policy gate: already {week} emails to this contact this week (cap {per_contact})"));
    }
    if day >= per_day {
        return Err(format!("Policy gate: mailbox daily cap reached ({per_day})"));
    }
    if settings["businessHours"].as_bool().unwrap_or(true) {
        let tz: chrono_tz::Tz = item["timezone"].as_str().and_then(|t| t.parse().ok()).unwrap_or(chrono_tz::America::Los_Angeles);
        let local = now.with_timezone(&tz);
        use chrono::{Datelike, Timelike};
        let weekend = matches!(local.weekday(), chrono::Weekday::Sat | chrono::Weekday::Sun);
        if weekend || local.hour() < 8 || local.hour() >= 18 {
            return Err(format!("Policy gate: it's {} in the contact's timezone ({tz}); sends wait for business hours", local.format("%a %H:%M")));
        }
    }
    Ok(())
}

/// Reject playbook edits that drop or contradict a firm limit.
#[tauri::command]
pub fn gate_playbook(firm_limits: Vec<String>, rules: Vec<String>) -> Result<(), String> {
    let joined = rules.join("\n").to_lowercase();
    let override_re = regex::Regex::new(r"(?i)ignore (the )?(firm|policy|limit|rule)|override|bypass|offer (a )?discount|\$\s?\d|\d+\s?% off").unwrap();
    if let Some(m) = override_re.find(&joined) {
        return Err(format!("Policy gate: proposed rule contains \"{}\"", m.as_str()));
    }
    for limit in firm_limits {
        let neg = format!("not {}", limit.to_lowercase());
        if joined.contains(&neg) {
            return Err(format!("Policy gate: contradicts firm limit \"{limit}\""));
        }
    }
    if rules.iter().any(|r| r.len() > 400) {
        return Err("Policy gate: rules must be short".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn gates() {
        let s = json!({"demoMode": true, "allowlist": ["me@test.dev"], "businessHours": false});
        let ok = json!({"to": "me@test.dev", "subject": "Hi", "body": "Following up on our call."});
        assert!(check_message(&ok, &s).is_ok());
        assert!(check_message(&json!({"to": "x@other.dev", "subject": "Hi", "body": "Following up on our call."}), &s).is_err());
        assert!(check_message(&json!({"to": "a@b.example.com", "subject": "Hi", "body": "Following up on our call."}), &json!({"demoMode": false})).is_err());
        assert!(check_message(&json!({"to": "me@test.dev", "subject": "Hi", "body": "I can do 20% off this week"}), &s).is_err());
        assert!(check_action("GMAIL_SEND_EMAIL").is_err());
        assert!(check_action("GMAIL_DELETE_MESSAGE").is_err());
        assert!(check_action("GMAIL_FETCH_EMAILS").is_ok());
        let now = chrono::Utc::now().to_rfc3339();
        let sent = vec![json!({"_id": "a", "to": "me@test.dev", "status": "sent", "sentAt": now}), json!({"_id": "b", "to": "me@test.dev", "status": "sent", "sentAt": now})];
        assert!(check_caps(&json!({"_id": "c", "to": "me@test.dev"}), &sent, &[], &s).is_err());
        assert!(check_caps(&ok, &[], &[json!({"_id": "me@test.dev"})], &s).is_err());
        assert!(gate_playbook(vec!["fair housing".into()], vec!["Do not fair housing rules apply".into()]).is_err());
        assert!(gate_playbook(vec![], vec!["Offer a discount if they hesitate".into()]).is_err());
        assert!(gate_playbook(vec![], vec!["Address security concerns with the SOC 2 report".into()]).is_ok());
        assert!(check_pipeline(&json!([{"$out": "x"}])).is_err());
    }
}
