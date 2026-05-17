use chrono::Utc;
use cpb_runtime::{
    queue_claim, queue_complete, queue_list, queue_push,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "cpb-runtime-test-queue-{name}-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn push_adds_item_and_list_returns_it() {
    let root = temp_root("push-list");
    let result = queue_push(&root, "proj-a", &json!({
        "id": "q-001",
        "task": "add dark mode"
    }))
    .unwrap();
    assert_eq!(result["pushed"], true);
    assert_eq!(result["id"], "q-001");

    let items = queue_list(&root, "proj-a", None).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], "q-001");
    assert_eq!(items[0]["task"], "add dark mode");
    assert_eq!(items[0]["status"], "pending");
    assert!(items[0]["createdAt"].is_string());
}

#[test]
fn push_rejects_duplicate_id() {
    let root = temp_root("dup");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "first"})).unwrap();
    let dup = queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "second"})).unwrap();
    assert_eq!(dup["pushed"], false);
    assert_eq!(queue_list(&root, "proj-a", None).unwrap().len(), 1);
}

#[test]
fn list_filters_by_status() {
    let root = temp_root("filter");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "a"})).unwrap();
    queue_push(&root, "proj-a", &json!({"id": "q-2", "task": "b"})).unwrap();
    queue_claim(&root, "proj-a", Some("worker-1")).unwrap();

    let pending = queue_list(&root, "proj-a", Some("pending")).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0]["id"], "q-2");

    let claimed = queue_list(&root, "proj-a", Some("claimed")).unwrap();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0]["id"], "q-1");
}

#[test]
fn claim_picks_oldest_pending_and_sets_status() {
    let root = temp_root("claim");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "first"})).unwrap();
    queue_push(&root, "proj-a", &json!({"id": "q-2", "task": "second"})).unwrap();

    let claimed = queue_claim(&root, "proj-a", Some("worker-x")).unwrap();
    assert!(claimed.is_object());
    assert_eq!(claimed["id"], "q-1");
    assert_eq!(claimed["status"], "claimed");
    assert_eq!(claimed["claimedBy"], "worker-x");
    assert!(claimed["claimedAt"].is_string());
}

#[test]
fn claim_returns_null_when_empty() {
    let root = temp_root("claim-empty");
    let claimed = queue_claim(&root, "proj-a", None).unwrap();
    assert!(claimed.is_null());
}

#[test]
fn complete_marks_claimed_item_done() {
    let root = temp_root("complete");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "do it"})).unwrap();
    queue_claim(&root, "proj-a", Some("worker-1")).unwrap();

    let result = queue_complete(&root, "proj-a", "q-1").unwrap();
    assert_eq!(result["completed"], true);
    assert_eq!(result["id"], "q-1");

    let items = queue_list(&root, "proj-a", Some("completed")).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["status"], "completed");
    assert!(items[0]["completedAt"].is_string());
}

#[test]
fn complete_rejects_unclaimed_item() {
    let root = temp_root("complete-unclaimed");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "skip"})).unwrap();
    let result = queue_complete(&root, "proj-a", "q-1").unwrap();
    assert_eq!(result["completed"], false);
}

#[test]
fn queue_state_survives_crash_simulation() {
    let root = temp_root("durable");
    queue_push(&root, "proj-a", &json!({"id": "q-1", "task": "survive"})).unwrap();
    queue_claim(&root, "proj-a", Some("w1")).unwrap();

    // Simulate restart: re-read from disk
    let items = queue_list(&root, "proj-a", None).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["status"], "claimed");
    assert_eq!(items[0]["claimedBy"], "w1");
}
