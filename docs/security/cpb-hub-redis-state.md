# Hub Redis control-plane state

CodePatchBay can store the Hub project registry, leader lease, monotonic leader
epoch, and queue in one Redis hash. Registry and queue changes use atomic
compare-and-swap (CAS) transactions. Leader acquisition, renewal, release, and
queue fencing use Redis server time and Lua transactions, so a process that
resumes after failover cannot commit a queue write with its stale epoch.

This is **not yet a claim that the complete Hub is highly available**.
Assignment state, attempt identity, heartbeat/cancel/result state, worker
registry, and worker inbox claims also use Redis CAS records. Leader-owned
assignment and inbox writes validate the Redis epoch; workers use an
incarnation-bound claim token with a Redis-server-time lease. Terminal
assignment commit and inbox acknowledgement share one Lua transaction.
Execution leases also use owner-token CAS and Redis server time. Job events use
Redis Streams, while their materialized projections advance in the same Lua
transaction. Local job indexes/checkpoints are non-authoritative diagnostics in
Redis mode. HTTP access audit uses a shared Redis Stream with a global
sequence/hash/byte-count CAS head; diagnostic artifacts remain non-authoritative
local or shared filesystem state.
Multiple control-plane nodes may contend for the shared leader lease, but full
active-active scheduling remains unsupported.
After a process releases a Redis leader lease, its retired fence remains armed
until process exit so unfinished callbacks cannot borrow a later epoch or fall
back to unfenced writes. Reacquiring leadership therefore requires a new
orchestrator process.

## Configuration

Set `CPB_HUB_STATE_REDIS_CONFIG_FILE` to an absolute path outside
`CPB_HUB_ROOT`. The file must be a regular non-symlink file and, on POSIX, must
not be accessible by group or other users (normally mode `0600`). The Hub child
receives only this path; Redis credentials are not copied into agent process
environments or Hub backups.

```json
{
  "format": "cpb-hub-state-redis/v1",
  "url": "rediss://cpb-hub:URL_ENCODED_PASSWORD@redis.example.com:6379/0",
  "registryKey": "cpb:{production}:hub-registry",
  "topology": "stable-primary-endpoint",
  "connectTimeoutMs": 2000,
  "operationTimeoutMs": 5000
}
```

`registryKey` is the control-plane state key and is required so separate
environments cannot accidentally share one authority. It must be 1–256 UTF-8
bytes without whitespace or control characters and must contain a non-empty
Redis hash tag such as `{production}`. Registry, leader, and queue
fields deliberately share this one key, avoiding Redis Cluster cross-slot
transactions. Use a hash tag, as in `{production}`, if an external
cluster-aware proxy routes it. Job event streams use keys under
`cpb:{production}:job-events:*`, keeping their atomic projection update in the
same Redis Cluster slot. The Redis ACL principal therefore needs access to both
the exact registry hash and this event-stream prefix, including `XADD` and
`XRANGE` through the Lua transaction path.

Remote connections must use `rediss://`; cleartext `redis://` is accepted only
for a loopback address. TLS uses the operating system trust store and always
verifies the server certificate. The URL supports Redis ACL username/password
authentication or password-only authentication. Percent-encode reserved URL
characters in credentials. Query parameters and fragments are rejected.
Redis 7 or newer is required. The only supported topology contract is
`stable-primary-endpoint`: the configured URL must always resolve or route to
the current writable primary. Startup calls `ROLE` and refuses a replica with
`HUB_STATE_BACKEND_NOT_PRIMARY`; it also uses `redis.acl_check_cmd` to verify
that the configured principal can read and write the state hash and call
`TIME` and `ROLE` through the preflight path without mutating state. The Redis
ACL must therefore grant `ROLE` in addition to the documented state commands.

The config is re-read for each short state operation. Credentials and timeout
values can therefore be rotated by atomically replacing a file while the
endpoint, TLS mode, database, and `registryKey` remain unchanged. Each
operation binds its read and CAS to one validated config snapshot. A running
process pins that backend identity and rejects any live switch to local-file
mode, another endpoint, database, or key. Such an identity change requires a
full stop of every control-plane process; otherwise an old process could still
commit to the former authority while a new process writes the replacement.

Commands sharing one validated config snapshot reuse a bounded pool of at most
eight authenticated connections. Idle connections are unreferenced immediately
so short-lived CLI processes can exit, and are closed after 15 seconds. A
protocol, timeout, or socket failure discards that connection. Commands are not
automatically replayed because a failed write may already have committed in
Redis; callers must resolve the result through their revision/CAS state. State
record scans request four records per HSCAN page, keeping the requested payload
within the 17 MiB RESP limit for 4 MiB records while reducing round trips. Redis
may treat COUNT as a hint, so oversized replies still fail closed.

