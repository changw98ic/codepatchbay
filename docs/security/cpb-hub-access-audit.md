# Hub access-audit integrity log

The Hub records every HTTP decision before sending the response. Without the
Redis state backend, the log is a durable SHA-256 hash chain at:

```text
<hub-root>/audit/http-access.jsonl
```

With `CPB_HUB_STATE_REDIS_CONFIG_FILE`, audit records instead use the shared
`cpb:{environment}:access-audit` Redis Stream. `auditSequence`, `auditHash`, and
`auditBytes` live in the control-plane hash. One Lua CAS checks the prior head,
capacity, and record envelope, appends the Stream record, and advances the head
atomically. Concurrent Hub processes retry from the winning head, producing one
global chain. Startup verifies the complete Stream against the head before
accepting traffic.

A non-empty local JSONL chain, pending append, or archive journal makes Redis
cutover fail with `HUB_ACCESS_AUDIT_MIGRATION_REQUIRED`; archive the local chain
first rather than silently hiding it.

Each record contains a monotonically increasing sequence, timestamp, generated
request id, method, path without query parameters, response status, decision,
principal id and source, remote address, required scope, machine error code,
duration, previous hash, and current hash.

The Hub returns `X-CPB-Request-Id` on every response and
`X-CPB-Principal-Id` after successful authentication, allowing reverse-proxy
logs and application audit records to be correlated without recording bearer
tokens.

## Safety properties

- Records are serialized through one writer and fsynced before the HTTP response
  is sent.
- An authenticated, scope-validated worker-broker mutation first fsyncs a
  `mutation_intent` record with the request id before invoking the state change,
  then appends its final allowed/error outcome. If the process crashes between
  them, the unmatched intent makes the outcome explicitly unresolved instead
  of leaving a potentially committed mutation with no audit evidence. Invalid
  credentials and denied scope checks do not create mutation intents.
- A durable pending record makes an interrupted append recoverable. Startup can
  finish a missing append or remove a pending marker when the record was already
  committed.
- A partial final line is truncated only when it is an exact prefix of the
  durable pending record. Unexplained truncation fails startup.
- Startup verifies sequence continuity, exact record schemas, previous hashes,
  every record hash, file privacy, and final-newline integrity.
- The active writer checks file identity, size, metadata fingerprint, and private
  permissions before every append. External replacement or in-place editing
  fails subsequent requests closed.
- Query parameters, authorization headers, request/response bodies, user-agent
  strings, and bearer tokens are not persisted.

If an audit append cannot be committed, the intended API response is replaced by
HTTP `503`:

```json
{
  "error": "service_unavailable",
  "code": "HUB_ACCESS_AUDIT_UNAVAILABLE",
  "message": "Hub access audit is unavailable",
  "requestId": "..."
}
```

The response includes `Retry-After: 5`. Once the writer observes an integrity or
durability failure, it remains fail-closed until Hub restart and recovery.

## Capacity

The log is bounded to 256 MiB by default. Configure another value with:

```sh
export CPB_HUB_ACCESS_AUDIT_MAX_BYTES=536870912
```

The value must be at least 65536 bytes. `cpb doctor` warns at 75% and reports a
critical error at 95%. At the hard limit, requests fail closed rather than
silently dropping audit records or filling the remaining filesystem.
In Redis mode the first committed record pins this value in the shared audit
head; every Hub must use the same value or startup fails with
`HUB_ACCESS_AUDIT_POLICY_MISMATCH`.

Verify the complete chain offline or while no requests are being appended:

```sh
cpb hub verify-access-audit
cpb hub verify-access-audit --json
```

Before the limit is reached, stop the Hub and create an offline archive outside
the Hub root:

```sh
export CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY='at-least-32-non-whitespace-bytes'
cpb hub stop
cpb hub archive-access-audit --output /secure/audit/cpb-2026-07-11
cpb hub verify-access-audit-archive \
  --input /secure/audit/cpb-2026-07-11 \
  --require-signature
```

The output directory contains the exact `http-access.jsonl` segment and a
manifest with its byte size, SHA-256, record count, terminal sequence/hash,
source-Hub identifier hash, manifest hash, and optional HMAC-SHA256 signature.
The archive directory and files are private (`0700`/`0600` on POSIX), reject
symbolic links, and are independently verifiable after being moved.
Retain the signing key version needed for each archive as part of the
organization's key-rotation records; rotating the active key does not re-sign
older archives.

Archiving holds the Hub maintenance lock and refuses a live Hub. It first
publishes and fsyncs the verified archive, then atomically replaces the live log
with an empty private file. A durable journal makes every interruption
recoverable:

Before creating the journal or stage, the command checks the archive target
filesystem can hold the log and still retain 256 MiB by default. Set
`CPB_HUB_MIN_FREE_BYTES` to another non-negative byte count. Insufficient space
fails with `HUB_ACCESS_AUDIT_ARCHIVE_INSUFFICIENT_SPACE` while leaving the live
log untouched.

- before publication, recovery validates and removes only the owned stage while
  preserving the source log;
- after publication, recovery verifies the archive and resets the source only
  when its size and SHA-256 still match;
- divergent source or archive state fails closed with
  `HUB_ACCESS_AUDIT_ARCHIVE_RECOVERY_CONFLICT`.

Hub startup automatically performs this recovery before opening the writer. It
can also be run explicitly while offline:

```sh
cpb hub recover-access-audit-archive
```

After a successful archive the new live segment starts again at sequence 1 and
the genesis hash. Preserve every archive manifest in the retention system;
raising the live limit is an operational escape hatch, not a retention policy.

## Trust boundary and retention

The local SHA-256 chain detects corruption, truncation, reordering, and ordinary
in-place modification. It is not an external immutable timestamp or a secret-key
signature: a privileged attacker who can rewrite the complete log and all local
state can recompute a new chain. Enterprise deployments should continuously
export records and periodic terminal hashes to a separately controlled SIEM,
object-lock bucket, or WORM store.

In Redis mode, ordering and capacity are shared across Hub processes. The
pre-mutation intent closes the silent commit/audit crash window for
worker-broker mutations. Create a point-in-sequence signed export without
pausing writers:

```sh
export CPB_HUB_ACCESS_AUDIT_ARCHIVE_SIGNING_KEY='at-least-32-non-whitespace-bytes'
cpb hub export-access-audit --output /secure/audit/cpb-redis-2026-07-11
cpb hub verify-access-audit-export \
  --input /secure/audit/cpb-redis-2026-07-11 \
  --require-signature
```

The exporter captures the head first and reads exactly that Stream prefix, so
concurrent later appends do not create a false mismatch. It publishes a private
JSONL chain plus a manifest containing size, SHA-256, terminal sequence/hash,
backend identity fingerprint, manifest hash, and optional HMAC-SHA256
signature. Export does not trim the live Stream. Redis is still not an
independently controlled WORM sink: move verified exports and terminal hashes
to separately controlled retention, and validate cross-export continuity. The
existing `archive-access-audit` command remains specific to local JSONL mode.

Archive HMACs authenticate individual manifests, but the local system does not
maintain an externally anchored cross-archive inventory. A privileged operator
could remove an entire archive without the remaining archives proving the gap.
Continuously ship records or manifest hashes to the separately controlled SIEM,
object-lock bucket, or WORM inventory.

`remoteAddress` is operational security data and may be personal data under an
organization's policy. Define access, retention, deletion, and regional storage
rules before production use.
