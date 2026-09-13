use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static LEDGERS: RefCell<HashMap<String, Vec<Value>>> = RefCell::new(HashMap::new());
    /// user_id → that user's latest run_id. A user's older run is evicted when a
    /// new one begins, so memory stays bounded by active users in the isolate.
    static LAST_RUN: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

pub fn sha256_hex(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    h.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn begin_run(user_id: &str, run_id: &str) {
    let prev = LAST_RUN.with(|l| l.borrow_mut().insert(user_id.to_string(), run_id.to_string()));
    LEDGERS.with(|l| {
        let mut l = l.borrow_mut();
        if let Some(prev) = prev.filter(|p| p != run_id) {
            l.remove(&prev);
        }
        l.insert(run_id.to_string(), Vec::new());
    });
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

/// Entries of `user_id`'s latest run in this isolate (never another user's).
pub fn last_run_entries(user_id: &str) -> Vec<Value> {
    let Some(run_id) = LAST_RUN.with(|l| l.borrow().get(user_id).cloned()) else {
        return Vec::new();
    };
    LEDGERS.with(|l| l.borrow().get(&run_id).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledgers_are_per_user_and_evict_old_runs() {
        begin_run("alice", "run-a1");
        record("run-a1", json!({"type": "tool_call"}));
        begin_run("bob", "run-b1");
        record("run-b1", json!({"type": "plan"}));
        assert_eq!(last_run_entries("alice").len(), 1);
        assert_eq!(last_run_entries("bob")[0]["type"], "plan");
        assert!(last_run_entries("mallory").is_empty());
        begin_run("alice", "run-a2");
        assert!(last_run_entries("alice").is_empty());
        assert!(LEDGERS.with(|l| !l.borrow().contains_key("run-a1")));
        assert_eq!(last_run_entries("bob").len(), 1);
    }
}
