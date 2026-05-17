use anyhow::{anyhow, Result};
use cpb_runtime::{
    acquire_lease, append_event, compile_policy, get_job, list_jobs, read_events, read_lease,
    release_lease, renew_lease,
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
        _ => Err(anyhow!("unknown command: {group} {command}")),
    }
}
