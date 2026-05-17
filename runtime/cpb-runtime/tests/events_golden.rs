use cpb_runtime::{materialize_job, read_events, repair_event_file};
use serde_json::json;
use std::fs;
use std::path::PathBuf;

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "cpb-runtime-test-events-{name}-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn terminal_events_keep_js_priority_contract() {
    let events = vec![
        json!({"type":"job_created","jobId":"j1","project":"p","task":"t","ts":"T0"}),
        json!({"type":"phase_started","jobId":"j1","phase":"plan","leaseId":"l1","ts":"T1"}),
        json!({"type":"job_completed","jobId":"j1","ts":"T2"}),
        json!({"type":"phase_started","jobId":"j1","phase":"verify","leaseId":"l2","ts":"T3"}),
        json!({"type":"phase_activity","jobId":"j1","message":"late output","ts":"T4"}),
    ];
    let state = materialize_job(&events);
    assert_eq!(state["status"], "completed");
    assert_eq!(state["phase"], "completed");
    assert_eq!(state["leaseId"], serde_json::Value::Null);
    assert_eq!(state["lastActivityMessage"], "late output");
}

#[test]
fn repair_removes_corrupt_trailing_line() {
    let root = temp_root("repair-corrupt");
    let events_dir = root.join("cpb-task").join("events").join("demo");
    fs::create_dir_all(&events_dir).unwrap();
    let file = events_dir.join("job-repair-test.jsonl");

    let valid_event = json!({"type":"job_created","jobId":"j1","project":"demo","task":"t","ts":"T0"});
    fs::write(&file, format!("{}\n{{\"broken\":", serde_json::to_string(&valid_event).unwrap())).unwrap();

    let result = repair_event_file(&root, "demo", "job-repair-test").unwrap();
    assert_eq!(result["repaired"], true);
    assert!(result["removedBytes"].as_u64().unwrap() > 0);

    let raw = fs::read_to_string(&file).unwrap();
    assert!(raw.ends_with('\n'));
    assert_eq!(raw.trim().lines().count(), 1);

    let events = read_events(&root, "demo", "job-repair-test").unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "job_created");
}

#[test]
fn repair_adds_missing_trailing_newline() {
    let root = temp_root("repair-nl");
    let events_dir = root.join("cpb-task").join("events").join("demo");
    fs::create_dir_all(&events_dir).unwrap();
    let file = events_dir.join("job-nl-test.jsonl");

    let valid_event = json!({"type":"job_created","jobId":"j2","project":"demo","task":"t","ts":"T0"});
    fs::write(&file, serde_json::to_string(&valid_event).unwrap()).unwrap();

    let result = repair_event_file(&root, "demo", "job-nl-test").unwrap();
    assert_eq!(result["repaired"], true);
    assert_eq!(result["removedBytes"], 0);
    assert_eq!(result["addedNewline"], true);

    let raw = fs::read_to_string(&file).unwrap();
    assert!(raw.ends_with('\n'));
}

#[test]
fn repair_is_noop_for_healthy_file() {
    let root = temp_root("repair-healthy");
    let events_dir = root.join("cpb-task").join("events").join("demo");
    fs::create_dir_all(&events_dir).unwrap();
    let file = events_dir.join("job-healthy-test.jsonl");

    let valid_event = json!({"type":"job_created","jobId":"j3","project":"demo","task":"t","ts":"T0"});
    fs::write(&file, format!("{}\n", serde_json::to_string(&valid_event).unwrap())).unwrap();

    let result = repair_event_file(&root, "demo", "job-healthy-test").unwrap();
    assert_eq!(result["repaired"], false);
    assert_eq!(result["removedBytes"], 0);
}
