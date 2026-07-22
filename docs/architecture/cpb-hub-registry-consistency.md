# Hub registry consistency

By default, the Hub project registry is stored at `<hubRoot>/projects.json` as
a single-host durable control-plane file. An optional Redis CAS backend can
make this one registry transactional across hosts; it does not make the rest
of the Hub state distributed.

## Write invariants

All production read-modify-write operations use `mutateRegistry`. The
local-file transaction holds `<hubRoot>/projects.json.lock`, reloads the latest
registry, applies one mutation, verifies lock ownership, and publishes the new
file with an atomic rename. The temporary file and parent directory are
fsynced. With Redis configured, `mutateRegistry` reads one revision and commits
through an atomic compare-and-swap Lua script; a losing mutation reloads and
replays with bounded jitter.

Each committed registry contains a monotonic `revision`. `saveRegistry` is the
compatibility API for callers that already hold a snapshot. It compares the
snapshot revision with the current revision and fails with
`HUB_REGISTRY_CONFLICT` rather than overwriting a newer commit. Callers must
reload or use `mutateRegistry`; they must not blindly retry the stale snapshot.

Project registration, project updates, worker heartbeats, project-index
metadata, stale-worker cleanup, and pollution cleanup all participate in this
transaction boundary.

## Lock lifecycle

The lock directory is acquired with atomic `mkdir`. Its private metadata
contains a random owner token, hostname, acquisition timestamp, and the
owner's canonical exact `ProcessIdentity` (PID, OS birth identity,
incarnation, capture timestamp, and optional process group). A transaction
verifies the token and process incarnation immediately before publishing.
Release runs under the same process fence and quarantines only the exact lock
directory generation it owns; release failures are propagated, including when
the registry mutation itself also failed.

On the same host, the 30-second TTL only makes a lock eligible for inspection.
A live exact owner is never reclaimed merely because the timestamp is old. A
dead or successor incarnation can be recovered only after exact identity
comparison. Legacy v1 metadata, missing/coarse identity, malformed identity,
and an indeterminate identity probe fail closed as
`HUB_REGISTRY_LOCK_UNSAFE`; ordinary registry mutation never falls back to a
PID-only liveness decision.

Acquisition, recovery, and release are serialized by the keyed localhost
process fence shared by durable directory locks. Recovery renames the observed
lock generation to a unique quarantine, fsyncs the parent, and rechecks both
directory inode and owner token/incarnation. If a successor appears, recovery
uses an atomic `mkdir` reservation and entry-by-entry no-clobber restore. An
empty successor is therefore preserved rather than overwritten, and the
quarantine is retained as recovery evidence. A normal contender waits up to
10 seconds with jitter before returning `HUB_REGISTRY_LOCK_BUSY`.

Unexpected lock paths, symbolic links, non-regular metadata files, and lock
metadata larger than 16 KiB fail closed. Owner metadata is opened with
`O_NOFOLLOW` and read through a byte-bounded descriptor with generation checks.
Losing the owner token or incarnation returns `HUB_REGISTRY_LOCK_LOST`, and the
old transaction neither commits nor removes the successor lock.

## Registry file boundary

`projects.json` must be a regular, non-symbolic-link file and is read through a
bounded file descriptor after its device/inode identity is checked. The
serialized registry is limited to 16 MiB. Oversized input or output returns
`HUB_REGISTRY_TOO_LARGE`; unsafe file identity returns
`HUB_REGISTRY_UNSAFE`.

## Deployment boundary

The local-file guarantees cover competing Node processes that share one local
Hub root. They prevent lost updates and make crashes recoverable for the
supported single-host deployment.

They do not provide multi-host consensus or storage-level fencing on a shared
network filesystem. Configure the Redis CAS backend when different hosts must
write one project registry; see
[`cpb-hub-redis-state.md`](../security/cpb-hub-redis-state.md). Even then, an
active/active Hub still requires transactional shared queue, job, worker, and
lease stores, leader fencing epochs enforced by every write, and tested
cross-store failover semantics. Do not run multiple active schedulers merely
because the registry uses Redis.
