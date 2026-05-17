use cpb_runtime::materialize_job;
use serde_json::json;

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