Invalid permissions, malformed JSON, an unreachable endpoint, authentication
failure, protocol errors, and oversized responses fail closed. Returned errors
and readiness output do not contain the Redis URL, credentials, registry key,
or upstream diagnostic text. Canonical path checks reject both a direct config
inside `CPB_HUB_ROOT` and an outside-looking path whose ancestor symlink leads
back into the Hub root. POSIX config files with multiple hard links are also
rejected so another directory entry cannot place the same credential inode in
a Hub backup.

## Atomicity and failure behavior

The registry is stored as `revision` and `data`; the queue is stored as
`queueRevision` and `queueData`. Atomic Lua scripts compare revisions and write
each pair only when the expected revision still matches. Queue transactions
retry a bounded number of times after a CAS loss. When the process holds the
leader lease, its queue transaction captures `hubId`, `lockToken`, and epoch
before doing work; the commit script checks that identity and the unexpired
lease using Redis `TIME`. A stale leader fails with `HUB_LEADER_FENCED` even if
it passed an earlier in-process `stillHeld()` check. A stale `saveRegistry`
snapshot is not retried; it fails with `HUB_REGISTRY_CONFLICT`.

Assignments, workers, and inbox items use individually revisioned fields in
the same Redis hash. Deletion leaves a revisioned tombstone so a delayed CAS
cannot recreate an old inbox item through an ABA cycle. New tombstones carry a
Redis-server-time `deletedAtMs`; legacy tombstones without that field are first
timestamped, not immediately removed, by the retention workflow. Inbox identity includes
the assignment attempt and attempt token. A worker claims at most one item,
atomically changes it from `pending` to `processing`, receives a random claim
token, and renews its claim against Redis server time. Expired processing
claims are recoverable. Worker registry transitions carry an incarnation token
and expected assignment/attempt/status so a late completion cannot clear a new
reservation. Terminal assignment results are first-writer-wins and cannot be
revived by a delayed worker. Managed-worker processes never receive the private
Redis config. The Hub issues a random capability whose hash is bound to one
worker incarnation, stores only the hash, and accepts only allowlisted worker,
inbox, assignment, project, job, event, and artifact operations scoped to the
worker's active assignment. The plaintext capability is removed from the
process environment before repository-controlled work starts. An exited or
restarted worker is denied and its stored capability hash is cleared.

The Hub performs bounded `PING`, primary-role, registry-read, Lua execution,
CAS-write, and assignment/worker/inbox record scans
permission preflights at startup. If configured Redis is unavailable or its ACL
can ping but cannot prove a writable primary, read state, and commit registry
state, startup fails rather than silently falling back to a local file.
Runtime state-backend failures produce a generic HTTP `503` with
`Retry-After: 5`. `cpb doctor`, run with the same environment as the Hub,
reports `redis-cas` only after a live preflight and a secure
`CPB_HUB_WORKER_BROKER_URL` is configured. It reports `multiNodeSafe: true`
after the shared access-audit head also passes preflight. `activeActiveSafe`
remains false because scheduling intentionally has one elected writer and the
target topology has not completed failover/load qualification.
Without this config it reports
`local-file`.

Redis durability is an operator responsibility. Production deployments should
use authenticated TLS, persistence appropriate to the recovery-point target,
replication/failover, monitoring, memory reservations, eviction disabled for
the registry database, and tested Redis backup/restore. The client does not
implement Redis Cluster `MOVED`/`ASK` redirects or Sentinel discovery. A direct
standalone primary is suitable for development; production must put a stable,
externally managed primary endpoint or cluster-aware proxy in front of it.
Endpoint failover must preserve the hostname, port, database, TLS mode, and
registry key because those fields define backend identity.

The enterprise gate exercises a local primary/replica pair through a stable TCP
endpoint: it waits for registry and audit replication, promotes the replica,
removes the old primary, and proves that the existing backend instance resumes
registry CAS writes and continues the audit hash chain without a Hub restart.
This is a deterministic client recovery test, not certification of a specific
managed Redis service. Each production topology still requires its own
failover, durability, latency, and recovery-objective qualification.

## Cutover and backup

Enabling the backend changes the authoritative registry and runtime stores
immediately. Direct startup refuses to
initialize Redis queue, assignment, worker, lease, or job-event authority while
any corresponding local state is non-empty—even when Redis already contains
other records—returning
`HUB_QUEUE_MIGRATION_REQUIRED`, `HUB_ASSIGNMENT_MIGRATION_REQUIRED`, or
`HUB_WORKER_MIGRATION_REQUIRED`, `HUB_LEASE_MIGRATION_REQUIRED`, or
`HUB_JOB_MIGRATION_REQUIRED`; silently selecting one node's history would lose
work. For an existing installation, use the offline transactional migrator:

1. stop every Hub, scheduler, and worker;
2. configure `CPB_HUB_STATE_REDIS_CONFIG_FILE`, backup/audit signing keys, and
   an output path outside the Hub root;
