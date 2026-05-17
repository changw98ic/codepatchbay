use anyhow::{anyhow, Result};
use cpb_runtime::{
    acquire_lease, append_event, compile_policy, get_job, get_rate_limit, list_backlog,
    list_jobs, list_registry_projects, push_backlog_issue, queue_claim, queue_complete,
    queue_list, queue_push, read_events, read_lease, release_lease, renew_lease,
    repair_event_file, set_rate_limit, upsert_registry_project,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

fn parse_options(tokens: &[String]) -> Result<HashMap<String, String>> {
    let mut options = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let key = tokens[index]
            .strip_prefix("--")
            .ok_or_else(|| anyhow!("unexpected argument: {}", tokens[index]))?;
        let value = tokens
            .get(index + 1)
            .ok_or_else(|| anyhow!("missing value for --{key}"))?;
        if value.starts_with("--") {
            return Err(anyhow!("missing value for --{key}"));
        }
        options.insert(key.to_string(), value.clone());
        index += 2;
    }
    Ok(options)
}

fn required<'a>(options: &'a HashMap<String, String>, key: &str) -> Result<&'a str> {
    options
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| anyhow!("missing --{key}"))
}

fn cpb_root(options: &HashMap<String, String>) -> Result<PathBuf> {
    Ok(PathBuf::from(required(options, "cpb-root")?))
}

fn print_json(value: Value) -> Result<()> {
    println!("{}", serde_json::to_string(&value)?);
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("{err:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [group, command, rest @ ..] = args.as_slice() else {
        return Err(anyhow!("usage: cpb-runtime <group> <command> [options]"));
    };
    let options = parse_options(rest)?;

    match (group.as_str(), command.as_str()) {
        ("events", "append") => {
            let event: Value = serde_json::from_str(required(&options, "event")?)?;
            print_json(append_event(
                &cpb_root(&options)?,
                required(&options, "project")?,
                required(&options, "job-id")?,
                &event,
            )?)
        }
        ("events", "read") => print_json(Value::Array(read_events(
            &cpb_root(&options)?,
            required(&options, "project")?,
            required(&options, "job-id")?,
        )?)),
        ("jobs", "get") => print_json(get_job(
            &cpb_root(&options)?,
            required(&options, "project")?,
            required(&options, "job-id")?,
        )?),
        ("jobs", "list") => print_json(Value::Array(list_jobs(
            &cpb_root(&options)?,
            options.get("project").map(String::as_str),
        )?)),
        ("leases", "acquire") => print_json(acquire_lease(
            &cpb_root(&options)?,
            required(&options, "lease-id")?,
            required(&options, "job-id")?,
            required(&options, "phase")?,
            required(&options, "ttl-ms")?.parse()?,
            options
                .get("owner-pid")
                .and_then(|value| value.parse().ok())
                .unwrap_or_else(std::process::id),
        )?),
        ("leases", "read") => print_json(read_lease(
            &cpb_root(&options)?,
            required(&options, "lease-id")?,
        )?),
        ("leases", "renew") => print_json(serde_json::to_value(renew_lease(
            &cpb_root(&options)?,
            required(&options, "lease-id")?,
            required(&options, "ttl-ms")?.parse()?,
            options.get("owner-token").map(String::as_str),
        )?)?),
        ("leases", "release") => print_json(release_lease(
            &cpb_root(&options)?,
            required(&options, "lease-id")?,
            options.get("owner-token").map(String::as_str),
        )?),
        ("policy", "compile") => print_json(compile_policy(
            required(&options, "role")?,
            options.get("phase").map(String::as_str).unwrap_or(""),
        )),
        ("registry", "upsert") => {
            let project: Value = serde_json::from_str(required(&options, "project-json")?)?;
            print_json(upsert_registry_project(&cpb_root(&options)?, &project)?)
        }
        ("registry", "list") => print_json(Value::Array(list_registry_projects(&cpb_root(&options)?)?)),
        ("backlog", "push") => {
            let issue: Value = serde_json::from_str(required(&options, "issue")?)?;
            print_json(push_backlog_issue(
                &cpb_root(&options)?,
                required(&options, "project")?,
                &issue,
            )?)
        }
        ("backlog", "list") => print_json(Value::Array(list_backlog(
            &cpb_root(&options)?,
            required(&options, "project")?,
        )?)),
        ("rate-limit", "set") => print_json(set_rate_limit(
            &cpb_root(&options)?,
            required(&options, "agent")?,
            required(&options, "until-ts")?,
            options.get("reason").map(String::as_str).unwrap_or(""),
        )?),
        ("rate-limit", "get") => print_json(get_rate_limit(
            &cpb_root(&options)?,
            options.get("agent").map(String::as_str),
        )?),
        ("queue", "push") => {
            let item: Value = serde_json::from_str(required(&options, "item")?)?;
            print_json(queue_push(
                &cpb_root(&options)?,
                required(&options, "project")?,
                &item,
            )?)
        }
        ("queue", "list") => print_json(Value::Array(queue_list(
            &cpb_root(&options)?,
            required(&options, "project")?,
            options.get("status").map(String::as_str),
        )?)),
        ("queue", "claim") => print_json(queue_claim(
            &cpb_root(&options)?,
            required(&options, "project")?,
            options.get("worker").map(String::as_str),
        )?),
        ("queue", "complete") => print_json(queue_complete(
            &cpb_root(&options)?,
            required(&options, "project")?,
            required(&options, "id")?,
        )?),
        ("events", "repair") => print_json(repair_event_file(
            &cpb_root(&options)?,
            required(&options, "project")?,
            required(&options, "job-id")?,
        )?),
        ("runtime", "status") => {
            let exe = std::env::current_exe()?;
            print_json(serde_json::json!({
                "backend": "rust",
                "version": env!("CARGO_PKG_VERSION"),
                "bin": exe.to_string_lossy(),
            }))
        }
        _ => Err(anyhow!("unknown command: {group} {command}")),
    }
}
