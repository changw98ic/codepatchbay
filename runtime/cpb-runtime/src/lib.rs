use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process;
use std::thread::sleep;
use std::time::Duration as StdDuration;

fn validate_component(name: &str, value: &str) -> Result<()> {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(anyhow!("invalid {name}"));
    };
    if !first.is_ascii_alphanumeric() {
        return Err(anyhow!("invalid {name}"));
    }
    if !value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err(anyhow!("invalid {name}"));
    }
    Ok(())
}

fn runtime_root(cpb_root: &Path) -> PathBuf {
    cpb_root.join("cpb-task")
}

fn event_file(cpb_root: &Path, project: &str, job_id: &str) -> Result<PathBuf> {
    validate_component("project", project)?;
    validate_component("jobId", job_id)?;
    Ok(runtime_root(cpb_root)
        .join("events")
        .join(project)
        .join(format!("{job_id}.jsonl")))
}

fn lease_file(cpb_root: &Path, lease_id: &str) -> Result<PathBuf> {
    validate_component("leaseId", lease_id)?;
    Ok(runtime_root(cpb_root)
        .join("leases")
        .join(format!("{lease_id}.json")))
}


fn expires_at_for(now: DateTime<Utc>, ttl_ms: i64) -> String {
    (now + Duration::milliseconds(ttl_ms)).to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn append_event(cpb_root: &Path, project: &str, job_id: &str, event: &Value) -> Result<Value> {
    if !event.is_object() {
        return Err(anyhow!("invalid event: expected object"));
    }
    let file = event_file(cpb_root, project, job_id)?;
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let mut out = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .with_context(|| format!("open {}", file.display()))?;
    writeln!(out, "{}", serde_json::to_string(event)?)?;
    Ok(event.clone())
}

pub fn read_events(cpb_root: &Path, project: &str, job_id: &str) -> Result<Vec<Value>> {
    let file = event_file(cpb_root, project, job_id)?;
    if !file.exists() {
        return Ok(Vec::new());
    }

    let raw = fs::read_to_string(&file).with_context(|| format!("read {}", file.display()))?;
    let has_trailing_newline = raw.ends_with('\n');
    let lines: Vec<&str> = raw.split('\n').collect();
    let mut events = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(err) => {
                if index == lines.len() - 1 && !has_trailing_newline {
                    break;
                }
                return Err(anyhow!(
                    "malformed event JSON in {} at line {}: {}",
                    file.display(),
                    index + 1,
                    err
                ));
            }
        };
        if !value.is_object() {
            return Err(anyhow!(
                "{} at line {}: malformed event: expected object",
                file.display(),
                index + 1
            ));
        }
        events.push(value);
    }
    Ok(events)
}

fn set(state: &mut Map<String, Value>, key: &str, value: impl Into<Value>) {
    state.insert(key.to_string(), value.into());
}

fn copy_if_present(state: &mut Map<String, Value>, event: &Map<String, Value>, key: &str) {
    if let Some(value) = event.get(key) {
        set(state, key, value.clone());
    }
}

fn set_from_event_or_existing(
    state: &mut Map<String, Value>,
    event: &Map<String, Value>,
    target_key: &str,
    event_key: &str,
    default_value: Value,
) {
    let value = event
        .get(event_key)
        .cloned()
        .or_else(|| state.get(target_key).cloned())
        .unwrap_or(default_value);
    set(state, target_key, value);
}

fn event_str<'a>(event: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    event.get(key).and_then(Value::as_str)
}

fn ensure_artifacts(state: &mut Map<String, Value>) -> &mut Map<String, Value> {
    if !state.get("artifacts").is_some_and(Value::is_object) {
        set(state, "artifacts", json!({}));
    }
    state
        .get_mut("artifacts")
        .and_then(Value::as_object_mut)
        .expect("artifacts object")
}

