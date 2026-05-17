use chrono::Utc;
use cpb_runtime::{acquire_lease, read_lease};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn temp_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("cpb-runtime-test-{name}-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    fs::create_dir_all(&root).unwrap();
    root
}

#[test]
fn zero_ttl_lease_is_immediately_stale() {
    let root = temp_root("zero-ttl");
    let first = acquire_lease(&root, "lease-job-a-plan", "job-a", "plan", 0, 11).unwrap();
    assert_eq!(first["acquired"], true);

    let second = acquire_lease(&root, "lease-job-a-plan", "job-a", "plan", 1000, 22).unwrap();
    assert_eq!(second["acquired"], true);
    assert_eq!(second["lease"]["ownerPid"], 22);

    let current = read_lease(&root, "lease-job-a-plan").unwrap();
    assert_ne!(current, Value::Null);
    assert_eq!(current["ownerPid"], 22);
}
