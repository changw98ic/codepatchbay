# Create a comprehensive configuration file that includes database connection settings with host port username and password fields, API endpoint configurations for both production and staging environments, logging settings with log level and rotation policy, caching configuration with TTL and eviction strategy, security settings including CORS origins and rate limiting thresholds, feature flags for gradual rollout of new functionality, and monitoring configuration with health check endpoints and metrics collection intervals

<!-- codex -> claude -->
Phase: plan

## Scope

- Project: `calc-test`
- Output file target: `/Users/chengwen/dev/flow/wiki/projects/calc-test/inbox/config/comprehensive-config.md` (to be authored by next execution lane after this plan is handed off)
- Required sections: Database, API, Logging, Caching, Security, Feature Flags, Monitoring
- Constraint: planning output only; no terminal commands run in this phase

## Planning Objectives

1. Define a configuration schema that explicitly includes all requested keys and defaults.
2. Keep the file self-describing (environment-aware with production/staging behavior).
3. Ensure each section has validation rules and rollout-safe defaults.
4. Produce an implementation-ready plan with concrete acceptance criteria for each deliverable.

## Plan (Phase: plan)

1) Clarify assumptions and baseline contract
- Create a normalized glossary of expected config fields, data types, and required/optional semantics.
- Acceptance criteria:
  - A single document section lists: `db`, `api`, `logging`, `cache`, `security`, `feature_flags`, `monitoring`.
  - The glossary states that DB credentials may be stored as placeholders and resolved from environment variables.
  - The plan documents a single source-of-truth file path and precedence order for env overlays.

2) Set file format and structure for environment-safe configuration
- Choose a concrete format (e.g., YAML) and define explicit top-level keys:
  - `environment`: `production | staging`
  - `db`, `api`, `logging`, `cache`, `security`, `feature_flags`, `monitoring`
- Acceptance criteria:
  - The format is deterministic and parseable by existing toolchain in the project context.
  - Includes an example of both shared defaults and environment-specific overrides.
  - Includes comments or notes for each section explaining defaults and risk level.

3) Define database configuration block
- Add `db` with `host`, `port`, `username`, `password`, and connection metadata.
- Acceptance criteria:
  - Mandatory fields: `host` (string), `port` (int), `username` (string), `password` (string/encrypted placeholder).
  - Include connection tuning fields: `database`, `ssl`, `max_connections`, `connection_timeout_ms`.
  - Include environment variants for production and staging, with staging permitted to point to non-production resources.

4) Define API endpoint configuration for production and staging
- Add `api` section with explicit `base_url`, `timeout_ms`, `retry`, and endpoint map.
- Acceptance criteria:
  - Separate endpoint roots for `production` and `staging`.
  - Explicit endpoint definitions include `auth`, `health`, `webhook`, and at least one business endpoint.
  - Include request-level controls: `connect_timeout_ms`, `read_timeout_ms`, `retry_attempts`, `retry_backoff_ms`.

5) Define logging settings with level and rotation policy
- Add `logging` with level policy and file/stream rotation policy.
- Acceptance criteria:
  - `level` supports `debug`, `info`, `warn`, `error`.
  - Rotation fields include `enabled`, `max_size_mb`, `max_files`, `max_age_days`, `compress`.
  - Separate policy for structured and plain logs is documented.

6) Define caching configuration with TTL and eviction strategy
- Add `cache` section for backend, TTL, and eviction rules.
- Acceptance criteria:
  - Includes `provider` (`memory`, `redis`, or similar), `ttl_seconds`, and `eviction_strategy`.
  - Acceptable eviction options include `lru`, `lfu`, `fifo`, `ttl`.
  - Includes `max_items` and `default_ttl_seconds` with explicit units and numeric validation.

7) Define security settings
- Add `security` block containing `cors_origins` and `rate_limit`.
- Acceptance criteria:
  - `cors` includes explicit `allowed_origins`, `allow_credentials`, `allowed_methods`, `allowed_headers`.
  - `rate_limit` includes `requests_per_minute`, `burst`, `window_ms` and `scope` (global/per-user).
  - Includes at least one explicit deny-by-default rule for unknown origins.

8) Define feature flags for gradual rollout
- Add `feature_flags` with rollout control semantics.
- Acceptance criteria:
  - Include flags as objects with `enabled`, `rollout_percent`, and optional `cohort`.
  - At least three flag states represented: `off`, `gradual`, `full`.
  - At least one flag includes a `targeting` key for environment/tenant/stage rollout.

9) Define monitoring configuration
- Add `monitoring` with health checks and metrics collection settings.
- Acceptance criteria:
  - Health check endpoints include `liveness` and `readiness` URLs/paths.
  - `metrics` includes `enabled`, `provider`, `collect_interval_seconds`, and `exporter_endpoint`.
  - Include explicit timeout thresholds and alert thresholds for degraded health.

10) Add validation and handoff package
- Produce a validation checklist and implementation handoff notes for `claude`.
- Acceptance criteria:
  - A machine-readable schema or sample values file can be validated with existing project tooling.
  - No required field is left unspecified in either environment.
  - Handoff includes migration notes for secrets injection and environment override behavior.

## Handoff Notes for Execution Lane

- This plan is intentionally explicit and ordered to reduce integration risk.
- Next lane should draft the concrete config file in one pass after confirming no conflicting secrets policy.
- Keep secrets out of plaintext whenever project standards require secret-manager integration.
- Preserve backward compatibility by keeping existing consumers tolerant of missing optional observability fields.

End of plan.