fn post_terminal_allowed() -> HashSet<&'static str> {
    HashSet::from([
        "job_completed",
        "job_failed",
        "job_blocked",
        "job_cancelled",
        "job_cancel_requested",
        "job_redirect_consumed",
        "job_retried",
        "phase_activity",
        "workflow_selected",
    ])
}

pub fn materialize_job(events: &[Value]) -> Value {
    let mut state = json!({
        "jobId": null,
        "project": null,
        "task": null,
        "status": null,
        "phase": null,
        "attempt": null,
        "workflow": null,
        "artifacts": {},
        "leaseId": null,
        "worktree": null,
        "createdAt": null,
        "updatedAt": null,
        "blockedReason": null,
        "failureCode": null,
        "failurePhase": null,
        "retryable": false,
        "retryCount": 0,
        "failureCause": null,
        "cancelRequested": false,
        "cancelReason": null,
        "redirectContext": null,
        "redirectReason": null,
        "redirectEventId": null,
        "consumedRedirectIds": [],
        "lastActivityAt": null,
        "lastActivityMessage": null
    })
    .as_object()
    .expect("state object")
    .clone();

    let allowed = post_terminal_allowed();
    let mut terminal = false;

    for value in events {
        let Some(event) = value.as_object() else {
            continue;
        };
        copy_if_present(&mut state, event, "jobId");
        copy_if_present(&mut state, event, "project");
        copy_if_present(&mut state, event, "attempt");
        copy_if_present(&mut state, event, "workflow");
        if let Some(ts) = event.get("ts") {
            set(&mut state, "updatedAt", ts.clone());
        }

        let event_type = event_str(event, "type").unwrap_or_default();
        if terminal && !allowed.contains(event_type) {
            continue;
        }

        match event_type {
            "job_created" => {
                copy_if_present(&mut state, event, "task");
                set(&mut state, "status", "running");
                if let Some(ts) = event.get("ts") {
                    set(&mut state, "createdAt", ts.clone());
                }
                set(&mut state, "blockedReason", Value::Null);
                terminal = false;
            }
            "worktree_created" => {
                if let Some(worktree) = event.get("worktree").or_else(|| event.get("path")) {
                    set(&mut state, "worktree", worktree.clone());
                }
            }
            "phase_started" => {
                copy_if_present(&mut state, event, "phase");
                set(&mut state, "leaseId", event.get("leaseId").cloned().unwrap_or(Value::Null));
                set(&mut state, "status", "running");
                set(&mut state, "blockedReason", Value::Null);
            }
            "phase_completed" => {
                copy_if_present(&mut state, event, "phase");
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "status", "running");
                if let (Some(phase), Some(artifact)) = (event_str(event, "phase"), event.get("artifact")) {
                    ensure_artifacts(&mut state).insert(phase.to_string(), artifact.clone());
                }
            }
            "phase_failed" => {
                copy_if_present(&mut state, event, "phase");
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "status", "failed");
                set(&mut state, "blockedReason", event.get("error").or_else(|| event.get("reason")).cloned().unwrap_or(Value::Null));
                set_from_event_or_existing(&mut state, event, "failureCode", "code", Value::Null);
                set_from_event_or_existing(&mut state, event, "failurePhase", "phase", Value::Null);
                set_from_event_or_existing(&mut state, event, "retryable", "retryable", json!(false));
                set_from_event_or_existing(&mut state, event, "retryCount", "retryCount", json!(0));
                set_from_event_or_existing(&mut state, event, "failureCause", "cause", Value::Null);
                terminal = true;
            }
            "budget_exceeded" => {
                set(&mut state, "status", "blocked");
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "blockedReason", event.get("reason").cloned().unwrap_or_else(|| json!("budget exceeded")));
                terminal = true;
            }
            "job_blocked" => {
                set(&mut state, "status", "blocked");
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "blockedReason", event.get("reason").or_else(|| event.get("blockedReason")).cloned().unwrap_or(Value::Null));
                terminal = true;
            }
            "job_failed" => {
                set(&mut state, "status", "failed");
                set(&mut state, "leaseId", Value::Null);
                let blocked_reason = event
                    .get("reason")
                    .or_else(|| event.get("error"))
                    .cloned()
                    .or_else(|| state.get("blockedReason").cloned())
                    .unwrap_or(Value::Null);
                set(&mut state, "blockedReason", blocked_reason);
                set_from_event_or_existing(&mut state, event, "failureCode", "code", Value::Null);
                set_from_event_or_existing(&mut state, event, "failurePhase", "phase", Value::Null);
                set_from_event_or_existing(&mut state, event, "retryable", "retryable", json!(false));
                set_from_event_or_existing(&mut state, event, "retryCount", "retryCount", json!(0));
                set_from_event_or_existing(&mut state, event, "failureCause", "cause", Value::Null);
                terminal = true;
            }
            "job_completed" => {
                set(&mut state, "status", "completed");
                set(&mut state, "phase", "completed");
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "blockedReason", Value::Null);
                set(&mut state, "failureCode", Value::Null);
                set(&mut state, "failurePhase", Value::Null);
                set(&mut state, "retryable", false);
                set(&mut state, "retryCount", 0);
                set(&mut state, "failureCause", Value::Null);
                terminal = true;
            }
            "job_cancel_requested" => {
                set(&mut state, "cancelRequested", true);
                set(&mut state, "cancelReason", event.get("reason").cloned().unwrap_or(Value::Null));
            }
            "job_cancelled" => {
                set(&mut state, "cancelRequested", true);
                set(&mut state, "status", "cancelled");
                set(&mut state, "leaseId", Value::Null);
                terminal = true;
            }
            "job_redirect_requested" => {
                set(&mut state, "redirectContext", event.get("instructions").cloned().unwrap_or(Value::Null));
                set(&mut state, "redirectReason", event.get("reason").cloned().unwrap_or(Value::Null));
                set(&mut state, "redirectEventId", event.get("redirectEventId").cloned().unwrap_or(Value::Null));
            }
            "job_redirect_consumed" => {
                if let Some(id) = event.get("redirectEventId") {
                    let mut ids = state
                        .get("consumedRedirectIds")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    ids.push(id.clone());
                    set(&mut state, "consumedRedirectIds", Value::Array(ids));

                    let current_redirect = state.get("redirectEventId").cloned().unwrap_or(Value::Null);
                    if current_redirect == *id {
                        set(&mut state, "redirectContext", Value::Null);
                        set(&mut state, "redirectReason", Value::Null);
                        set(&mut state, "redirectEventId", Value::Null);
                    }
                }
            }
            "job_retried" => {
                set(&mut state, "status", "running");
                let retry_phase = event
                    .get("fromPhase")
                    .cloned()
                    .or_else(|| state.get("phase").cloned())
                    .unwrap_or(Value::Null);
                set(&mut state, "phase", retry_phase);
                set(&mut state, "leaseId", Value::Null);
                set(&mut state, "blockedReason", Value::Null);
                set(&mut state, "failureCode", Value::Null);
                set(&mut state, "failurePhase", Value::Null);
                set(&mut state, "retryable", false);
                set_from_event_or_existing(&mut state, event, "retryCount", "retryCount", json!(0));
                set(&mut state, "failureCause", Value::Null);
                if let Some(clear) = event.get("clearArtifacts").and_then(Value::as_array) {
                    let artifacts = ensure_artifacts(&mut state);
                    for phase in clear.iter().filter_map(Value::as_str) {
                        artifacts.remove(phase);
                    }
                }
                terminal = false;
            }
            "phase_activity" => {
                set(&mut state, "lastActivityAt", event.get("ts").cloned().unwrap_or(Value::Null));
                set(&mut state, "lastActivityMessage", event.get("message").cloned().unwrap_or(Value::Null));
            }
            "workflow_selected" => {
                copy_if_present(&mut state, event, "workflow");
            }
            _ => {}
        }
    }

    Value::Object(state)
}

