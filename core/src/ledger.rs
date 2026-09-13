use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static LEDGERS: RefCell<HashMap<String, Vec<Value>>> = RefCell::new(HashMap::new());
    static LAST_RUN: RefCell<String> = RefCell::new(String::new());
}

pub fn sha256_hex(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn begin_run(run_id: &str) {
    LEDGERS.with(|l| l.borrow_mut().insert(run_id.to_string(), Vec::new()));
    LAST_RUN.with(|l| *l.borrow_mut() = run_id.to_string());
}

pub fn record(run_id: &str, entry: Value) {
    LEDGERS.with(|l| {
        l.borrow_mut()
            .entry(run_id.to_string())
            .or_default()
            .push(entry)
    });
}

/// Append a chained attestation entry; returns the new hash.
pub fn attest(run_id: &str, claim: &str, evidence: &str, app: &str) -> String {
    let prev = LEDGERS.with(|l| {
        l.borrow()
            .get(run_id)
            .and_then(|entries| {
                entries
                    .iter()
                    .rev()
                    .find(|e| e.get("type").and_then(|t| t.as_str()) == Some("verify"))
            })
            .and_then(|e| e.get("hash").and_then(|h| h.as_str()).map(|s| s.to_string()))
    })
    .unwrap_or_else(|| "bloop".to_string());

    let entry = json!({
        "app": app,
        "claim": claim,
        "evidence": evidence,
        "ts": js_sys::Date::now() as u64,
    });
    let hash = sha256_hex(&format!("{}{}", prev, serde_json::to_string(&entry).unwrap_or_default()));

    let mut stored = entry.clone();
    stored["type"] = json!("verify");
    stored["prev"] = json!(prev);
    stored["hash"] = json!(hash);
    record(run_id, stored);
    hash
}

pub fn last_run_entries() -> Vec<Value> {
    LAST_RUN.with(|lr| {
        let id = lr.borrow().clone();
        LEDGERS.with(|l| l.borrow().get(&id).cloned().unwrap_or_default())
    })
}