3. preview the complete inventory, then execute explicitly:

   ```sh
   cpb hub migrate-to-redis --output /secure/migrations/cpb-cutover --json
   cpb hub migrate-to-redis --output /secure/migrations/cpb-cutover --yes
   ```

4. configure `CPB_HUB_WORKER_BROKER_URL` consistently on every node;
5. run `cpb doctor`, verify `sharedStores` and the project/job counts, then
   restart workers.

The migrator inventories registry, queue, assignment/attempt history, workers,
pending/processing inbox entries, leases, Job projections, and every Job event
stream across registered runtime roots. Processing inbox entries become
pending so a new worker can reclaim them. It rejects malformed, truncated, or
conflicting duplicate histories. Execution holds local maintenance, publishes
a verified rollback backup and logical Redis snapshot, requires an empty or
already-matching Redis business authority, atomically restores Redis, verifies
the result, and only then removes local authoritative paths. A durable sibling
journal lets Hub startup or `cpb hub recover-redis-migration` finish the exact
window where Redis committed but local retirement did not. Audit history is
archived separately and never folded into or rewound with business state.

`cpb hub backup` acquires both the filesystem maintenance lock and a
server-time Redis maintenance lease. Every Redis mutation script rejects writes
while that lease is active. The backup then exports canonical Hash state plus
all Job Streams, excludes transient leader/maintenance ownership, embeds the
logical snapshot inside the signed/checksummed Hub backup, and verifies its
digest before commit. A lost or expired Redis lease aborts the backup.

Redis-aware restore requires the embedded logical snapshot and the same pinned
backend identity; missing Redis configuration or a mismatched identity fails
closed. Before switching state it writes a durable Redis rollback snapshot and
extends the filesystem restore journal with Redis phases. The Redis switch is a
single Lua transaction; filesystem replacement then follows the journal. On
restart, recovery either restores the Redis rollback snapshot and keeps the old
filesystem, or completes the target snapshot and replacement filesystem. The
leader epoch is advanced rather than rewound, so pre-restore leaders remain
fenced.

Access-audit head fields and the access-audit Stream are deliberately excluded
from business snapshots and preserved across restore. Restoring an older
business snapshot must never rewind or erase the evidence describing that
restore. Audit export and retention use a separate operational lifecycle.

Backup and restore also scan the shared Worker registry and refuse to run while
any Worker is not terminal. Operators must stop or drain every Worker, not only
the Hub process. Embedded logical-snapshot artifacts restored into the Hub root
are removed by the next recovery check or backup. Current safety limits are
300 MiB for the serialized Redis snapshot, 10,000 Job Streams, and 500,000 Job
events; installations approaching those limits need retention/archival before
backup.

## Redis retention

`cpb hub redis-retention` previews terminal Job projections and tombstones that
are eligible for cleanup. The default windows are 30 days for terminal Jobs and
90 days for tombstones, with a deterministic oldest-first limit of 1,000 per
category. Use `--before ISO`, `--tombstones-before ISO`, and `--limit N` to set
an explicit policy. Preview is the default and does not mutate Redis:

```sh
cpb hub redis-retention --json
cpb hub redis-retention --before 2026-01-01T00:00:00Z \
  --tombstones-before 2025-10-01T00:00:00Z --limit 1000 --yes
```

Execution requires `--yes` and acquires the Redis maintenance lease. For each
eligible terminal Job, one Lua transaction revalidates its revision and
terminal status, deletes its Event Stream, and replaces the projection with a
small revisioned tombstone carrying Redis server time. A later retention run
may remove that tombstone only after the tombstone cutoff; the Lua transaction
again verifies maintenance ownership, revision, deletion state, and timestamp.
This preserves a defined replay/ABA protection window instead of resetting a
field to revision zero at the same time its Job history is removed. Delayed
writes carrying an old non-zero revision remain rejected after final deletion.
Take and verify a signed Hub backup before executing a destructive retention
policy. Choose the tombstone window to exceed the maximum supported request,
queue, worker, and disaster-recovery replay age for the deployment.

## Secret boundary

Keep the config path on control-plane hosts only. Do not place it under a
project checkout, `CPB_HUB_ROOT`, an agent workspace, diagnostics bundle, or
source control. Restrict file and parent-directory access to the Hub service
account. Prefer a secret manager or deployment system that writes a private
temporary file and replaces it atomically during rotation.

The managed worker holds only a worker/incarnation-scoped bearer capability;
the Redis principal remains in the Hub. The broker derives project, job,
assignment, and runtime-root scope from Hub state and rejects caller-supplied
cross-scope identifiers. Production deployments should still run workers under
a different OS/container identity, restrict egress so repository code cannot
reach the internal broker endpoint, and rotate the worker capability on every
restart. Readiness remains `activeActiveSafe: false` until the target multi-node
topology has completed failover, load, upgrade, audit-export, and recovery-time
validation.