pub fn get_job(cpb_root: &Path, project: &str, job_id: &str) -> Result<Value> {
    let events = read_events(cpb_root, project, job_id)?;
    Ok(materialize_job(&events))
}

pub fn list_jobs(cpb_root: &Path, project_filter: Option<&str>) -> Result<Vec<Value>> {
    let events_root = runtime_root(cpb_root).join("events");
    if !events_root.exists() {
        return Ok(Vec::new());
    }

    let mut jobs = Vec::new();
    for project_entry in fs::read_dir(events_root)? {
        let project_entry = project_entry?;
        if !project_entry.file_type()?.is_dir() {
            continue;
        }
        let project = project_entry.file_name().to_string_lossy().to_string();
        if let Some(filter) = project_filter {
            if project != filter {
                continue;
            }
        }
        if validate_component("project", &project).is_err() {
            continue;
        }
        for job_entry in fs::read_dir(project_entry.path())? {
            let job_entry = job_entry?;
            if !job_entry.file_type()?.is_file() {
                continue;
            }
            let file_name = job_entry.file_name().to_string_lossy().to_string();
            let Some(job_id) = file_name.strip_suffix(".jsonl") else {
                continue;
            };
            if validate_component("jobId", job_id).is_err() {
                continue;
            }
            let events = read_events(cpb_root, &project, job_id)?;
            if events.is_empty() {
                continue;
            }
            let job = materialize_job(&events);
            let has_identity = job.get("jobId").and_then(Value::as_str).is_some()
                && job.get("project").and_then(Value::as_str).is_some()
                && job.get("createdAt").and_then(Value::as_str).is_some();
            if has_identity {
                jobs.push(job);
            }
        }
    }
    jobs.sort_by(|a, b| {
        b.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(a.get("updatedAt").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(jobs)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub lease_id: String,
    pub job_id: String,
    pub phase: String,
    pub owner_pid: u32,
    pub owner_host: String,
    pub owner_token: String,
    pub acquired_at: String,
    pub heartbeat_at: String,
    pub expires_at: String,
}

fn owner_host() -> String {
    std::env::var("HOSTNAME").unwrap_or_else(|_| "localhost".to_string())
}

fn owner_token() -> String {
    format!("rust-{}-{}", process::id(), Utc::now().timestamp_nanos_opt().unwrap_or_default())
}

fn create_lease(lease_id: &str, job_id: &str, phase: &str, ttl_ms: i64, owner_pid: u32) -> Lease {
    let now = Utc::now();
    let timestamp = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    Lease {
        lease_id: lease_id.to_string(),
        job_id: job_id.to_string(),
        phase: phase.to_string(),
        owner_pid,
        owner_host: owner_host(),
        owner_token: owner_token(),
        acquired_at: timestamp.clone(),
        heartbeat_at: timestamp,
        expires_at: expires_at_for(now, ttl_ms),
    }
}

const LEASE_LOCK_TTL_MS: u128 = 30_000;

fn lease_lock_dir(file: &Path) -> PathBuf {
    PathBuf::from(format!("{}.lock", file.to_string_lossy()))
}

fn is_lock_stale(lock_dir: &Path) -> bool {
    fs::metadata(lock_dir)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map(|elapsed| elapsed.as_millis() >= LEASE_LOCK_TTL_MS)
        .unwrap_or(true)
}

fn with_lease_lock<T, F>(file: &Path, callback: F) -> Result<T>
where
    F: FnOnce() -> Result<T>,
{
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }

    let lock_dir = lease_lock_dir(file);
    let mut acquired = false;
    for _ in 0..50 {
        match fs::create_dir(&lock_dir) {
            Ok(()) => {
                acquired = true;
                break;
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                if is_lock_stale(&lock_dir) {
                    let _ = fs::remove_dir_all(&lock_dir);
                    continue;
                }
                sleep(StdDuration::from_millis(10));
            }
            Err(err) => return Err(err).with_context(|| format!("create {}", lock_dir.display())),
        }
    }

    if !acquired {
        return Err(anyhow!("lease lock busy: {}", file.display()));
    }

    let result = callback();
    let cleanup = fs::remove_dir_all(&lock_dir);
    if result.is_ok() {
        cleanup.with_context(|| format!("remove {}", lock_dir.display()))?;
    } else {
        let _ = cleanup;
    }
    result
}

fn read_lease_file(file: &Path) -> Result<Option<Lease>> {
    if !file.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(file).with_context(|| format!("read {}", file.display()))?;
    Ok(Some(serde_json::from_str(&raw).with_context(|| format!("parse {}", file.display()))?))
}

fn write_lease_file(file: &Path, lease: &Lease) -> Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = file.with_extension(format!("json.{}.tmp", process::id()));
    fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(lease)?))?;
    fs::rename(&temp, file).with_context(|| format!("rename {}", file.display()))?;
    Ok(())
}

