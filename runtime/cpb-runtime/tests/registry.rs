use chrono::Utc;
use cpb_runtime::{
    get_registry_project, heartbeat_worker, list_registry_projects, update_registry_project,
    upsert_registry_project, worker_status,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "cpb-runtime-test-registry-{name}-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn get_returns_project_by_id() {
    let root = temp_root("get");
    upsert_registry_project(&root, &json!({"id": "alpha", "name": "Alpha", "sourcePath": "/a"}))
        .unwrap();
    upsert_registry_project(&root, &json!({"id": "beta", "name": "Beta", "sourcePath": "/b"}))
        .unwrap();

    let alpha = get_registry_project(&root, "alpha").unwrap();
    assert_eq!(alpha["id"], "alpha");
    assert_eq!(alpha["name"], "Alpha");

    let missing = get_registry_project(&root, "nope").unwrap();
    assert!(missing.is_null());
}

#[test]
fn update_patches_fields_and_preserves_id() {
    let root = temp_root("update");
    upsert_registry_project(&root, &json!({"id": "patch-me", "name": "Before", "sourcePath": "/before"}))
        .unwrap();

    let updated = update_registry_project(&root, "patch-me", &json!({"name": "After", "enabled": false}))
        .unwrap();
    assert_eq!(updated["id"], "patch-me");
    assert_eq!(updated["name"], "After");
    assert_eq!(updated["sourcePath"], "/before");
    assert_eq!(updated["enabled"], false);

    let reloaded = get_registry_project(&root, "patch-me").unwrap();
    assert_eq!(reloaded["name"], "After");
    assert_eq!(reloaded["enabled"], false);
}

#[test]
fn update_rejects_unknown_project() {
    let root = temp_root("update-unknown");
    let result = update_registry_project(&root, "ghost", &json!({"name": "X"}));
    assert!(result.is_err());
}

#[test]
fn heartbeat_writes_worker_metadata() {
    let root = temp_root("heartbeat");
    upsert_registry_project(&root, &json!({"id": "hb-proj", "name": "HB", "sourcePath": "/hb"}))
        .unwrap();

    let result = heartbeat_worker(
        &root,
        "hb-proj",
        &json!({
            "workerId": "w-001",
            "pid": 1234,
            "status": "online",
            "capabilities": ["plan", "execute"]
        }),
    )
    .unwrap();
    assert_eq!(result["worker"]["workerId"], "w-001");
    assert_eq!(result["worker"]["pid"], 1234);
    assert_eq!(result["worker"]["status"], "online");
    assert!(result["worker"]["lastSeenAt"].is_string());
}

#[test]
fn heartbeat_updates_existing_worker() {
    let root = temp_root("heartbeat-update");
    upsert_registry_project(&root, &json!({"id": "hb-up", "name": "HB", "sourcePath": "/hb-up"}))
        .unwrap();

    let first = heartbeat_worker(&root, "hb-up", &json!({"workerId": "w-001", "status": "online"}))
        .unwrap();
    let second = heartbeat_worker(&root, "hb-up", &json!({"workerId": "w-002", "status": "online"}))
        .unwrap();

    assert_eq!(second["worker"]["workerId"], "w-002");
    assert_ne!(second["worker"]["lastSeenAt"], first["worker"]["lastSeenAt"]);
}

#[test]
fn worker_status_returns_offline_for_no_worker() {
    let status = worker_status(&json!({"id": "p1"}), 120_000);
    assert_eq!(status, "offline");
}

#[test]
fn worker_status_returns_online_for_recent_heartbeat() {
    let now = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let status = worker_status(&json!({"id": "p1", "worker": {"lastSeenAt": now}}), 120_000);
    assert_eq!(status, "online");
}

#[test]
fn worker_status_returns_stale_for_old_heartbeat() {
    let old = "2020-01-01T00:00:00.000Z";
    let status = worker_status(&json!({"id": "p1", "worker": {"lastSeenAt": old}}), 120_000);
    assert_eq!(status, "stale");
}

#[test]
fn heartbeat_survives_restart_simulation() {
    let root = temp_root("heartbeat-durable");
    upsert_registry_project(&root, &json!({"id": "hb-dur", "name": "Durable", "sourcePath": "/dur"}))
        .unwrap();

    heartbeat_worker(&root, "hb-dur", &json!({"workerId": "w-001", "status": "online"})).unwrap();

    let projects = list_registry_projects(&root).unwrap();
    let project = projects.iter().find(|p| p["id"] == "hb-dur").unwrap();
    assert_eq!(project["worker"]["workerId"], "w-001");
    assert!(project["worker"]["lastSeenAt"].is_string());
}
