use chrono::Utc;
use cpb_runtime::{
    hub_queue_dequeue, hub_queue_enqueue, hub_queue_list, hub_queue_status, hub_queue_update,
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

// --- Hub queue tests ---

#[test]
fn hub_enqueue_creates_full_entry_shape() {
    let root = temp_root("hub-enqueue");
    let entry = hub_queue_enqueue(&root, &json!({
        "projectId": "my-project",
        "sourcePath": "/repos/test",
        "sessionId": "sess-001",
        "workerId": "worker-001",
        "cwd": "/repos/test/worktree",
        "executionBoundary": "worktree",
        "priority": "P1",
        "description": "add dark mode"
    }))
    .unwrap();

    assert!(entry["id"].as_str().unwrap().starts_with("q-"));
    assert_eq!(entry["projectId"], "my-project");
    assert_eq!(entry["sourcePath"], "/repos/test");
    assert_eq!(entry["sessionId"], "sess-001");
    assert_eq!(entry["workerId"], "worker-001");
    assert_eq!(entry["cwd"], "/repos/test/worktree");
    assert_eq!(entry["executionBoundary"], "worktree");
    assert_eq!(entry["status"], "pending");
    assert_eq!(entry["priority"], "P1");
    assert_eq!(entry["description"], "add dark mode");
    assert!(entry["claimedBy"].is_null());
    assert!(entry["claimedAt"].is_null());
    assert!(entry["createdAt"].is_string());
    assert!(entry["updatedAt"].is_string());
}

#[test]
fn hub_enqueue_defaults_missing_metadata_to_null() {
    let root = temp_root("hub-enqueue-null-meta");
    let entry = hub_queue_enqueue(&root, &json!({
        "projectId": "my-project",
        "description": "add tests"
    }))
    .unwrap();

    assert!(entry["sourcePath"].is_null());
    assert!(entry["sessionId"].is_null());
    assert!(entry["workerId"].is_null());
    assert!(entry["cwd"].is_null());
    assert_eq!(entry["executionBoundary"], "source");
}

#[test]
fn hub_enqueue_rejects_missing_project_id() {
    let root = temp_root("hub-enqueue-no-project");
    let result = hub_queue_enqueue(&root, &json!({"sourcePath": "/x"}));
    assert!(result.is_err());
}

#[test]
fn hub_enqueue_deduplicates_by_project_and_description() {
    let root = temp_root("hub-dedup");
    let first = hub_queue_enqueue(&root, &json!({"projectId": "p1", "description": "fix login"}))
        .unwrap();
    let second = hub_queue_enqueue(&root, &json!({"projectId": "p1", "description": "fix login"}))
        .unwrap();
    assert_eq!(first["id"], second["id"]);
    assert_eq!(hub_queue_list(&root, None, None).unwrap().len(), 1);
}

#[test]
fn hub_dequeue_picks_highest_priority() {
    let root = temp_root("hub-dequeue-pri");
    hub_queue_enqueue(&root, &json!({"projectId": "low", "priority": "P2", "description": "low"}))
        .unwrap();
    hub_queue_enqueue(&root, &json!({"projectId": "high", "priority": "P0", "description": "high"}))
        .unwrap();

    let claimed = hub_queue_dequeue(&root).unwrap();
    assert_eq!(claimed["projectId"], "high");
    assert_eq!(claimed["status"], "in_progress");
    assert!(claimed["claimedAt"].is_string());
}

#[test]
fn hub_dequeue_returns_null_when_empty() {
    let root = temp_root("hub-dequeue-empty");
    assert!(hub_queue_dequeue(&root).unwrap().is_null());
}

#[test]
fn hub_update_changes_status_and_worker_id() {
    let root = temp_root("hub-update");
    let entry = hub_queue_enqueue(&root, &json!({"projectId": "p1", "description": "fix"})).unwrap();
    let id = entry["id"].as_str().unwrap();

    let updated = hub_queue_update(&root, id, &json!({"status": "completed", "workerId": "w-001"}))
        .unwrap();
    assert_eq!(updated["status"], "completed");
    assert_eq!(updated["workerId"], "w-001");
}

#[test]
fn hub_update_returns_null_for_unknown_id() {
    let root = temp_root("hub-update-unknown");
    let result = hub_queue_update(&root, "nonexistent", &json!({"status": "completed"})).unwrap();
    assert!(result.is_null());
}

#[test]
fn hub_status_counts_by_status() {
    let root = temp_root("hub-status");
    hub_queue_enqueue(&root, &json!({"projectId": "p1", "description": "a"})).unwrap();
    hub_queue_enqueue(&root, &json!({"projectId": "p2", "description": "b"})).unwrap();
    hub_queue_dequeue(&root).unwrap();

    let status = hub_queue_status(&root).unwrap();
    assert_eq!(status["total"], 2);
    assert_eq!(status["pending"], 1);
    assert_eq!(status["inProgress"], 1);
}

#[test]
fn hub_list_filters_by_status_and_project() {
    let root = temp_root("hub-list-filter");
    hub_queue_enqueue(&root, &json!({"projectId": "alpha", "description": "a1"})).unwrap();
    hub_queue_enqueue(&root, &json!({"projectId": "beta", "description": "b1"})).unwrap();

    let alpha = hub_queue_list(&root, None, Some("alpha")).unwrap();
    assert_eq!(alpha.len(), 1);

    let pending = hub_queue_list(&root, Some("pending"), None).unwrap();
    assert_eq!(pending.len(), 2);
}