pub fn is_lease_stale(lease: &Lease) -> bool {
    DateTime::parse_from_rfc3339(&lease.expires_at)
        .map(|expires_at| expires_at.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true)
}

pub fn acquire_lease(cpb_root: &Path, lease_id: &str, job_id: &str, phase: &str, ttl_ms: i64, owner_pid: u32) -> Result<Value> {
    let file = lease_file(cpb_root, lease_id)?;
    with_lease_lock(&file, || {
        let lease = create_lease(lease_id, job_id, phase, ttl_ms, owner_pid);
        if let Some(existing) = read_lease_file(&file)? {
            if !is_lease_stale(&existing) {
                return Ok(json!({ "acquired": false, "lease": existing }));
            }
        }
        write_lease_file(&file, &lease)?;
        Ok(json!({ "acquired": true, "lease": lease }))
    })
}

pub fn read_lease(cpb_root: &Path, lease_id: &str) -> Result<Value> {
    let file = lease_file(cpb_root, lease_id)?;
    Ok(match read_lease_file(&file)? {
        Some(lease) => serde_json::to_value(lease)?,
        None => Value::Null,
    })
}

pub fn renew_lease(cpb_root: &Path, lease_id: &str, ttl_ms: i64, owner_token: Option<&str>) -> Result<Lease> {
    let file = lease_file(cpb_root, lease_id)?;
    with_lease_lock(&file, || {
        let mut lease = read_lease_file(&file)?.ok_or_else(|| anyhow!("lease not found: {lease_id}"))?;
        if let Some(owner_token) = owner_token {
            if lease.owner_token != owner_token {
                return Err(anyhow!("lease owner mismatch"));
            }
        } else {
            return Err(anyhow!("lease owner mismatch"));
        }
        let now = Utc::now();
        lease.heartbeat_at = now.to_rfc3339_opts(SecondsFormat::Millis, true);
        lease.expires_at = expires_at_for(now, ttl_ms);
        write_lease_file(&file, &lease)?;
        Ok(lease)
    })
}

pub fn release_lease(cpb_root: &Path, lease_id: &str, owner_token: Option<&str>) -> Result<Value> {
    let file = lease_file(cpb_root, lease_id)?;
    with_lease_lock(&file, || {
        let Some(lease) = read_lease_file(&file)? else {
            return Ok(json!({ "released": false }));
        };
        if let Some(owner_token) = owner_token {
            if lease.owner_token != owner_token {
                return Err(anyhow!("lease owner mismatch"));
            }
        } else {
            return Err(anyhow!("lease owner mismatch"));
        }
        fs::remove_file(&file)?;
        Ok(json!({ "released": true }))
    })
}

pub fn compile_policy(role: &str, phase: &str) -> Value {
    let mut env = Map::new();
    env.insert("CPB_ACP_PERMISSION".to_string(), json!("reject"));
    env.insert("CPB_ACP_TERMINAL".to_string(), json!(if phase == "verify" { "read-only" } else { "limited" }));
    if role == "codex" || role == "codex_verify" || phase == "plan" || phase == "review" {
        env.insert("CPB_ACP_WRITE_ALLOW".to_string(), json!("wiki"));
    }
    if role == "claude" || phase == "execute" {
        env.insert("CPB_ACP_WRITE_ALLOW".to_string(), json!("project,wiki-output"));
    }
    json!({
        "role": role,
        "phase": phase,
        "env": env,
        "experimental": true
    })
}

fn hub_registry_file(hub_root: &Path) -> PathBuf {
    hub_root.join("projects.json")
}

fn evolve_backlog_file(project_root: &Path, project: &str) -> Result<PathBuf> {
    validate_component("project", project)?;
    Ok(project_root
        .join("cpb-task")
        .join("evolve")
        .join(project)
        .join("backlog.json"))
}

fn rate_limit_file(hub_root: &Path) -> PathBuf {
    hub_root.join("providers").join("rate-limits.json")
}

fn read_json_or(file: &Path, fallback: Value) -> Result<Value> {
    match fs::read_to_string(file) {
        Ok(raw) => Ok(serde_json::from_str(&raw).with_context(|| format!("parse {}", file.display()))?),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(fallback),
        Err(err) => Err(err).with_context(|| format!("read {}", file.display())),
    }
}

fn write_json_atomic(file: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let temp = file.with_extension(format!("json.{}.tmp", process::id()));
    fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(value)?))
        .with_context(|| format!("write {}", temp.display()))?;
    fs::rename(&temp, file).with_context(|| format!("rename {}", file.display()))?;
    Ok(())
}

fn registry_default() -> Value {
    json!({
        "version": 1,
        "updatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "projects": {}
    })
}

pub fn upsert_registry_project(hub_root: &Path, project: &Value) -> Result<Value> {
    let project_obj = project
        .as_object()
        .ok_or_else(|| anyhow!("project must be an object"))?;
    let id = project_obj
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("project.id is required"))?;
    validate_component("project", id)?;
    let source_path = project_obj
        .get("sourcePath")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("project.sourcePath is required"))?;
    if source_path.trim().is_empty() {
        return Err(anyhow!("project.sourcePath is required"));
    }

    let file = hub_registry_file(hub_root);
    let mut registry = read_json_or(&file, registry_default())?;
    if !registry.get("projects").is_some_and(Value::is_object) {
        registry["projects"] = json!({});
    }
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut next = project.clone();
    if next.get("createdAt").is_none() {
        next["createdAt"] = json!(now.clone());
    }
    next["updatedAt"] = json!(now.clone());
    registry["version"] = json!(1);
    registry["updatedAt"] = json!(now);
    registry["projects"][id] = next.clone();
    write_json_atomic(&file, &registry)?;
    Ok(next)
}

pub fn list_registry_projects(hub_root: &Path) -> Result<Vec<Value>> {
    let registry = read_json_or(&hub_registry_file(hub_root), registry_default())?;
    let mut projects: Vec<Value> = registry
        .get("projects")
        .and_then(Value::as_object)
        .map(|projects| projects.values().cloned().collect())
        .unwrap_or_default();
    projects.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or_default())
    });
    Ok(projects)
}

pub fn push_backlog_issue(project_root: &Path, project: &str, issue: &Value) -> Result<Value> {
    if !issue.is_object() {
        return Err(anyhow!("issue must be an object"));
    }
    let file = evolve_backlog_file(project_root, project)?;
    let mut backlog = read_json_or(&file, json!([]))?;
    let items = backlog
        .as_array_mut()
        .ok_or_else(|| anyhow!("backlog must be an array"))?;
    let description = issue.get("description").and_then(Value::as_str).unwrap_or_default();
    let duplicate = !description.is_empty()
        && items
            .iter()
            .any(|item| item.get("description").and_then(Value::as_str) == Some(description));
    if !duplicate {
        let mut next = issue.clone();
        next["project"] = json!(project);
        if next.get("status").is_none() {
            next["status"] = json!("pending");
        }
        if next.get("createdAt").is_none() {
            next["createdAt"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
        }
        items.push(next);
    }
    let total = items.len();
    write_json_atomic(&file, &backlog)?;
    Ok(json!({ "total": total, "added": !duplicate }))
}

pub fn list_backlog(project_root: &Path, project: &str) -> Result<Vec<Value>> {
    let backlog = read_json_or(&evolve_backlog_file(project_root, project)?, json!([]))?;
    Ok(backlog.as_array().cloned().unwrap_or_default())
}

pub fn set_rate_limit(hub_root: &Path, agent: &str, until_ts: &str, reason: &str) -> Result<Value> {
    validate_component("agent", agent)?;
    let file = rate_limit_file(hub_root);
    let mut state = read_json_or(&file, json!({}))?;
    if !state.is_object() {
        state = json!({});
    }
    state[agent] = json!({
        "agent": agent,
        "untilTs": until_ts,
        "reason": reason,
        "updatedAt": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
    });
    write_json_atomic(&file, &state)?;
    Ok(state[agent].clone())
}

pub fn get_rate_limit(hub_root: &Path, agent: Option<&str>) -> Result<Value> {
    let state = read_json_or(&rate_limit_file(hub_root), json!({}))?;
    if let Some(agent) = agent {
        validate_component("agent", agent)?;
        return Ok(state.get(agent).cloned().unwrap_or(Value::Null));
    }
    Ok(state)
}

fn queue_file(cpb_root: &Path, project: &str) -> Result<PathBuf> {
    validate_component("project", project)?;
    Ok(runtime_root(cpb_root).join("queue").join(project).join("queue.json"))
}

fn read_queue(file: &Path) -> Result<Vec<Value>> {
    let raw = read_json_or(file, json!([]))?;
    Ok(raw.as_array().cloned().unwrap_or_default())
}

pub fn queue_push(cpb_root: &Path, project: &str, item: &Value) -> Result<Value> {
    if !item.is_object() {
        return Err(anyhow!("queue item must be an object"));
    }
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("queue item.id is required"))?;
    if id.trim().is_empty() {
        return Err(anyhow!("queue item.id must not be empty"));
    }
    let file = queue_file(cpb_root, project)?;
    let mut queue = read_queue(&file)?;
    let duplicate = queue.iter().any(|q| q.get("id").and_then(Value::as_str) == Some(id));
    if duplicate {
        return Ok(json!({ "pushed": false, "id": id }));
    }
    let mut entry = item.clone();
    entry["project"] = json!(project);
    if entry.get("status").is_none() {
        entry["status"] = json!("pending");
    }
    if entry.get("createdAt").is_none() {
        entry["createdAt"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    entry["updatedAt"] = json!(Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true));
    let id_owned = id.to_string();
    queue.push(entry);
    write_json_atomic(&file, &Value::Array(queue))?;
    Ok(json!({ "pushed": true, "id": id_owned }))
}

pub fn queue_list(cpb_root: &Path, project: &str, status_filter: Option<&str>) -> Result<Vec<Value>> {
    let file = queue_file(cpb_root, project)?;
    let queue = read_queue(&file)?;
    Ok(match status_filter {
        Some(filter) => queue
            .into_iter()
            .filter(|item| item.get("status").and_then(Value::as_str) == Some(filter))
            .collect(),
        None => queue,
    })
}

pub fn queue_claim(cpb_root: &Path, project: &str, worker: Option<&str>) -> Result<Value> {
    let file = queue_file(cpb_root, project)?;
    let mut queue = read_queue(&file)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let index = queue
        .iter()
        .position(|item| item.get("status").and_then(Value::as_str) == Some("pending"));
    let Some(index) = index else {
        return Ok(Value::Null);
    };
    queue[index]["status"] = json!("claimed");
    queue[index]["claimedBy"] = json!(worker.unwrap_or("unknown"));
    queue[index]["claimedAt"] = json!(now.clone());
    queue[index]["updatedAt"] = json!(now);
    let claimed = queue[index].clone();
    write_json_atomic(&file, &Value::Array(queue))?;
    Ok(claimed)
}

pub fn queue_complete(cpb_root: &Path, project: &str, item_id: &str) -> Result<Value> {
    let file = queue_file(cpb_root, project)?;
    let mut queue = read_queue(&file)?;
    let now = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let index = queue
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(item_id));
    let Some(index) = index else {
        return Ok(json!({ "completed": false, "id": item_id, "reason": "not found" }));
    };
    let current_status = queue[index].get("status").and_then(Value::as_str).unwrap_or_default();
    if current_status != "claimed" {
        return Ok(json!({ "completed": false, "id": item_id, "reason": "not claimed" }));
    }
    queue[index]["status"] = json!("completed");
    queue[index]["completedAt"] = json!(now.clone());
    queue[index]["updatedAt"] = json!(now);
    let id = item_id.to_string();
    write_json_atomic(&file, &Value::Array(queue))?;
    Ok(json!({ "completed": true, "id": id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cpb-runtime-{name}-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn zero_ttl_lease_can_be_reacquired() {
        let root = temp_root("lease");
        let first = acquire_lease(&root, "lease-job-1-plan", "job-1", "plan", 0, 1).unwrap();
        assert_eq!(first["acquired"], true);
        let second = acquire_lease(&root, "lease-job-1-plan", "job-1", "plan", 50, 2).unwrap();
        assert_eq!(second["acquired"], true);
        assert_eq!(second["lease"]["ownerPid"], 2);
    }

    #[test]
    fn materializer_preserves_terminal_priority() {
        let events = vec![
            json!({"type":"job_created","jobId":"j1","project":"p","task":"t","ts":"T0"}),
            json!({"type":"phase_started","jobId":"j1","phase":"plan","leaseId":"l1","ts":"T1"}),
            json!({"type":"job_completed","jobId":"j1","ts":"T2"}),
            json!({"type":"phase_started","jobId":"j1","phase":"execute","leaseId":"l2","ts":"T3"}),
            json!({"type":"phase_activity","jobId":"j1","message":"late","ts":"T4"}),
        ];
        let job = materialize_job(&events);
        assert_eq!(job["status"], "completed");
        assert_eq!(job["phase"], "completed");
        assert_eq!(job["leaseId"], Value::Null);
        assert_eq!(job["lastActivityMessage"], "late");
    }

    #[test]
    fn registry_backlog_and_rate_limit_are_durable() {
        let hub = temp_root("hub");
        let project_root = temp_root("project");
        let project = json!({
            "id": "calc-test",
            "name": "calc-test",
            "sourcePath": project_root.to_string_lossy()
        });
        let saved = upsert_registry_project(&hub, &project).unwrap();
        assert_eq!(saved["id"], "calc-test");
        let projects = list_registry_projects(&hub).unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(
            projects[0]["sourcePath"].as_str(),
            Some(project_root.to_string_lossy().as_ref())
        );

        let pushed = push_backlog_issue(&project_root, "calc-test", &json!({
            "priority": "P1",
            "description": "tighten calculator parsing"
        })).unwrap();
        assert_eq!(pushed["added"], true);
        let duplicate = push_backlog_issue(&project_root, "calc-test", &json!({
            "priority": "P1",
            "description": "tighten calculator parsing"
        })).unwrap();
        assert_eq!(duplicate["added"], false);
        assert_eq!(list_backlog(&project_root, "calc-test").unwrap().len(), 1);

        let limit = set_rate_limit(&hub, "codex", "2026-05-17T00:00:00.000Z", "429").unwrap();
        assert_eq!(limit["agent"], "codex");
        assert_eq!(get_rate_limit(&hub, Some("codex")).unwrap()["reason"], "429");
    }
}
