import { createHash } from "node:crypto";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { once } from "node:events";
import { TextDecoder } from "node:util";

import { isLoopbackHost } from "./network.js";

const REDIS_STATE_FORMAT = "cpb-hub-state-redis/v1";
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 17 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_ARRAY_LENGTH = 1024;
const MAX_NESTING_DEPTH = 8;
const MAX_PARSED_NODES = 8_192;
const MAX_SCAN_RECORDS = 100_000;
const MAX_SCAN_BYTES = 256 * 1024 * 1024;
const MAX_SCAN_PAGES = 200_000;
const MAX_SCAN_MS = 30_000;
// State records are capped at 4 MiB, so four requested records remain below
// the 17 MiB RESP cap while avoiding one network round trip per record.
const STATE_SCAN_COUNT = 4;
const MAX_SNAPSHOT_STREAMS = 10_000;
const MAX_SNAPSHOT_EVENTS = 500_000;
const MAX_POOL_CONNECTIONS = 8;
const POOL_IDLE_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const backendIdentityByHubRoot = new Map<string, string>();
const backendConfigFileByHubRoot = new Map<string, string>();
export type RedisRestoreCommitEvidence = {
  registryKey: string;
  backendIdentityFingerprint: string;
  snapshotSha256: string;
  operationToken: string;
};

type RedisRestoreCommitOutcome = "committed" | "unknown";
type BoundRedisRestoreCommitEvidence = RedisRestoreCommitEvidence & {
  outcome: RedisRestoreCommitOutcome;
};

const redisRestoreCommitEvidence = new WeakMap<object, BoundRedisRestoreCommitEvidence>();

function sameRedisRestoreCommitEvidence(
  expected: RedisRestoreCommitEvidence,
  actual: RedisRestoreCommitEvidence,
) {
  return expected.registryKey === actual.registryKey
    && expected.backendIdentityFingerprint === actual.backendIdentityFingerprint
    && expected.snapshotSha256 === actual.snapshotSha256
    && expected.operationToken === actual.operationToken;
}

function markRedisRestoreCommitOutcome(
  error: unknown,
  outcome: RedisRestoreCommitOutcome,
  evidence: RedisRestoreCommitEvidence,
  recovery: Record<string, unknown>,
) {
  const marked = error && typeof error === "object"
    ? error
    : new Error(String(error));
  Object.assign(marked, {
    commitMayHaveOccurred: true,
    ...(outcome === "committed" ? { redisCommitted: true } : {}),
    redisCommitRecovery: Object.freeze({ ...recovery }),
  });
  redisRestoreCommitEvidence.set(marked, { ...evidence, outcome });
  return marked;
}

export function redisRestoreCommitOutcome(
  error: unknown,
  expected: RedisRestoreCommitEvidence,
): RedisRestoreCommitOutcome | null {
  if (!error || typeof error !== "object") return null;
  const actual = redisRestoreCommitEvidence.get(error);
  return actual && sameRedisRestoreCommitEvidence(expected, actual) ? actual.outcome : null;
}

const REDIS_MAINTENANCE_GUARD = `
local maintenance_token = redis.call("HGET", KEYS[1], "maintenanceToken")
if maintenance_token and maintenance_token ~= "" then
  local maintenance_expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "")
  if not maintenance_expires then return redis.error_reply("CPB_HUB_MAINTENANCE_INVALID") end
  local maintenance_time = redis.call("TIME")
  local maintenance_now = tonumber(maintenance_time[1]) * 1000 + math.floor(tonumber(maintenance_time[2]) / 1000)
  if maintenance_expires > maintenance_now then return redis.error_reply("CPB_HUB_MAINTENANCE_ACTIVE") end
  redis.call("HDEL", KEYS[1], "maintenanceToken", "maintenanceOperation", "maintenanceAcquiredAtMs", "maintenanceExpiresAtMs")
end
`.trim();

const MAINTENANCE_ACQUIRE_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
local expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "0")
if token ~= "" and expires > now and token ~= ARGV[1] then
  return {0, tostring(now), tostring(expires)}
end
local next_expires = now + tonumber(ARGV[3])
redis.call("HSET", KEYS[1],
  "maintenanceToken", ARGV[1],
  "maintenanceOperation", ARGV[2],
  "maintenanceAcquiredAtMs", tostring(now),
  "maintenanceExpiresAtMs", tostring(next_expires))
return {1, tostring(now), tostring(next_expires)}
`.trim();

const MAINTENANCE_RENEW_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
local expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "0")
if token ~= ARGV[1] or expires <= now then return {0, tostring(now), tostring(expires)} end
local next_expires = now + tonumber(ARGV[2])
redis.call("HSET", KEYS[1], "maintenanceExpiresAtMs", tostring(next_expires))
return {1, tostring(now), tostring(next_expires)}
`.trim();

const MAINTENANCE_RELEASE_SCRIPT = `
local token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
if token ~= ARGV[1] then return 0 end
redis.call("HDEL", KEYS[1], "maintenanceToken", "maintenanceOperation", "maintenanceAcquiredAtMs", "maintenanceExpiresAtMs")
return 1
`.trim();

const MAINTENANCE_READ_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local values = redis.call("HMGET", KEYS[1], "maintenanceToken", "maintenanceOperation", "maintenanceAcquiredAtMs", "maintenanceExpiresAtMs")
local expires = tonumber(values[4] or "0")
if values[1] and values[1] ~= "" and expires <= now then
  redis.call("HDEL", KEYS[1], "maintenanceToken", "maintenanceOperation", "maintenanceAcquiredAtMs", "maintenanceExpiresAtMs")
  return {"", "", "", "", tostring(now)}
end
return {values[1] or "", values[2] or "", values[3] or "", values[4] or "", tostring(now)}
`.trim();

const RESTORE_STAGE_STREAM_SCRIPT = `
local offset = tonumber(ARGV[1])
if not offset or offset < 0 then return redis.error_reply("CPB_STATE_RECORD_INVALID") end
for index = 2, #ARGV do
  redis.call("XADD", KEYS[1], "*", "event", ARGV[index], "sequence", tostring(offset + index - 1))
end
return #ARGV - 1
`.trim();

const RESTORE_COMMIT_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
local expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "0")
if token ~= ARGV[1] or expires <= now then return redis.error_reply("CPB_HUB_MAINTENANCE_ACTIVE") end
local current_count = tonumber(ARGV[2])
local target_count = tonumber(ARGV[3])
if not current_count or not target_count then return redis.error_reply("CPB_STATE_RECORD_INVALID") end
local cursor = 3
for index = 1, current_count do
  redis.call("DEL", KEYS[cursor])
  cursor = cursor + 1
end
for index = 1, target_count do
  local target = KEYS[cursor]
  local staged = KEYS[cursor + 1]
  redis.call("DEL", target)
  if redis.call("EXISTS", staged) == 1 then redis.call("RENAME", staged, target) end
  cursor = cursor + 2
end
local audit_sequence = redis.call("HGET", KEYS[1], "auditSequence")
local audit_hash = redis.call("HGET", KEYS[1], "auditHash")
local audit_bytes = redis.call("HGET", KEYS[1], "auditBytes")
local audit_max_bytes = redis.call("HGET", KEYS[1], "auditMaxBytes")
if (audit_sequence and (not audit_hash or not audit_bytes or not audit_max_bytes))
  or (not audit_sequence and (audit_hash or audit_bytes or audit_max_bytes)) then
  return redis.error_reply("CPB_AUDIT_INVALID")
end
if audit_sequence then
  redis.call("HSET", KEYS[2], "auditSequence", audit_sequence, "auditHash", audit_hash,
    "auditBytes", audit_bytes, "auditMaxBytes", audit_max_bytes)
end
redis.call("RENAME", KEYS[2], KEYS[1])
return 1
`.trim();

const REGISTRY_CAS_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local revision = redis.call("HGET", KEYS[1], "revision")
local data = redis.call("HGET", KEYS[1], "data")
if (revision and not data) or (data and not revision) then
  return redis.error_reply("CPB_REGISTRY_INVALID")
end
local current = 0
if revision then
  current = tonumber(revision)
  if not current or current < 0 or current % 1 ~= 0 then
    return redis.error_reply("CPB_REGISTRY_INVALID")
  end
end
local expected = tonumber(ARGV[1])
local next_revision = tonumber(ARGV[2])
local mutation_id = ARGV[4] or ""
if not expected or not next_revision or next_revision ~= expected + 1 then
  return redis.error_reply("CPB_REGISTRY_INVALID")
end
if mutation_id ~= "" and data then
  local current_ok, current_data = pcall(cjson.decode, data)
  if not current_ok or type(current_data) ~= "table" then
    return redis.error_reply("CPB_REGISTRY_INVALID")
  end
  if current_data["mutationId"] == mutation_id then
    return {1, string.format("%.0f", current)}
  end
end
if current ~= expected then
  return {0, string.format("%.0f", current)}
end
if mutation_id ~= "" then
  local next_ok, next_data = pcall(cjson.decode, ARGV[3])
  if not next_ok or type(next_data) ~= "table" or next_data["mutationId"] ~= mutation_id then
    return redis.error_reply("CPB_REGISTRY_INVALID")
  end
end
redis.call("HSET", KEYS[1], "revision", string.format("%.0f", next_revision), "data", ARGV[3])
return {1, string.format("%.0f", next_revision)}
`.trim();

const REGISTRY_PREFLIGHT_SCRIPT = `
if not redis.acl_check_cmd then
  return redis.error_reply("CPB_REDIS_ACL_CHECK_UNSUPPORTED")
end
if not redis.acl_check_cmd("HSET", KEYS[1], "revision", "0", "data", "{}") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("HDEL", KEYS[1], "maintenanceToken") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("DEL", KEYS[2]) or not redis.acl_check_cmd("EXISTS", KEYS[2])
  or not redis.acl_check_cmd("RENAME", KEYS[2], KEYS[1]) then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("HMGET", KEYS[1], "revision", "data") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("TIME") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("ROLE") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("HSCAN", KEYS[1], "0", "MATCH", "worker:*", "COUNT", "1") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("SCAN", "0", "MATCH", "cpb:*:job-events:*", "COUNT", "1") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("XADD", KEYS[2], "*", "event", "{}", "sequence", "1") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("XRANGE", KEYS[2], "-", "+", "COUNT", "1") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
if not redis.acl_check_cmd("XADD", KEYS[3], "*", "record", "{}", "sequence", "1")
  or not redis.acl_check_cmd("XRANGE", KEYS[3], "-", "+", "COUNT", "1") then
  return redis.error_reply("CPB_REDIS_ACL_INSUFFICIENT")
end
local revision = redis.call("HGET", KEYS[1], "revision")
local data = redis.call("HGET", KEYS[1], "data")
if (revision and not data) or (data and not revision) then
  return redis.error_reply("CPB_REGISTRY_INVALID")
end
local queue_revision = redis.call("HGET", KEYS[1], "queueRevision")
local queue_data = redis.call("HGET", KEYS[1], "queueData")
if (queue_revision and not queue_data) or (queue_data and not queue_revision) then
  return redis.error_reply("CPB_QUEUE_INVALID")
end
return 1
`.trim();

const LEADER_ACQUIRE_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local current_token = redis.call("HGET", KEYS[1], "leaderToken")
local current_epoch = redis.call("HGET", KEYS[1], "leaderEpoch") or "0"
local current_expires = redis.call("HGET", KEYS[1], "leaderExpiresAtMs") or "0"
local current_released = redis.call("HGET", KEYS[1], "leaderReleasedAtMs") or ""
local epoch_number = tonumber(current_epoch)
local expires_number = tonumber(current_expires)
if not epoch_number or epoch_number < 0 or epoch_number % 1 ~= 0 or epoch_number >= 9007199254740990 then
  return redis.error_reply("CPB_LEADER_INVALID")
end
if not expires_number then
  return redis.error_reply("CPB_LEADER_INVALID")
end
if current_token and current_token ~= "" and current_released == "" and expires_number > now then
  local owner = redis.call("HGET", KEYS[1], "leaderHubId") or ""
  return {0, string.format("%.0f", epoch_number), owner, tostring(expires_number), tostring(now)}
end
local next_epoch = epoch_number + 1
local expires = now + tonumber(ARGV[5])
redis.call("HSET", KEYS[1],
  "leaderEpoch", string.format("%.0f", next_epoch),
  "leaderToken", ARGV[1],
  "leaderHubId", ARGV[2],
  "leaderHost", ARGV[3],
  "leaderPid", ARGV[4],
  "leaderStartedAtMs", tostring(now),
  "leaderHeartbeatAtMs", tostring(now),
  "leaderExpiresAtMs", tostring(expires),
  "leaderReleasedAtMs", "")
return {1, string.format("%.0f", next_epoch), ARGV[2], tostring(expires), tostring(now)}
`.trim();

const LEADER_RENEW_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token = redis.call("HGET", KEYS[1], "leaderToken") or ""
local hub_id = redis.call("HGET", KEYS[1], "leaderHubId") or ""
local epoch = redis.call("HGET", KEYS[1], "leaderEpoch") or "0"
local expires = tonumber(redis.call("HGET", KEYS[1], "leaderExpiresAtMs") or "0")
local released = redis.call("HGET", KEYS[1], "leaderReleasedAtMs") or ""
if token ~= ARGV[1] or hub_id ~= ARGV[2] or epoch ~= ARGV[3] or released ~= "" or expires <= now then
  return {0, tostring(now)}
end
local next_expires = now + tonumber(ARGV[4])
redis.call("HSET", KEYS[1], "leaderHeartbeatAtMs", tostring(now), "leaderExpiresAtMs", tostring(next_expires))
return {1, tostring(now), tostring(next_expires)}
`.trim();

const LEADER_RELEASE_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local token = redis.call("HGET", KEYS[1], "leaderToken") or ""
local hub_id = redis.call("HGET", KEYS[1], "leaderHubId") or ""
local epoch = redis.call("HGET", KEYS[1], "leaderEpoch") or "0"
if token ~= ARGV[1] or hub_id ~= ARGV[2] or epoch ~= ARGV[3] then
  return {0, tostring(now)}
end
redis.call("HSET", KEYS[1],
  "leaderHeartbeatAtMs", tostring(now),
  "leaderExpiresAtMs", tostring(now - 1),
  "leaderReleasedAtMs", tostring(now))
return {1, tostring(now)}
`.trim();

const LEADER_READ_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local values = redis.call("HMGET", KEYS[1],
  "leaderEpoch", "leaderToken", "leaderHubId", "leaderHost", "leaderPid",
  "leaderStartedAtMs", "leaderHeartbeatAtMs", "leaderExpiresAtMs", "leaderReleasedAtMs")
local epoch = values[1] or "0"
local expires = tonumber(values[8] or "0")
local epoch_number = tonumber(epoch)
if not epoch_number or epoch_number < 0 or epoch_number % 1 ~= 0 or not expires then
  return redis.error_reply("CPB_LEADER_INVALID")
end
if not values[2] or values[2] == "" then
  if values[3] or values[4] or values[5] or values[6] or values[7] or values[8] or values[9] then
    return redis.error_reply("CPB_LEADER_INVALID")
  end
elseif epoch_number < 1
  or not values[3] or values[3] == ""
  or not values[4] or values[4] == ""
  or not tonumber(values[5]) or tonumber(values[5]) < 1
  or not tonumber(values[6])
  or not tonumber(values[7])
  or not tonumber(values[8])
  or (values[9] and values[9] ~= "" and not tonumber(values[9])) then
  return redis.error_reply("CPB_LEADER_INVALID")
end
local alive = 0
if values[2] and values[2] ~= "" and (not values[9] or values[9] == "") and expires > now then
  alive = 1
end
return {epoch, values[2] or "", values[3] or "", values[4] or "", values[5] or "",
  values[6] or "", values[7] or "", values[8] or "0", values[9] or "", tostring(now), alive}
`.trim();

const QUEUE_CAS_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local revision = redis.call("HGET", KEYS[1], "queueRevision")
local data = redis.call("HGET", KEYS[1], "queueData")
if (revision and not data) or (data and not revision) then
  return redis.error_reply("CPB_QUEUE_INVALID")
end
local current = 0
if revision then
  current = tonumber(revision)
  if not current or current < 0 or current % 1 ~= 0 then
    return redis.error_reply("CPB_QUEUE_INVALID")
  end
end
local expected = tonumber(ARGV[1])
local next_revision = tonumber(ARGV[2])
if not expected or not next_revision or next_revision ~= expected + 1 then
  return redis.error_reply("CPB_QUEUE_INVALID")
end
if ARGV[4] == "1" then
  local time = redis.call("TIME")
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local token = redis.call("HGET", KEYS[1], "leaderToken") or ""
  local hub_id = redis.call("HGET", KEYS[1], "leaderHubId") or ""
  local epoch = redis.call("HGET", KEYS[1], "leaderEpoch") or "0"
  local expires = tonumber(redis.call("HGET", KEYS[1], "leaderExpiresAtMs") or "0")
  local released = redis.call("HGET", KEYS[1], "leaderReleasedAtMs") or ""
  if token ~= ARGV[5] or hub_id ~= ARGV[6] or epoch ~= ARGV[7] or released ~= "" or expires <= now then
    return {-1, string.format("%.0f", current)}
  end
end
if current ~= expected then
  return {0, string.format("%.0f", current)}
end
redis.call("HSET", KEYS[1], "queueRevision", string.format("%.0f", next_revision), "queueData", ARGV[3])
return {1, string.format("%.0f", next_revision)}
`.trim();

const STATE_RECORD_CAS_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local current_raw = redis.call("HGET", KEYS[1], ARGV[1])
local current_revision = 0
if current_raw then
  local ok, current = pcall(cjson.decode, current_raw)
  if not ok or type(current) ~= "table" or type(current.revision) ~= "number"
    or current.revision < 1 or current.revision % 1 ~= 0
    or (current.deleted == true and current.data ~= nil)
    or (current.deleted ~= true and current.data == nil)
    or (current.deleted == true and current.deletedAtMs ~= nil
      and (type(current.deletedAtMs) ~= "number" or current.deletedAtMs < 0 or current.deletedAtMs % 1 ~= 0))
    or (current.deleted ~= true and current.deletedAtMs ~= nil) then
    return redis.error_reply("CPB_STATE_RECORD_INVALID")
  end
  current_revision = current.revision
end
local expected = tonumber(ARGV[2])
local next_revision = tonumber(ARGV[3])
if not expected or expected < 0 or expected % 1 ~= 0
  or not next_revision or next_revision ~= expected + 1 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
if ARGV[5] == "1" then
  local time = redis.call("TIME")
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local token = redis.call("HGET", KEYS[1], "leaderToken") or ""
  local hub_id = redis.call("HGET", KEYS[1], "leaderHubId") or ""
  local epoch = redis.call("HGET", KEYS[1], "leaderEpoch") or "0"
  local expires = tonumber(redis.call("HGET", KEYS[1], "leaderExpiresAtMs") or "0")
  local released = redis.call("HGET", KEYS[1], "leaderReleasedAtMs") or ""
  if token ~= ARGV[6] or hub_id ~= ARGV[7] or epoch ~= ARGV[8] or released ~= "" or expires <= now then
    return {-1, string.format("%.0f", current_revision)}
  end
end
if current_revision ~= expected then
  return {0, string.format("%.0f", current_revision)}
end
local ok, next_value = pcall(cjson.decode, ARGV[4])
if not ok or type(next_value) ~= "table" or next_value.revision ~= next_revision
  or (next_value.deleted == true and next_value.data ~= nil)
  or (next_value.deleted ~= true and next_value.data == nil)
  or (next_value.deleted ~= true and next_value.deletedAtMs ~= nil) then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local serialized = ARGV[4]
if next_value.deleted == true then
  local delete_time = redis.call("TIME")
  next_value.deletedAtMs = tonumber(delete_time[1]) * 1000 + math.floor(tonumber(delete_time[2]) / 1000)
  serialized = cjson.encode(next_value)
end
redis.call("HSET", KEYS[1], ARGV[1], serialized)
return {1, string.format("%.0f", next_revision)}
`.trim();

const STATE_RECORD_AND_CLAIM_COMMIT_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local assignment_raw = redis.call("HGET", KEYS[1], ARGV[1])
local assignment_revision = 0
if assignment_raw then
  local ok, assignment = pcall(cjson.decode, assignment_raw)
  if not ok or type(assignment) ~= "table" or type(assignment.revision) ~= "number" then
    return redis.error_reply("CPB_STATE_RECORD_INVALID")
  end
  assignment_revision = assignment.revision
end
local expected = tonumber(ARGV[2])
local next_revision = tonumber(ARGV[3])
if assignment_revision ~= expected then
  return {0, string.format("%.0f", assignment_revision)}
end
if not next_revision or next_revision ~= expected + 1 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local claim_raw = redis.call("HGET", KEYS[1], ARGV[5])
if not claim_raw then return {-1, string.format("%.0f", assignment_revision)} end
local claim_ok, claim = pcall(cjson.decode, claim_raw)
if not claim_ok or type(claim) ~= "table" or type(claim.revision) ~= "number"
  or type(claim.data) ~= "table" or claim.data.status ~= "processing"
  or claim.data.claimToken ~= ARGV[6] then
  return {-1, string.format("%.0f", assignment_revision)}
end
local next_ok, next_assignment = pcall(cjson.decode, ARGV[4])
if not next_ok or type(next_assignment) ~= "table" or next_assignment.revision ~= next_revision
  or next_assignment.data == nil or next_assignment.deleted == true then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local claim_next_revision = claim.revision + 1
local delete_time = redis.call("TIME")
local deleted_at = tonumber(delete_time[1]) * 1000 + math.floor(tonumber(delete_time[2]) / 1000)
redis.call("HSET", KEYS[1],
  ARGV[1], ARGV[4],
  ARGV[5], cjson.encode({revision=claim_next_revision, deleted=true, deletedAtMs=deleted_at}))
return {1, string.format("%.0f", next_revision)}
`.trim();

const JOB_EVENT_APPEND_SCRIPT = `
${REDIS_MAINTENANCE_GUARD}
local current_raw = redis.call("HGET", KEYS[1], ARGV[1])
local current_revision = 0
if current_raw then
  local ok, current = pcall(cjson.decode, current_raw)
  if not ok or type(current) ~= "table" or type(current.revision) ~= "number" then
    return redis.error_reply("CPB_STATE_RECORD_INVALID")
  end
  current_revision = current.revision
end
local expected = tonumber(ARGV[2])
local next_revision = tonumber(ARGV[3])
if current_revision ~= expected then return {0, string.format("%.0f", current_revision), ""} end
if not next_revision or next_revision ~= expected + 1 then return redis.error_reply("CPB_STATE_RECORD_INVALID") end
local next_ok, next_value = pcall(cjson.decode, ARGV[4])
if not next_ok or type(next_value) ~= "table" or next_value.revision ~= next_revision
  or next_value.data == nil or next_value.deleted == true then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local stream_id = redis.call("XADD", KEYS[2], "*", "event", ARGV[5], "sequence", tostring(next_revision))
redis.call("HSET", KEYS[1], ARGV[1], ARGV[4])
return {1, string.format("%.0f", next_revision), stream_id}
`.trim();

const ACCESS_AUDIT_APPEND_SCRIPT = `
local sequence_raw = redis.call("HGET", KEYS[1], "auditSequence")
local hash = redis.call("HGET", KEYS[1], "auditHash")
local bytes_raw = redis.call("HGET", KEYS[1], "auditBytes")
local stored_max_raw = redis.call("HGET", KEYS[1], "auditMaxBytes")
if (sequence_raw and (not hash or not bytes_raw or not stored_max_raw))
  or (not sequence_raw and (hash or bytes_raw or stored_max_raw)) then
  return redis.error_reply("CPB_AUDIT_INVALID")
end
local sequence = tonumber(sequence_raw or "0")
local bytes = tonumber(bytes_raw or "0")
if not sequence or sequence < 0 or sequence % 1 ~= 0
  or not bytes or bytes < 0 or bytes % 1 ~= 0 then
  return redis.error_reply("CPB_AUDIT_INVALID")
end
hash = hash or string.rep("0", 64)
local expected_sequence = tonumber(ARGV[1])
local record_bytes = string.len(ARGV[4]) + 1
local max_bytes = tonumber(ARGV[5])
if not expected_sequence or expected_sequence < 0 or expected_sequence % 1 ~= 0
  or not max_bytes or max_bytes < 1 or max_bytes % 1 ~= 0 then
  return redis.error_reply("CPB_AUDIT_INVALID")
end
local stored_max = tonumber(stored_max_raw or ARGV[5])
if not stored_max or stored_max ~= max_bytes then return redis.error_reply("CPB_AUDIT_POLICY_MISMATCH") end
if sequence ~= expected_sequence or hash ~= ARGV[2] then
  return {0, string.format("%.0f", sequence), hash, string.format("%.0f", bytes), "", string.format("%.0f", stored_max)}
end
local ok, record = pcall(cjson.decode, ARGV[4])
if not ok or type(record) ~= "table" or record.format ~= "cpb-hub-access-audit/v1"
  or record.sequence ~= sequence + 1 or record.previousHash ~= hash or record.hash ~= ARGV[3] then
  return redis.error_reply("CPB_AUDIT_INVALID")
end
if bytes + record_bytes > max_bytes then return redis.error_reply("CPB_AUDIT_FULL") end
local stream_id = redis.call("XADD", KEYS[2], "*", "record", ARGV[4], "sequence", tostring(sequence + 1))
redis.call("HSET", KEYS[1],
  "auditSequence", string.format("%.0f", sequence + 1),
  "auditHash", ARGV[3],
  "auditBytes", string.format("%.0f", bytes + record_bytes),
  "auditMaxBytes", string.format("%.0f", max_bytes))
return {1, string.format("%.0f", sequence + 1), ARGV[3], string.format("%.0f", bytes + record_bytes), stream_id, string.format("%.0f", max_bytes)}
`.trim();

const PURGE_TERMINAL_JOB_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maintenance_token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
local maintenance_expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "0")
if maintenance_token ~= ARGV[1] or maintenance_expires <= now then
  return redis.error_reply("CPB_HUB_MAINTENANCE_ACTIVE")
end
local current_raw = redis.call("HGET", KEYS[1], ARGV[2])
if not current_raw then return {0, 0, 0} end
local ok, current = pcall(cjson.decode, current_raw)
if not ok or type(current) ~= "table" or type(current.revision) ~= "number"
  or current.revision < 1 or current.revision % 1 ~= 0 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local expected = tonumber(ARGV[3])
if not expected or expected < 1 or expected % 1 ~= 0 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
if current.revision ~= expected then return {0, 0, string.format("%.0f", current.revision)} end
if current.deleted == true then return {0, 1, string.format("%.0f", current.revision)} end
if type(current.data) ~= "table" then return redis.error_reply("CPB_STATE_RECORD_INVALID") end
local status = current.data.status
if status ~= "completed" and status ~= "failed" and status ~= "blocked"
  and status ~= "cancelled" and status ~= "superseded" then
  return {0, 0, string.format("%.0f", current.revision)}
end
local next_revision = current.revision + 1
redis.call("DEL", KEYS[2])
redis.call("HSET", KEYS[1], ARGV[2], cjson.encode({
  revision=next_revision,
  deleted=true,
  deletedAtMs=now
}))
return {1, 1, string.format("%.0f", next_revision)}
`.trim();

const DELETE_EXPIRED_TOMBSTONE_SCRIPT = `
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local maintenance_token = redis.call("HGET", KEYS[1], "maintenanceToken") or ""
local maintenance_expires = tonumber(redis.call("HGET", KEYS[1], "maintenanceExpiresAtMs") or "0")
if maintenance_token ~= ARGV[1] or maintenance_expires <= now then
  return redis.error_reply("CPB_HUB_MAINTENANCE_ACTIVE")
end
local current_raw = redis.call("HGET", KEYS[1], ARGV[2])
if not current_raw then return {0, 0, 0} end
local ok, current = pcall(cjson.decode, current_raw)
if not ok or type(current) ~= "table" or type(current.revision) ~= "number"
  or current.revision < 1 or current.revision % 1 ~= 0
  or current.deleted ~= true or current.data ~= nil then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
local expected = tonumber(ARGV[3])
local cutoff = tonumber(ARGV[4])
if not expected or expected < 1 or expected % 1 ~= 0
  or not cutoff or cutoff < 0 or cutoff % 1 ~= 0 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
if current.revision ~= expected then return {0, 0, string.format("%.0f", current.revision)} end
if current.deletedAtMs == nil then
  current.deletedAtMs = now
  redis.call("HSET", KEYS[1], ARGV[2], cjson.encode(current))
  return {0, 0, string.format("%.0f", current.revision)}
end
if type(current.deletedAtMs) ~= "number" or current.deletedAtMs < 0 or current.deletedAtMs % 1 ~= 0 then
  return redis.error_reply("CPB_STATE_RECORD_INVALID")
end
if current.deletedAtMs > cutoff then return {0, 0, string.format("%.0f", current.revision)} end
redis.call("HDEL", KEYS[1], ARGV[2])
return {1, 1, string.format("%.0f", current.revision)}
`.trim();

type RedisValue = string | number | null | RedisValue[];

type RedisStateConfig = {
  sourceFile: string;
  host: string;
  port: number;
  tls: boolean;
  username: string | null;
  password: string | null;
  database: number;
  registryKey: string;
  topology: "stable-primary-endpoint";
  connectTimeoutMs: number;
  operationTimeoutMs: number;
};

export type HubRedisStateBackend = {
  sourceFile: string;
  registryKey: string;
  identityFingerprint: string;
  topology: "stable-primary-endpoint";
  readRegistry: () => Promise<string | null>;
  compareAndSwapRegistry: (
    expectedRevision: number,
    nextRevision: number,
    serialized: string,
    mutationId?: string,
  ) => Promise<{ committed: boolean; revision: number }>;
  acquireLeader: (input: RedisLeaderIdentity, ttlMs: number) => Promise<RedisLeaderAcquireResult>;
  renewLeader: (input: RedisLeaderFence, ttlMs: number) => Promise<RedisLeaderRenewResult>;
  releaseLeader: (input: RedisLeaderFence) => Promise<boolean>;
  readLeader: () => Promise<RedisLeaderStatus>;
  readQueue: () => Promise<{ revision: number; serialized: string | null }>;
  compareAndSwapQueue: (
    expectedRevision: number,
    nextRevision: number,
    serialized: string,
    fence?: RedisLeaderFence | null,
  ) => Promise<{ committed: boolean; fenced: boolean; revision: number }>;
  readStateRecord: (field: string) => Promise<RedisStateRecord>;
  compareAndSwapStateRecord: (
    field: string,
    expectedRevision: number,
    data: unknown | null,
    fence?: RedisLeaderFence | null,
  ) => Promise<{ committed: boolean; fenced: boolean; revision: number }>;
  commitStateRecordAndDeleteClaim: (
    field: string,
    expectedRevision: number,
    data: unknown,
    claimField: string,
    claimToken: string,
  ) => Promise<{ committed: boolean; claimMatched: boolean; revision: number }>;
  appendJobEvent: (
    field: string,
    expectedRevision: number,
    projection: unknown,
    serializedEvent: string,
  ) => Promise<{ committed: boolean; revision: number; streamId: string | null }>;
  readJobEvents: (field: string) => Promise<string[]>;
  readAccessAuditHead: () => Promise<RedisAccessAuditHead>;
  appendAccessAudit: (
    expectedSequence: number,
    expectedHash: string,
    recordHash: string,
    serializedRecord: string,
    maxBytes: number,
  ) => Promise<RedisAccessAuditAppendResult>;
  readAccessAuditRecords: (throughSequence?: number) => Promise<string[]>;
  scanStateRecords: (prefix: string, includeDeleted?: boolean) => Promise<Array<{ field: string; record: RedisStateRecord }>>;
  purgeTerminalJob: (
    token: string,
    field: string,
    expectedRevision: number,
  ) => Promise<{ purged: boolean; terminal: boolean; revision: number }>;
  deleteExpiredTombstone: (
    token: string,
    field: string,
    expectedRevision: number,
    cutoffMs: number,
  ) => Promise<{ deleted: boolean; eligible: boolean; revision: number }>;
  acquireMaintenance: (token: string, operation: string, ttlMs: number) => Promise<RedisMaintenanceResult>;
  renewMaintenance: (token: string, ttlMs: number) => Promise<RedisMaintenanceResult>;
  releaseMaintenance: (token: string) => Promise<boolean>;
  readMaintenance: () => Promise<RedisMaintenanceStatus>;
  exportSnapshot: (token: string) => Promise<RedisLogicalSnapshot>;
  restoreSnapshot: (token: string, snapshot: RedisLogicalSnapshot) => Promise<RedisLogicalSnapshot>;
  serverTimeMs: () => Promise<number>;
  preflight: () => Promise<void>;
};

export type RedisStateRecord = {
  revision: number;
  data: unknown | null;
  deletedAtMs?: number | null;
};

export type RedisAccessAuditHead = {
  sequence: number;
  hash: string;
  sizeBytes: number;
  maxBytes: number | null;
};

export type RedisAccessAuditAppendResult = RedisAccessAuditHead & {
  committed: boolean;
  streamId: string | null;
};

export type RedisMaintenanceResult = {
  acquired: boolean;
  serverTime: string;
  expiresAt: string;
};

export type RedisMaintenanceStatus = {
  active: boolean;
  token: string | null;
  operation: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
  serverTime: string;
};

export type RedisLogicalSnapshot = {
  format: "cpb-hub-redis-logical-snapshot/v1";
  backendIdentityFingerprint: string;
  capturedAt: string;
  hashFields: Array<[string, string]>;
  jobStreams: Array<{ field: string; events: string[] }>;
  sha256: string;
};

export type RedisLeaderIdentity = {
  hubId: string;
  lockToken: string;
  host: string;
  pid: number;
};

export type RedisLeaderFence = Pick<RedisLeaderIdentity, "hubId" | "lockToken"> & { epoch: number };

export type RedisLeaderStatus = {
  alive: boolean;
  hubId: string | null;
  lockToken: string | null;
  host: string | null;
  pid: number | null;
  epoch: number;
  startedAt: string | null;
  heartbeatAt: string | null;
  expiresAt: string | null;
  releasedAt: string | null;
  serverTime: string;
};

export type RedisLeaderAcquireResult = {
  acquired: boolean;
  leader: RedisLeaderStatus;
};

export type RedisLeaderRenewResult = {
  renewed: boolean;
  heartbeatAt: string;
  expiresAt: string | null;
};

class IncompleteRedisReply extends Error {}

class RedisReplyError extends Error {}

function codedError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function configurationError(message: string) {
  return codedError("HUB_STATE_BACKEND_CONFIGURATION_UNAVAILABLE", message);
}

function unavailableError() {
  return codedError("HUB_STATE_BACKEND_UNAVAILABLE", "Redis state backend request failed");
}

function errnoCode(error: unknown) {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code || "")
    : "";
}

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function canonicalizeProspectivePath(value: string): Promise<string> {
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  let symlinkDepth = 0;
  while (true) {
    try {
      const existing = await realpath(cursor);
      return path.join(existing, ...suffix);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
      const link = await lstat(cursor).catch((inspectError) => {
        if (errnoCode(inspectError) === "ENOENT") return null;
        throw inspectError;
      });
      if (link?.isSymbolicLink()) {
        symlinkDepth += 1;
        if (symlinkDepth > 40) throw configurationError("Redis state path contains too many symbolic links");
        const target = await readlink(cursor);
        cursor = path.resolve(path.dirname(cursor), target);
        continue;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function fileFingerprint(info: Awaited<ReturnType<typeof lstat>>) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configurationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const known = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !known.has(key));
  if (unsupported.length > 0) {
    throw configurationError(`${label} contains unsupported fields: ${unsupported.sort().join(", ")}`);
  }
}

function timeoutValue(value: unknown, fallback: number, label: string) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
    throw configurationError(`${label} must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
  }
  return parsed;
}

async function readPrivateConfig(filePath: string, hubRoot: string) {
  let canonicalFileBefore: string;
  let canonicalHubRoot: string;
  try {
    [canonicalFileBefore, canonicalHubRoot] = await Promise.all([
      realpath(filePath),
      canonicalizeProspectivePath(hubRoot),
    ]);
  } catch (error) {
    throw configurationError(`cannot resolve Redis state config boundary: ${errnoCode(error) || "unknown error"}`);
  }
  if (isWithin(canonicalHubRoot, canonicalFileBefore)) {
    throw configurationError("Redis state config must be stored outside CPB_HUB_ROOT");
  }
  let linkInfo;
  try {
    linkInfo = await lstat(filePath);
  } catch (error) {
    throw configurationError(`cannot inspect Redis state config at ${filePath}: ${errnoCode(error) || "unknown error"}`);
  }
  if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) {
    throw configurationError(`Redis state config must be a real file: ${filePath}`);
  }
  if (process.platform !== "win32" && linkInfo.nlink !== 1) {
    throw configurationError("Redis state config must not have hard links");
  }
  if (linkInfo.size > MAX_CONFIG_BYTES) {
    throw configurationError(`Redis state config exceeds ${MAX_CONFIG_BYTES} bytes`);
  }
  if (process.platform !== "win32" && (linkInfo.mode & 0o077) !== 0) {
    throw configurationError("Redis state config must not be accessible by group or other users");
  }

  let handle;
  try {
    handle = await open(filePath, "r");
    const before = await handle.stat();
    if (!before.isFile() || fileFingerprint(linkInfo) !== fileFingerprint(before)) {
      throw configurationError("Redis state config changed before it was opened");
    }
    if (process.platform !== "win32" && before.nlink !== 1) {
      throw configurationError("Redis state config must not have hard links");
    }
    let canonicalFileAfterOpen: string;
    try {
      canonicalFileAfterOpen = await realpath(filePath);
    } catch (error) {
      throw configurationError(`cannot revalidate Redis state config boundary: ${errnoCode(error) || "unknown error"}`);
    }
    if (canonicalFileAfterOpen !== canonicalFileBefore || isWithin(canonicalHubRoot, canonicalFileAfterOpen)) {
      throw configurationError("Redis state config path changed while it was being opened");
    }
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > MAX_CONFIG_BYTES) throw configurationError(`Redis state config exceeds ${MAX_CONFIG_BYTES} bytes`);
    const after = await handle.stat();
    if (fileFingerprint(before) !== fileFingerprint(after)) {
      throw configurationError("Redis state config changed while it was being read");
    }
    let canonicalFileAfterRead: string;
    try {
      canonicalFileAfterRead = await realpath(filePath);
    } catch (error) {
      throw configurationError(`cannot revalidate Redis state config boundary: ${errnoCode(error) || "unknown error"}`);
    }
    if (canonicalFileAfterRead !== canonicalFileBefore || isWithin(canonicalHubRoot, canonicalFileAfterRead)) {
      throw configurationError("Redis state config path changed while it was being read");
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function loadRedisStateConfig(filePathInput: unknown, hubRoot: string): Promise<RedisStateConfig | null> {
  const filePath = String(filePathInput || "").trim();
  if (!filePath) return null;
  if (!path.isAbsolute(filePath)) {
    throw configurationError("CPB_HUB_STATE_REDIS_CONFIG_FILE must be an absolute path");
  }
  if (isWithin(hubRoot, filePath)) {
    throw configurationError("Redis state config must be stored outside CPB_HUB_ROOT");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPrivateConfig(filePath, hubRoot));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    throw configurationError("Redis state config contains invalid JSON");
  }
  const config = record(parsed, "Redis state config");
  assertOnlyKeys(config, [
    "format",
    "url",
    "registryKey",
    "topology",
    "connectTimeoutMs",
    "operationTimeoutMs",
  ], "Redis state config");
  if (config.format !== REDIS_STATE_FORMAT) {
    throw configurationError("Redis state config has an unsupported format");
  }
  if (config.topology !== undefined && config.topology !== "stable-primary-endpoint") {
    throw configurationError("Redis state config topology must be stable-primary-endpoint");
  }
  if (typeof config.url !== "string" || Buffer.byteLength(config.url, "utf8") > 4_096) {
    throw configurationError("Redis state config URL is missing or too large");
  }

  let endpoint: URL;
  try {
    endpoint = new URL(config.url);
  } catch {
    throw configurationError("Redis state config URL is invalid");
  }
  const tlsEnabled = endpoint.protocol === "rediss:";
  if (!tlsEnabled && endpoint.protocol !== "redis:") {
    throw configurationError("Redis state config URL must use redis:// or rediss://");
  }
  if (endpoint.search || endpoint.hash) {
    throw configurationError("Redis state config URL must not contain query parameters or fragments");
  }
  if (!endpoint.hostname) throw configurationError("Redis state config URL must include a host");
  if (!tlsEnabled && !isLoopbackHost(endpoint.hostname)) {
    throw configurationError("cleartext Redis is allowed only on a loopback host; use rediss:// for remote state");
  }
  const port = endpoint.port ? Number(endpoint.port) : 6379;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw configurationError("Redis state config URL has an invalid port");
  }

  let username: string | null = null;
  let password: string | null = null;
  try {
    username = endpoint.username ? decodeURIComponent(endpoint.username) : null;
    password = endpoint.password ? decodeURIComponent(endpoint.password) : null;
  } catch {
    throw configurationError("Redis state config URL has invalid credentials encoding");
  }
  if (username !== null && password === null) {
    throw configurationError("Redis state config URL with a username must include a password");
  }
  if ((username && Buffer.byteLength(username, "utf8") > 1_024) || (password && Buffer.byteLength(password, "utf8") > 4_096)) {
    throw configurationError("Redis state config credentials are too large");
  }

  const pathName = endpoint.pathname === "" || endpoint.pathname === "/" ? "/0" : endpoint.pathname;
  if (!/^\/\d+$/.test(pathName)) {
    throw configurationError("Redis state config URL path must select one numeric database");
  }
  const database = Number(pathName.slice(1));
  if (!Number.isSafeInteger(database) || database < 0 || database > 1_024) {
    throw configurationError("Redis state config database is out of range");
  }

  if (
    typeof config.registryKey !== "string"
    || Buffer.byteLength(config.registryKey, "utf8") < 1
    || Buffer.byteLength(config.registryKey, "utf8") > 256
    || /[\u0000-\u0020\u007f]/.test(config.registryKey)
  ) {
    throw configurationError("Redis state config registryKey must be 1-256 bytes without whitespace or controls");
  }
  if (!/\{[^{}]+\}/.test(config.registryKey)) {
    throw configurationError("Redis state config registryKey must contain a non-empty hash tag such as {production}");
  }

  return {
    sourceFile: filePath,
    host: endpoint.hostname.replace(/^\[|\]$/g, ""),
    port,
    tls: tlsEnabled,
    username,
    password,
    database,
    registryKey: config.registryKey,
    topology: "stable-primary-endpoint",
    connectTimeoutMs: timeoutValue(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, "connectTimeoutMs"),
    operationTimeoutMs: timeoutValue(config.operationTimeoutMs, DEFAULT_OPERATION_TIMEOUT_MS, "operationTimeoutMs"),
  };
}

function encodeCommand(parts: Array<string | number>) {
  const chunks = [Buffer.from(`*${parts.length}\r\n`, "utf8")];
  for (const part of parts) {
    const value = Buffer.from(String(part), "utf8");
    chunks.push(Buffer.from(`$${value.length}\r\n`, "utf8"), value, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

function lineEnd(buffer: Buffer, offset: number) {
  const end = buffer.indexOf("\r\n", offset);
  if (end < 0) {
    if (buffer.length - offset > MAX_LINE_BYTES) throw new Error("Redis response line is too large");
    throw new IncompleteRedisReply();
  }
  if (end - offset > MAX_LINE_BYTES) throw new Error("Redis response line is too large");
  return end;
}

function decodeUtf8(buffer: Buffer) {
  return utf8.decode(buffer);
}

function parseRedisReply(
  buffer: Buffer,
  offset = 0,
  depth = 0,
  budget: { nodes: number } = { nodes: 0 },
): { value: RedisValue; offset: number } {
  budget.nodes += 1;
  if (budget.nodes > MAX_PARSED_NODES) throw new Error("Redis response contains too many values");
  if (depth > MAX_NESTING_DEPTH) throw new Error("Redis response nesting is too deep");
  if (offset >= buffer.length) throw new IncompleteRedisReply();
  const marker = buffer[offset];
  const start = offset + 1;

  if (marker === 43 || marker === 45 || marker === 58) {
    const end = lineEnd(buffer, start);
    const text = decodeUtf8(buffer.subarray(start, end));
    if (marker === 45) throw new RedisReplyError(text);
    if (marker === 43) return { value: text, offset: end + 2 };
    if (!/^-?\d+$/.test(text)) throw new Error("Redis integer response is invalid");
    const value = Number(text);
    if (!Number.isSafeInteger(value)) throw new Error("Redis integer response is out of range");
    return { value, offset: end + 2 };
  }

  if (marker === 36) {
    const end = lineEnd(buffer, start);
    const lengthText = decodeUtf8(buffer.subarray(start, end));
    if (!/^-?\d+$/.test(lengthText)) throw new Error("Redis bulk length is invalid");
    const length = Number(lengthText);
    if (length === -1) return { value: null, offset: end + 2 };
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) {
      throw new Error("Redis bulk response is too large");
    }
    const dataStart = end + 2;
    const dataEnd = dataStart + length;
    if (dataEnd + 2 > buffer.length) throw new IncompleteRedisReply();
    if (buffer[dataEnd] !== 13 || buffer[dataEnd + 1] !== 10) throw new Error("Redis bulk response is malformed");
    return { value: decodeUtf8(buffer.subarray(dataStart, dataEnd)), offset: dataEnd + 2 };
  }

  if (marker === 42) {
    const end = lineEnd(buffer, start);
    const lengthText = decodeUtf8(buffer.subarray(start, end));
    if (!/^-?\d+$/.test(lengthText)) throw new Error("Redis array length is invalid");
    const length = Number(lengthText);
    if (length === -1) return { value: null, offset: end + 2 };
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
      throw new Error("Redis array response is too large");
    }
    const values: RedisValue[] = [];
    let nextOffset = end + 2;
    for (let index = 0; index < length; index += 1) {
      const parsed = parseRedisReply(buffer, nextOffset, depth + 1, budget);
      values.push(parsed.value);
      nextOffset = parsed.offset;
    }
    return { value: values, offset: nextOffset };
  }

  throw new Error("Redis response type is unsupported");
}

async function connect(config: RedisStateConfig): Promise<Socket | TLSSocket> {
  const socket = config.tls
    ? tls.connect({
      host: config.host,
      port: config.port,
      servername: net.isIP(config.host) ? undefined : config.host,
      rejectUnauthorized: true,
    })
    : net.createConnection({ host: config.host, port: config.port });
  socket.setNoDelay(true);

  const eventName = config.tls ? "secureConnect" : "connect";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error("Redis connection timed out"));
    }, config.connectTimeoutMs);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once(eventName, onConnect);
    socket.once("error", onError);
  });
  return socket;
}

type RedisPoolConnection = {
  socket: Socket | TLSSocket;
  busy: boolean;
  closed: boolean;
  idleTimer: NodeJS.Timeout | null;
};

class RedisPoolSemaphore {
  available: number;
  waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  constructor(size: number) {
    this.available = size;
  }

  acquire(timeoutMs: number): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaseHandle());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Redis connection pool wait timed out"));
        }, timeoutMs),
      };
      waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  private releaseHandle() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(this.releaseHandle());
      } else {
        this.available += 1;
      }
    };
  }
}

type RedisConnectionPool = {
  config: RedisStateConfig;
  connections: Set<RedisPoolConnection>;
  semaphore: RedisPoolSemaphore;
};

const connectionPools = new WeakMap<RedisStateConfig, RedisConnectionPool>();

function connectionPool(config: RedisStateConfig) {
  let pool = connectionPools.get(config);
  if (!pool) {
    pool = {
      config,
      connections: new Set(),
      semaphore: new RedisPoolSemaphore(MAX_POOL_CONNECTIONS),
    };
    connectionPools.set(config, pool);
  }
  return pool;
}

function discardConnection(pool: RedisConnectionPool, connection: RedisPoolConnection) {
  if (connection.idleTimer) clearTimeout(connection.idleTimer);
  connection.idleTimer = null;
  connection.closed = true;
  connection.busy = false;
  pool.connections.delete(connection);
  if (!connection.socket.destroyed) connection.socket.destroy();
}

async function executeOnSocket(
  socket: Socket | TLSSocket,
  commands: Array<Array<string | number>>,
  timeoutMs: number,
): Promise<RedisValue> {
  if (commands.length === 0) throw new Error("Redis command batch is empty");
  const replies: RedisValue[] = [];
  let pending = Buffer.allocUnsafe(8 * 1024);
  let pendingLength = 0;
  let operationTimer: NodeJS.Timeout | null = null;

  const response = new Promise<RedisValue>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (operationTimer) clearTimeout(operationTimer);
      operationTimer = null;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => fail(new Error("Redis connection closed before a complete response"));
    const onData = (chunk: Buffer) => {
      try {
        const incoming = Buffer.from(chunk);
        const required = pendingLength + incoming.length;
        if (required > MAX_RESPONSE_BYTES + MAX_LINE_BYTES) {
          throw new Error("Redis response exceeds the configured bound");
        }
        if (required > pending.length) {
          let capacity = pending.length;
          while (capacity < required) capacity = Math.min(MAX_RESPONSE_BYTES + MAX_LINE_BYTES, capacity * 2);
          const grown = Buffer.allocUnsafe(capacity);
          pending.copy(grown, 0, 0, pendingLength);
          pending = grown;
        }
        incoming.copy(pending, pendingLength);
        pendingLength = required;
        let consumed = 0;
        while (replies.length < commands.length) {
          try {
            const parsed = parseRedisReply(pending.subarray(0, pendingLength), consumed);
            replies.push(parsed.value);
            consumed = parsed.offset;
          } catch (error) {
            if (error instanceof IncompleteRedisReply) break;
            throw error;
          }
        }
        if (consumed > 0) {
          pending.copy(pending, 0, consumed, pendingLength);
          pendingLength -= consumed;
        }
        if (replies.length === commands.length) {
          if (pendingLength !== 0) throw new Error("Redis response contained unexpected trailing data");
          settled = true;
          cleanup();
          resolve(replies[replies.length - 1]);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    operationTimer = setTimeout(() => socket.destroy(new Error("Redis operation timed out")), timeoutMs);
    operationTimer.unref();
  });

  const outbound = Buffer.concat(commands.map(encodeCommand));
  let commandMayHaveBeenSent = false;
  try {
    commandMayHaveBeenSent = true;
    if (!socket.write(outbound)) await once(socket, "drain");
    return await response;
  } catch (error) {
    socket.destroy();
    await response.catch(() => undefined);
    const failure = error instanceof Error ? error : new Error(String(error));
    if (commandMayHaveBeenSent && !(failure instanceof RedisReplyError)) {
      Object.assign(failure, { redisCommandOutcome: "unknown" });
    }
    throw failure;
  }
}

async function createPoolConnection(pool: RedisConnectionPool) {
  const socket = await connect(pool.config);
  const connection: RedisPoolConnection = { socket, busy: true, closed: false, idleTimer: null };
  pool.connections.add(connection);
  socket.on("error", () => { /* active request listener reports the error; idle errors close the connection */ });
  socket.on("close", () => {
    connection.closed = true;
    connection.busy = false;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    pool.connections.delete(connection);
  });
  const setupCommands: Array<Array<string | number>> = [];
  if (pool.config.password !== null) {
    setupCommands.push(pool.config.username === null
      ? ["AUTH", pool.config.password]
      : ["AUTH", pool.config.username, pool.config.password]);
  }
  if (pool.config.database !== 0) setupCommands.push(["SELECT", pool.config.database]);
  try {
    if (setupCommands.length > 0) {
      await executeOnSocket(socket, setupCommands, pool.config.operationTimeoutMs);
    }
    return connection;
  } catch (error) {
    discardConnection(pool, connection);
    throw error;
  }
}

async function acquirePoolConnection(pool: RedisConnectionPool) {
  const releasePermit = await pool.semaphore.acquire(pool.config.operationTimeoutMs);
  try {
    let connection = [...pool.connections].find((candidate) => !candidate.busy && !candidate.closed && !candidate.socket.destroyed);
    if (!connection) connection = await createPoolConnection(pool);
    connection.busy = true;
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = null;
    connection.socket.ref();
    return { connection, releasePermit };
  } catch (error) {
    releasePermit();
    throw error;
  }
}

function releasePoolConnection(
  pool: RedisConnectionPool,
  connection: RedisPoolConnection,
  releasePermit: () => void,
  reusable: boolean,
) {
  if (!reusable || connection.closed || connection.socket.destroyed) {
    discardConnection(pool, connection);
  } else {
    connection.busy = false;
    connection.socket.unref();
    connection.idleTimer = setTimeout(() => {
      if (!connection.busy) discardConnection(pool, connection);
    }, POOL_IDLE_TIMEOUT_MS);
    connection.idleTimer.unref();
  }
  releasePermit();
}

async function execute(
  config: RedisStateConfig,
  command: Array<string | number>,
  { commitMayHaveOccurred = false }: { commitMayHaveOccurred?: boolean } = {},
): Promise<RedisValue> {
  const pool = connectionPool(config);
  let lease: Awaited<ReturnType<typeof acquirePoolConnection>> | null = null;
  let reusable = false;
  try {
    lease = await acquirePoolConnection(pool);
    const reply = await executeOnSocket(lease.connection.socket, [command], config.operationTimeoutMs);
    reusable = true;
    return reply;
  } catch (error) {
    if (error instanceof RedisReplyError && /^READONLY(?:\s|$)/.test(error.message)) {
      throw codedError("HUB_STATE_BACKEND_NOT_PRIMARY", "Redis stable endpoint is not connected to a writable primary");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_REGISTRY_INVALID")) {
      throw codedError("HUB_REGISTRY_INVALID", "Redis registry state is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_LEADER_INVALID")) {
      throw codedError("HUB_LEADER_INVALID", "Redis leader state is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_QUEUE_INVALID")) {
      throw codedError("HUB_QUEUE_INVALID", "Redis queue state is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_STATE_RECORD_INVALID")) {
      throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_HUB_MAINTENANCE_ACTIVE")) {
      throw codedError("HUB_MAINTENANCE_ACTIVE", "Hub Redis maintenance is active");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_HUB_MAINTENANCE_INVALID")) {
      throw codedError("HUB_MAINTENANCE_INVALID", "Hub Redis maintenance state is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_AUDIT_FULL")) {
      throw codedError("HUB_ACCESS_AUDIT_CAPACITY_EXHAUSTED", "Hub access audit reached its configured capacity");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_AUDIT_INVALID")) {
      throw codedError("HUB_ACCESS_AUDIT_INVALID", "Hub access audit state is inconsistent");
    }
    if (error instanceof RedisReplyError && error.message.includes("CPB_AUDIT_POLICY_MISMATCH")) {
      throw codedError("HUB_ACCESS_AUDIT_POLICY_MISMATCH", "Hub access audit capacity policy differs across nodes");
    }
    const unavailable = unavailableError();
    if (commitMayHaveOccurred && (error as { redisCommandOutcome?: unknown })?.redisCommandOutcome === "unknown") {
      Object.assign(unavailable, { commitOutcome: "unknown" });
    }
    throw unavailable;
  } finally {
    if (lease) releasePoolConnection(pool, lease.connection, lease.releasePermit, reusable);
  }
}

function responseArray(value: RedisValue, label: string) {
  if (!Array.isArray(value)) throw codedError("HUB_STATE_BACKEND_UNAVAILABLE", `${label} returned an invalid response`);
  return value;
}

function responseRevision(value: RedisValue, label: string) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw codedError("HUB_REGISTRY_INVALID", `${label} returned an invalid revision`);
  }
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw codedError("HUB_REGISTRY_INVALID", `${label} revision is out of range`);
  return revision;
}

function responseNonNegativeInteger(value: RedisValue, label: string, code = "HUB_LEADER_INVALID") {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw codedError(code, `${label} returned an invalid integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw codedError(code, `${label} integer is out of range`);
  return parsed;
}

function leaderTtl(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_TIMEOUT_MS || ttlMs > 86_400_000) {
    throw codedError("HUB_LEADER_INVALID", "leader TTL must be an integer from 50 to 86400000 milliseconds");
  }
  return ttlMs;
}

function maintenanceInput(token: string, operation?: string) {
  if (typeof token !== "string" || token.length < 16 || Buffer.byteLength(token, "utf8") > 512) {
    throw codedError("HUB_MAINTENANCE_INVALID", "maintenance token is invalid");
  }
  if (operation !== undefined && (typeof operation !== "string" || !operation.trim()
    || Buffer.byteLength(operation, "utf8") > 512)) {
    throw codedError("HUB_MAINTENANCE_INVALID", "maintenance operation is invalid");
  }
  return { token, operation: operation?.trim() };
}

function maintenanceTtl(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 86_400_000) {
    throw codedError("HUB_MAINTENANCE_INVALID", "maintenance TTL must be an integer from 1000 to 86400000 milliseconds");
  }
  return ttlMs;
}

function maintenanceIso(value: RedisValue, label: string, nullable = false) {
  if (nullable && value === "") return null;
  const millis = responseNonNegativeInteger(value, label, "HUB_MAINTENANCE_INVALID");
  if (millis > 8_640_000_000_000_000) throw codedError("HUB_MAINTENANCE_INVALID", `${label} timestamp is invalid`);
  return new Date(millis).toISOString();
}

function leaderIdentity(input: RedisLeaderIdentity) {
  if (
    !input
    || typeof input.hubId !== "string"
    || input.hubId.length < 1
    || Buffer.byteLength(input.hubId, "utf8") > 512
    || typeof input.lockToken !== "string"
    || input.lockToken.length < 16
    || Buffer.byteLength(input.lockToken, "utf8") > 512
    || typeof input.host !== "string"
    || input.host.length < 1
    || Buffer.byteLength(input.host, "utf8") > 512
    || !Number.isSafeInteger(input.pid)
    || input.pid <= 0
  ) {
    throw codedError("HUB_LEADER_INVALID", "leader identity is invalid");
  }
  return input;
}

function leaderFence(input: RedisLeaderFence) {
  leaderIdentity({ ...input, host: "fence", pid: 1 });
  if (!Number.isSafeInteger(input.epoch) || input.epoch <= 0) {
    throw codedError("HUB_LEADER_INVALID", "leader epoch is invalid");
  }
  return input;
}

function millisIso(value: RedisValue, label: string, nullable = false) {
  if (nullable && value === "") return null;
  const millis = responseNonNegativeInteger(value, label);
  if (millis > 8_640_000_000_000_000) throw codedError("HUB_LEADER_INVALID", `${label} timestamp is invalid`);
  return new Date(millis).toISOString();
}

function validateQueueEnvelope(serialized: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw codedError("HUB_QUEUE_INVALID", "Redis queue data is not valid JSON");
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { entries?: unknown }).entries)
    || !(parsed as { entries: unknown[] }).entries.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
  ) {
    throw codedError("HUB_QUEUE_INVALID", "Redis queue data has an invalid envelope");
  }
}

function stateField(value: string, label = "state field") {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{1,512}$/.test(value)) {
    throw codedError("HUB_STATE_RECORD_INVALID", `${label} is invalid`);
  }
  return value;
}

function parseStateRecord(value: RedisValue, label: string): RedisStateRecord {
  if (value === null) return { revision: 0, data: null };
  if (typeof value !== "string") throw codedError("HUB_STATE_RECORD_INVALID", `${label} is not a string`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw codedError("HUB_STATE_RECORD_INVALID", `${label} is not valid JSON`);
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || Array.isArray(parsed)
    || !Number.isSafeInteger((parsed as { revision?: unknown }).revision)
    || Number((parsed as { revision?: unknown }).revision) < 1
    || ((parsed as { deleted?: unknown }).deleted === true && Object.prototype.hasOwnProperty.call(parsed, "data"))
    || ((parsed as { deleted?: unknown }).deleted !== true && !Object.prototype.hasOwnProperty.call(parsed, "data"))
    || ((parsed as { deleted?: unknown }).deleted !== true && Object.prototype.hasOwnProperty.call(parsed, "deletedAtMs"))
    || (Object.prototype.hasOwnProperty.call(parsed, "deletedAtMs")
      && (!Number.isSafeInteger((parsed as { deletedAtMs?: unknown }).deletedAtMs)
        || Number((parsed as { deletedAtMs?: unknown }).deletedAtMs) < 0))
    || (Object.prototype.hasOwnProperty.call(parsed, "data") && (parsed as { data?: unknown }).data === null)
  ) {
    throw codedError("HUB_STATE_RECORD_INVALID", `${label} has an invalid envelope`);
  }
  const deleted = (parsed as { deleted?: boolean }).deleted === true;
  return {
    revision: Number((parsed as { revision: number }).revision),
    data: deleted ? null : (parsed as { data: unknown }).data,
    ...(deleted ? { deletedAtMs: Object.prototype.hasOwnProperty.call(parsed, "deletedAtMs")
      ? Number((parsed as { deletedAtMs: number }).deletedAtMs)
      : null } : {}),
  };
}

function validateLogicalSnapshot(value: unknown, identityFingerprint: string): RedisLogicalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot must be an object");
  }
  const raw = value as Partial<RedisLogicalSnapshot>;
  if (raw.format !== "cpb-hub-redis-logical-snapshot/v1"
    || raw.backendIdentityFingerprint !== identityFingerprint
    || typeof raw.capturedAt !== "string"
    || !Number.isFinite(Date.parse(raw.capturedAt))
    || new Date(Date.parse(raw.capturedAt)).toISOString() !== raw.capturedAt
    || !Array.isArray(raw.hashFields)
    || !Array.isArray(raw.jobStreams)
    || typeof raw.sha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(raw.sha256)) {
    throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot metadata is invalid");
  }
  const hashFields: Array<[string, string]> = [];
  const fieldNames = new Set<string>();
  const statePrefixes = ["assignment:", "worker:", "workerInbox:", "lease:", "job:"];
  const persistentMetadata = new Set(["revision", "data", "queueRevision", "queueData", "leaderEpoch"]);
  for (const tuple of raw.hashFields) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string" || typeof tuple[1] !== "string"
      || fieldNames.has(tuple[0]) || tuple[0].startsWith("maintenance") || tuple[0].startsWith("leader") && tuple[0] !== "leaderEpoch"
      || (!persistentMetadata.has(tuple[0]) && !statePrefixes.some((prefix) => tuple[0].startsWith(prefix)))) {
      throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot hash field is invalid");
    }
    if (statePrefixes.some((prefix) => tuple[0].startsWith(prefix))) {
      parseStateRecord(tuple[1], `Redis logical snapshot ${tuple[0]}`);
    }
    fieldNames.add(tuple[0]);
    hashFields.push([tuple[0], tuple[1]]);
  }
  const sortedFields = [...hashFields].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (hashFields.length > MAX_SCAN_RECORDS || JSON.stringify(hashFields) !== JSON.stringify(sortedFields)) {
    throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot hash fields are not canonical");
  }
  const revision = new Map(hashFields).get("revision");
  const data = new Map(hashFields).get("data");
  if ((revision === undefined) !== (data === undefined)) throw codedError("HUB_REGISTRY_INVALID", "Redis logical snapshot registry fields are inconsistent");
  if (revision !== undefined && data !== undefined) {
    const parsedRevision = responseRevision(revision, "Redis logical snapshot registry revision");
    let registry: unknown;
    try { registry = JSON.parse(data); } catch { throw codedError("HUB_REGISTRY_INVALID", "Redis logical snapshot registry is invalid"); }
    if (!registry || typeof registry !== "object" || Array.isArray(registry)
      || Number((registry as { revision?: unknown }).revision) !== parsedRevision) {
      throw codedError("HUB_REGISTRY_INVALID", "Redis logical snapshot registry revision mismatch");
    }
  }
  const queueRevision = new Map(hashFields).get("queueRevision");
  const queueData = new Map(hashFields).get("queueData");
  if ((queueRevision === undefined) !== (queueData === undefined)) throw codedError("HUB_QUEUE_INVALID", "Redis logical snapshot queue fields are inconsistent");
  if (queueRevision !== undefined && queueData !== undefined) {
    responseNonNegativeInteger(queueRevision, "Redis logical snapshot queue revision", "HUB_QUEUE_INVALID");
    validateQueueEnvelope(queueData);
  }
  const leaderEpoch = new Map(hashFields).get("leaderEpoch");
  if (leaderEpoch !== undefined) responseNonNegativeInteger(leaderEpoch, "Redis logical snapshot leader epoch", "HUB_LEADER_INVALID");

  const jobStreams: RedisLogicalSnapshot["jobStreams"] = [];
  const expectedJobFields = hashFields.filter(([field]) => field.startsWith("job:")).map(([field]) => field);
  let eventCount = 0;
  for (const stream of raw.jobStreams) {
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
      throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot job stream is invalid");
    }
    const entry = stream as { field?: unknown; events?: unknown };
    if (typeof entry.field !== "string" || !Array.isArray(entry.events)
      || !entry.events.every((event) => typeof event === "string" && Buffer.byteLength(event, "utf8") <= 1024 * 1024)) {
      throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot job stream is invalid");
    }
    for (const event of entry.events as string[]) {
      try {
        const parsed = JSON.parse(event);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected object");
      } catch {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot job event is invalid");
      }
    }
    eventCount += entry.events.length;
    if (eventCount > MAX_SNAPSHOT_EVENTS) throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis logical snapshot contains too many events");
    jobStreams.push({ field: entry.field, events: [...entry.events] as string[] });
  }
  if (jobStreams.length > MAX_SNAPSHOT_STREAMS
    || JSON.stringify(jobStreams.map((stream) => stream.field)) !== JSON.stringify(expectedJobFields)) {
    throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot job stream set is incomplete or non-canonical");
  }
  const snapshotBody = {
    format: raw.format,
    backendIdentityFingerprint: raw.backendIdentityFingerprint,
    capturedAt: raw.capturedAt,
    hashFields,
    jobStreams,
  };
  const digest = createHash("sha256").update(JSON.stringify(snapshotBody), "utf8").digest("hex");
  if (digest !== raw.sha256) throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot digest mismatch");
  return { ...snapshotBody, sha256: digest } as RedisLogicalSnapshot;
}

export async function openHubRedisStateBackend(options: {
  configFile?: unknown;
  hubRoot: string;
}): Promise<HubRedisStateBackend | null> {
  const config = await loadRedisStateConfig(options.configFile, options.hubRoot);
  if (!config) return null;
  const identityFingerprint = createHash("sha256").update(JSON.stringify({
    host: config.host,
    port: config.port,
    tls: config.tls,
    database: config.database,
    registryKey: config.registryKey,
  }), "utf8").digest("hex");

  const readLeader = async (): Promise<RedisLeaderStatus> => {
    const reply = responseArray(
      await execute(config, ["EVAL", LEADER_READ_SCRIPT, 1, config.registryKey]),
      "Redis leader read",
    );
    if (reply.length !== 11 || (reply[10] !== 0 && reply[10] !== 1)) {
      throw codedError("HUB_LEADER_INVALID", "Redis leader read returned an invalid response");
    }
    const pidValue = reply[4] === "" ? null : responseNonNegativeInteger(reply[4], "Redis leader PID");
    if (pidValue !== null && pidValue < 1) throw codedError("HUB_LEADER_INVALID", "Redis leader PID is invalid");
    return {
      alive: reply[10] === 1,
      hubId: reply[2] === "" ? null : String(reply[2]),
      lockToken: reply[1] === "" ? null : String(reply[1]),
      host: reply[3] === "" ? null : String(reply[3]),
      pid: pidValue,
      epoch: responseNonNegativeInteger(reply[0], "Redis leader epoch"),
      startedAt: millisIso(reply[5], "Redis leader start", true),
      heartbeatAt: millisIso(reply[6], "Redis leader heartbeat", true),
      expiresAt: millisIso(reply[7], "Redis leader expiry", true),
      releasedAt: millisIso(reply[8], "Redis leader release", true),
      serverTime: millisIso(reply[9], "Redis server time") as string,
    };
  };

  const readRegistry = async () => {
    const reply = responseArray(
      await execute(config, ["HMGET", config.registryKey, "revision", "data"]),
      "Redis registry read",
    );
    if (reply.length !== 2) throw codedError("HUB_REGISTRY_INVALID", "Redis registry read returned an invalid field count");
    if (reply[0] === null && reply[1] === null) return null;
    if (reply[0] === null || reply[1] === null || typeof reply[1] !== "string") {
      throw codedError("HUB_REGISTRY_INVALID", "Redis registry fields are inconsistent");
    }
    const revision = responseRevision(reply[0], "Redis registry read");
    let stored: unknown;
    try {
      stored = JSON.parse(reply[1]);
    } catch {
      throw codedError("HUB_REGISTRY_INVALID", "Redis registry data is not valid JSON");
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored) || Number((stored as { revision?: unknown }).revision) !== revision) {
      throw codedError("HUB_REGISTRY_INVALID", "Redis registry revision does not match its data");
    }
    return reply[1];
  };

  const readQueue = async () => {
    const reply = responseArray(
      await execute(config, ["HMGET", config.registryKey, "queueRevision", "queueData"]),
      "Redis queue read",
    );
    if (reply.length !== 2) throw codedError("HUB_QUEUE_INVALID", "Redis queue read returned an invalid field count");
    if (reply[0] === null && reply[1] === null) return { revision: 0, serialized: null };
    if (reply[0] === null || typeof reply[1] !== "string") {
      throw codedError("HUB_QUEUE_INVALID", "Redis queue fields are inconsistent");
    }
    const revision = responseNonNegativeInteger(reply[0], "Redis queue revision", "HUB_QUEUE_INVALID");
    validateQueueEnvelope(reply[1]);
    return { revision, serialized: reply[1] };
  };

  const readMaintenance = async (): Promise<RedisMaintenanceStatus> => {
    const reply = responseArray(
      await execute(config, ["EVAL", MAINTENANCE_READ_SCRIPT, 1, config.registryKey]),
      "Redis maintenance read",
    );
    if (reply.length !== 5) throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance read returned an invalid response");
    const serverTime = maintenanceIso(reply[4], "Redis maintenance server time") as string;
    if (reply[0] === "") {
      if (reply[1] !== "" || reply[2] !== "" || reply[3] !== "") {
        throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance fields are inconsistent");
      }
      return { active: false, token: null, operation: null, acquiredAt: null, expiresAt: null, serverTime };
    }
    if (typeof reply[0] !== "string" || typeof reply[1] !== "string" || !reply[1]
      || reply[2] === "" || reply[3] === "") {
      throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance fields are inconsistent");
    }
    return {
      active: true,
      token: reply[0],
      operation: reply[1],
      acquiredAt: maintenanceIso(reply[2], "Redis maintenance acquired time") as string,
      expiresAt: maintenanceIso(reply[3], "Redis maintenance expiry") as string,
      serverTime,
    };
  };

  const readJobEvents = async (field: string) => {
    const checkedField = stateField(field);
    if (!checkedField.startsWith("job:")) throw codedError("HUB_STATE_RECORD_INVALID", "Redis job field is invalid");
    const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
    if (!hashTag) throw codedError("HUB_STATE_CONFIG_INVALID", "registryKey must contain a hash tag before job events can be shared");
    const streamKey = `cpb:${hashTag}:job-events:${checkedField.slice("job:".length)}`;
    const events: string[] = [];
    let cursor = "-";
    for (let page = 0; page < 10_000; page += 1) {
      const reply = responseArray(await execute(config, ["XRANGE", streamKey, cursor, "+", "COUNT", 10]), "Redis job event read");
      if (reply.length === 0) return events;
      for (const item of reply) {
        const entry = responseArray(item, "Redis job event entry");
        if (entry.length !== 2 || typeof entry[0] !== "string") throw codedError("HUB_STATE_RECORD_INVALID", "Redis job event entry is invalid");
        const fields = responseArray(entry[1], "Redis job event fields");
        const eventIndex = fields.findIndex((value) => value === "event");
        if (eventIndex < 0 || typeof fields[eventIndex + 1] !== "string") throw codedError("HUB_STATE_RECORD_INVALID", "Redis job event payload is missing");
        events.push(fields[eventIndex + 1] as string);
        if (events.length > 100_000) throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job event history exceeds 100000 events");
        cursor = `(${entry[0]}`;
      }
      if (reply.length < 10) return events;
    }
    throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job event read exceeded its page bound");
  };

  const accessAuditStreamKey = () => {
    const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
    if (!hashTag) throw codedError("HUB_STATE_CONFIG_INVALID", "registryKey must contain a Redis hash tag before access audit can be shared");
    return `cpb:${hashTag}:access-audit`;
  };

  const readAccessAuditHead = async (): Promise<RedisAccessAuditHead> => {
    const reply = responseArray(await execute(config, [
      "HMGET", config.registryKey, "auditSequence", "auditHash", "auditBytes", "auditMaxBytes",
    ]), "Redis access audit head");
    if (reply.length !== 4 || (reply[0] === null) !== (reply[1] === null)
      || (reply[0] === null) !== (reply[2] === null) || (reply[0] === null) !== (reply[3] === null)) {
      throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit head is inconsistent");
    }
    if (reply[0] === null) return { sequence: 0, hash: "0".repeat(64), sizeBytes: 0, maxBytes: null };
    if (typeof reply[1] !== "string" || !/^[a-f0-9]{64}$/.test(reply[1])) {
      throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit hash is invalid");
    }
    return {
      sequence: responseNonNegativeInteger(reply[0], "Redis access audit sequence", "HUB_ACCESS_AUDIT_INVALID"),
      hash: reply[1],
      sizeBytes: responseNonNegativeInteger(reply[2], "Redis access audit bytes", "HUB_ACCESS_AUDIT_INVALID"),
      maxBytes: responseNonNegativeInteger(reply[3], "Redis access audit max bytes", "HUB_ACCESS_AUDIT_INVALID"),
    };
  };

  const readAccessAuditRecords = async (throughSequence?: number) => {
    if (throughSequence !== undefined && (!Number.isSafeInteger(throughSequence) || throughSequence < 0)) {
      throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit sequence bound is invalid");
    }
    const records: string[] = [];
    if (throughSequence === 0) return records;
    let cursor = "-";
    for (let page = 0; page < 100_000; page += 1) {
      const reply = responseArray(await execute(config, [
        "XRANGE", accessAuditStreamKey(), cursor, "+", "COUNT", 100,
      ]), "Redis access audit read");
      if (reply.length === 0) return records;
      for (const item of reply) {
        const entry = responseArray(item, "Redis access audit entry");
        if (entry.length !== 2 || typeof entry[0] !== "string") {
          throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit entry is invalid");
        }
        const fields = responseArray(entry[1], "Redis access audit fields");
        const recordIndex = fields.findIndex((value) => value === "record");
        const sequenceIndex = fields.findIndex((value) => value === "sequence");
        if (recordIndex < 0 || typeof fields[recordIndex + 1] !== "string" || sequenceIndex < 0
          || responseNonNegativeInteger(fields[sequenceIndex + 1], "Redis access audit stream sequence", "HUB_ACCESS_AUDIT_INVALID") !== records.length + 1) {
          throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit entry fields are invalid");
        }
        records.push(fields[recordIndex + 1] as string);
        if (records.length > 1_000_000) {
          throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis access audit exceeds 1000000 records");
        }
        cursor = `(${entry[0]}`;
        if (throughSequence !== undefined && records.length === throughSequence) return records;
      }
      if (reply.length < 100) return records;
    }
    throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis access audit read exceeded its page bound");
  };

  const exportSnapshot = async (token: string): Promise<RedisLogicalSnapshot> => {
    const checked = maintenanceInput(token);
    const maintenanceBefore = await readMaintenance();
    if (!maintenanceBefore.active || maintenanceBefore.token !== checked.token) {
      throw codedError("HUB_MAINTENANCE_ACTIVE", "Redis logical snapshot requires ownership of the active maintenance lease");
    }
    await Promise.all([readRegistry(), readQueue(), readLeader()]);
    const hashFields: Array<[string, string]> = [];
    const statePrefixes = ["assignment:", "worker:", "workerInbox:", "lease:", "job:"];
    const persistentMetadata = new Set(["revision", "data", "queueRevision", "queueData", "leaderEpoch"]);
    const transientMetadata = new Set([
      "leaderToken", "leaderHubId", "leaderHost", "leaderPid", "leaderStartedAtMs",
      "leaderHeartbeatAtMs", "leaderExpiresAtMs", "leaderReleasedAtMs",
      "maintenanceToken", "maintenanceOperation", "maintenanceAcquiredAtMs", "maintenanceExpiresAtMs",
      "auditSequence", "auditHash", "auditBytes", "auditMaxBytes",
    ]);
    let cursor = "0";
    let scannedRecords = 0;
    let scannedBytes = 0;
    let pages = 0;
    const startedAt = Date.now();
    do {
      pages += 1;
      if (pages > MAX_SCAN_PAGES || Date.now() - startedAt > MAX_SCAN_MS) {
        throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis logical snapshot scan exceeded its work bound");
      }
      const reply = responseArray(await execute(config, ["HSCAN", config.registryKey, cursor, "COUNT", 1]), "Redis logical snapshot scan");
      if (reply.length !== 2 || typeof reply[0] !== "string") {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot scan returned an invalid cursor");
      }
      const fields = responseArray(reply[1], "Redis logical snapshot fields");
      if (fields.length % 2 !== 0) throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot returned an invalid field list");
      for (let index = 0; index < fields.length; index += 2) {
        const field = fields[index];
        const value = fields[index + 1];
        if (typeof field !== "string" || typeof value !== "string") {
          throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot field is invalid");
        }
        scannedRecords += 1;
        scannedBytes += Buffer.byteLength(field, "utf8") + Buffer.byteLength(value, "utf8");
        if (scannedRecords > MAX_SCAN_RECORDS || scannedBytes > MAX_SCAN_BYTES) {
          throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis logical snapshot exceeded its size bound");
        }
        if (transientMetadata.has(field)) continue;
        if (!persistentMetadata.has(field) && !statePrefixes.some((prefix) => field.startsWith(prefix))) {
          throw codedError("HUB_STATE_RECORD_INVALID", `Redis logical snapshot found unsupported field ${field}`);
        }
        if (statePrefixes.some((prefix) => field.startsWith(prefix))) parseStateRecord(value, `Redis logical snapshot ${field}`);
        hashFields.push([field, value]);
      }
      cursor = reply[0];
      if (!/^\d+$/.test(cursor)) throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical snapshot cursor is invalid");
    } while (cursor !== "0");
    hashFields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    const jobStreams = [] as RedisLogicalSnapshot["jobStreams"];
    for (const [field] of hashFields) {
      if (field.startsWith("job:")) jobStreams.push({ field, events: await readJobEvents(field) });
    }
    const maintenanceAfter = await readMaintenance();
    if (!maintenanceAfter.active || maintenanceAfter.token !== checked.token) {
      throw codedError("HUB_MAINTENANCE_ACTIVE", "Redis maintenance lease expired during logical snapshot");
    }
    const snapshotBody = {
      format: "cpb-hub-redis-logical-snapshot/v1" as const,
      backendIdentityFingerprint: identityFingerprint,
      capturedAt: maintenanceAfter.serverTime,
      hashFields,
      jobStreams,
    };
    return {
      ...snapshotBody,
      sha256: createHash("sha256").update(JSON.stringify(snapshotBody), "utf8").digest("hex"),
    };
  };

  const restoreSnapshot = async (token: string, input: RedisLogicalSnapshot): Promise<RedisLogicalSnapshot> => {
    const checked = maintenanceInput(token);
    const snapshot = validateLogicalSnapshot(input, identityFingerprint);
    const commitEvidence: RedisRestoreCommitEvidence = {
      registryKey: config.registryKey,
      backendIdentityFingerprint: identityFingerprint,
      snapshotSha256: snapshot.sha256,
      operationToken: checked.token,
    };
    const maintenance = await readMaintenance();
    if (!maintenance.active || maintenance.token !== checked.token || !maintenance.operation
      || !maintenance.acquiredAt || !maintenance.expiresAt) {
      throw codedError("HUB_MAINTENANCE_ACTIVE", "Redis logical restore requires ownership of the active maintenance lease");
    }
    const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
    if (!hashTag) throw codedError("HUB_STATE_CONFIG_INVALID", "registryKey must contain a hash tag before restore");
    const jobStreamKey = (field: string) => `cpb:${hashTag}:job-events:${field.slice("job:".length)}`;
    const stageId = createHash("sha256").update(`${snapshot.sha256}\0${checked.token}`, "utf8").digest("hex").slice(0, 24);
    const stageHashKey = `cpb:${hashTag}:restore:${stageId}:registry`;
    const stageStreamKeys = snapshot.jobStreams.map((_stream, index) => `cpb:${hashTag}:restore:${stageId}:stream:${index}`);
    const cleanupStage = async () => {
      for (const key of [stageHashKey, ...stageStreamKeys]) await execute(config, ["DEL", key]).catch(() => undefined);
    };
    await cleanupStage();
    try {
      const currentLeaderEpoch = (await readLeader()).epoch;
      const targetLeaderEpoch = Number(new Map(snapshot.hashFields).get("leaderEpoch") || 0);
      const effectiveLeaderEpoch = Math.max(currentLeaderEpoch, targetLeaderEpoch) + 1;
      const effectiveHashFields = snapshot.hashFields
        .filter(([field]) => field !== "leaderEpoch")
        .concat([["leaderEpoch", String(effectiveLeaderEpoch)]]) as Array<[string, string]>;
      effectiveHashFields.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);

      let batch: Array<string | number> = ["HSET", stageHashKey];
      let batchBytes = 0;
      const flushHashBatch = async () => {
        if (batch.length <= 2) return;
        await execute(config, batch);
        batch = ["HSET", stageHashKey];
        batchBytes = 0;
      };
      for (const [field, value] of effectiveHashFields) {
        const fieldBytes = Buffer.byteLength(field, "utf8") + Buffer.byteLength(value, "utf8");
        if (batch.length > 2 && (batchBytes + fieldBytes > 8 * 1024 * 1024 || batch.length >= 202)) await flushHashBatch();
        batch.push(field, value);
        batchBytes += fieldBytes;
      }
      await flushHashBatch();
      await execute(config, [
        "HSET", stageHashKey,
        "maintenanceToken", checked.token,
        "maintenanceOperation", maintenance.operation,
        "maintenanceAcquiredAtMs", Date.parse(maintenance.acquiredAt),
        "maintenanceExpiresAtMs", Date.parse(maintenance.expiresAt),
      ]);

      for (let streamIndex = 0; streamIndex < snapshot.jobStreams.length; streamIndex += 1) {
        const events = snapshot.jobStreams[streamIndex].events;
        const stageStreamKey = stageStreamKeys[streamIndex];
        let offset = 0;
        while (offset < events.length) {
          const chunk: string[] = [];
          let chunkBytes = 0;
          while (offset + chunk.length < events.length && chunk.length < 100) {
            const event = events[offset + chunk.length];
            const eventBytes = Buffer.byteLength(event, "utf8");
            if (chunk.length > 0 && chunkBytes + eventBytes > 8 * 1024 * 1024) break;
            chunk.push(event);
            chunkBytes += eventBytes;
          }
          const reply = await execute(config, [
            "EVAL", RESTORE_STAGE_STREAM_SCRIPT, 1, stageStreamKey, offset, ...chunk,
          ]);
          if (reply !== chunk.length) throw codedError("HUB_STATE_RECORD_INVALID", "Redis restore staging stream append failed");
          offset += chunk.length;
        }
      }

      const existingStreamKeys: string[] = [];
      let scanCursor = "0";
      let scanPages = 0;
      do {
        scanPages += 1;
        if (scanPages > MAX_SCAN_PAGES) throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis restore stream scan exceeded its bound");
        const reply = responseArray(await execute(config, [
          "SCAN", scanCursor, "MATCH", `cpb:${hashTag}:job-events:*`, "COUNT", 100,
        ]), "Redis restore stream scan");
        if (reply.length !== 2 || typeof reply[0] !== "string") throw codedError("HUB_STATE_RECORD_INVALID", "Redis restore stream scan is invalid");
        const keys = responseArray(reply[1], "Redis restore stream keys");
        for (const key of keys) {
          if (typeof key !== "string" || !key.startsWith(`cpb:${hashTag}:job-events:`)) {
            throw codedError("HUB_STATE_RECORD_INVALID", "Redis restore stream key is invalid");
          }
          existingStreamKeys.push(key);
          if (existingStreamKeys.length > MAX_SNAPSHOT_STREAMS) {
            throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis restore contains too many existing streams");
          }
        }
        scanCursor = reply[0];
      } while (scanCursor !== "0");
      existingStreamKeys.sort();
      const targetPairs = snapshot.jobStreams.flatMap((stream, index) => [jobStreamKey(stream.field), stageStreamKeys[index]]);
      const commitKeys = [config.registryKey, stageHashKey, ...existingStreamKeys, ...targetPairs];
      let committed: RedisValue;
      try {
        committed = await execute(config, [
          "EVAL", RESTORE_COMMIT_SCRIPT, commitKeys.length, ...commitKeys,
          checked.token, existingStreamKeys.length, snapshot.jobStreams.length,
        ], { commitMayHaveOccurred: true });
      } catch (error) {
        if ((error as { commitOutcome?: unknown })?.commitOutcome === "unknown") {
          throw markRedisRestoreCommitOutcome(error, "unknown", commitEvidence, {
            registryKey: config.registryKey,
            stageRegistryKey: stageHashKey,
            stageStreamKeys: Object.freeze([...stageStreamKeys]),
            backendIdentityFingerprint: identityFingerprint,
            snapshotSha256: snapshot.sha256,
          });
        }
        throw error;
      }
      if (committed !== 1) throw codedError("HUB_STATE_BACKEND_UNAVAILABLE", "Redis logical restore commit failed");

      try {
        const restored = await exportSnapshot(checked.token);
        if (JSON.stringify(restored.hashFields) !== JSON.stringify(effectiveHashFields)
          || JSON.stringify(restored.jobStreams) !== JSON.stringify(snapshot.jobStreams)) {
          throw codedError("HUB_STATE_RECORD_INVALID", "Redis logical restore verification failed");
        }
        return restored;
      } catch (error) {
        throw markRedisRestoreCommitOutcome(error, "committed", commitEvidence, {
          registryKey: config.registryKey,
          backendIdentityFingerprint: identityFingerprint,
          snapshotSha256: snapshot.sha256,
        });
      }
    } catch (error) {
      if (redisRestoreCommitOutcome(error, commitEvidence) === "unknown") throw error;
      await cleanupStage();
      throw error;
    }
  };

  return {
    sourceFile: config.sourceFile,
    registryKey: config.registryKey,
    identityFingerprint,
    topology: config.topology,
    readRegistry,
    compareAndSwapRegistry: async (expectedRevision, nextRevision, serialized, mutationId = "") => {
      if (typeof mutationId !== "string"
        || Buffer.byteLength(mutationId, "utf8") > 128
        || /[\u0000-\u001f\u007f]/.test(mutationId)) {
        throw codedError("HUB_REGISTRY_INVALID", "Redis registry mutation id is invalid");
      }
      try {
        const reply = responseArray(await execute(config, [
          "EVAL",
          REGISTRY_CAS_SCRIPT,
          1,
          config.registryKey,
          expectedRevision,
          nextRevision,
          serialized,
          mutationId,
        ], { commitMayHaveOccurred: true }), "Redis registry CAS");
        if (reply.length !== 2 || (reply[0] !== 0 && reply[0] !== 1)) {
          throw codedError("HUB_STATE_BACKEND_UNAVAILABLE", "Redis registry CAS returned an invalid response");
        }
        return {
          committed: reply[0] === 1,
          revision: responseRevision(reply[1], "Redis registry CAS"),
        };
      } catch (error) {
        if ((error as { commitOutcome?: unknown }).commitOutcome === "unknown") {
          Object.assign(error as object, { mutationId });
        }
        throw error;
      }
    },
    acquireLeader: async (identity, ttlMs) => {
      const value = leaderIdentity(identity);
      const reply = responseArray(await execute(config, [
        "EVAL",
        LEADER_ACQUIRE_SCRIPT,
        1,
        config.registryKey,
        value.lockToken,
        value.hubId,
        value.host,
        value.pid,
        leaderTtl(ttlMs),
      ]), "Redis leader acquire");
      if (reply.length !== 5 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_LEADER_INVALID", "Redis leader acquire returned an invalid response");
      }
      responseNonNegativeInteger(reply[1], "Redis leader acquire epoch");
      millisIso(reply[3], "Redis leader acquire expiry");
      millisIso(reply[4], "Redis leader acquire server time");
      return { acquired: reply[0] === 1, leader: await readLeader() };
    },
    renewLeader: async (fence, ttlMs) => {
      const value = leaderFence(fence);
      const reply = responseArray(await execute(config, [
        "EVAL",
        LEADER_RENEW_SCRIPT,
        1,
        config.registryKey,
        value.lockToken,
        value.hubId,
        value.epoch,
        leaderTtl(ttlMs),
      ]), "Redis leader renew");
      if ((reply.length !== 2 && reply.length !== 3) || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_LEADER_INVALID", "Redis leader renew returned an invalid response");
      }
      return {
        renewed: reply[0] === 1,
        heartbeatAt: millisIso(reply[1], "Redis leader renew heartbeat") as string,
        expiresAt: reply[0] === 1 ? millisIso(reply[2], "Redis leader renew expiry") : null,
      };
    },
    releaseLeader: async (fence) => {
      const value = leaderFence(fence);
      const reply = responseArray(await execute(config, [
        "EVAL",
        LEADER_RELEASE_SCRIPT,
        1,
        config.registryKey,
        value.lockToken,
        value.hubId,
        value.epoch,
      ]), "Redis leader release");
      if (reply.length !== 2 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_LEADER_INVALID", "Redis leader release returned an invalid response");
      }
      millisIso(reply[1], "Redis leader release time");
      return reply[0] === 1;
    },
    readLeader,
    readQueue,
    compareAndSwapQueue: async (expectedRevision, nextRevision, serialized, fence = null) => {
      if (typeof serialized !== "string" || Buffer.byteLength(serialized, "utf8") > 16 * 1024 * 1024) {
        throw codedError("HUB_QUEUE_TOO_LARGE", "Redis queue state exceeds 16777216 bytes");
      }
      validateQueueEnvelope(serialized);
      const checkedFence = fence ? leaderFence(fence) : null;
      const reply = responseArray(await execute(config, [
        "EVAL",
        QUEUE_CAS_SCRIPT,
        1,
        config.registryKey,
        expectedRevision,
        nextRevision,
        serialized,
        checkedFence ? 1 : 0,
        checkedFence?.lockToken || "",
        checkedFence?.hubId || "",
        checkedFence?.epoch || 0,
      ]), "Redis queue CAS");
      if (reply.length !== 2 || (reply[0] !== -1 && reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_QUEUE_INVALID", "Redis queue CAS returned an invalid response");
      }
      return {
        committed: reply[0] === 1,
        fenced: reply[0] === -1,
        revision: responseNonNegativeInteger(reply[1], "Redis queue CAS revision", "HUB_QUEUE_INVALID"),
      };
    },
    readStateRecord: async (field) => {
      const checkedField = stateField(field);
      return parseStateRecord(
        await execute(config, ["HGET", config.registryKey, checkedField]),
        `Redis state record ${checkedField}`,
      );
    },
    compareAndSwapStateRecord: async (field, expectedRevision, data, fence = null) => {
      const checkedField = stateField(field);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record expected revision is invalid");
      }
      const nextRevision = expectedRevision + 1;
      const envelope = data === null
        ? JSON.stringify({ revision: nextRevision, deleted: true })
        : JSON.stringify({ revision: nextRevision, data });
      if (Buffer.byteLength(envelope, "utf8") > 4 * 1024 * 1024) {
        throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis state record exceeds 4194304 bytes");
      }
      parseStateRecord(envelope, "Redis state record write");
      const checkedFence = fence ? leaderFence(fence) : null;
      const reply = responseArray(await execute(config, [
        "EVAL",
        STATE_RECORD_CAS_SCRIPT,
        1,
        config.registryKey,
        checkedField,
        expectedRevision,
        nextRevision,
        envelope,
        checkedFence ? 1 : 0,
        checkedFence?.lockToken || "",
        checkedFence?.hubId || "",
        checkedFence?.epoch || 0,
      ]), "Redis state record CAS");
      if (reply.length !== 2 || (reply[0] !== -1 && reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record CAS returned an invalid response");
      }
      return {
        committed: reply[0] === 1,
        fenced: reply[0] === -1,
        revision: responseNonNegativeInteger(reply[1], "Redis state record CAS revision", "HUB_STATE_RECORD_INVALID"),
      };
    },
    commitStateRecordAndDeleteClaim: async (field, expectedRevision, data, claimField, claimToken) => {
      const checkedField = stateField(field);
      const checkedClaimField = stateField(claimField);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || typeof claimToken !== "string" || !claimToken) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis assignment/claim commit input is invalid");
      }
      const nextRevision = expectedRevision + 1;
      const envelope = JSON.stringify({ revision: nextRevision, data });
      if (Buffer.byteLength(envelope, "utf8") > 4 * 1024 * 1024) {
        throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis state record exceeds 4194304 bytes");
      }
      parseStateRecord(envelope, "Redis assignment/claim commit");
      const reply = responseArray(await execute(config, [
        "EVAL",
        STATE_RECORD_AND_CLAIM_COMMIT_SCRIPT,
        1,
        config.registryKey,
        checkedField,
        expectedRevision,
        nextRevision,
        envelope,
        checkedClaimField,
        claimToken,
      ]), "Redis assignment/claim commit");
      if (reply.length !== 2 || ![-1, 0, 1].includes(Number(reply[0]))) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis assignment/claim commit returned an invalid response");
      }
      return {
        committed: reply[0] === 1,
        claimMatched: reply[0] !== -1,
        revision: responseNonNegativeInteger(reply[1], "Redis assignment/claim commit revision", "HUB_STATE_RECORD_INVALID"),
      };
    },
    appendJobEvent: async (field, expectedRevision, projection, serializedEvent) => {
      const checkedField = stateField(field);
      if (!checkedField.startsWith("job:")) throw codedError("HUB_STATE_RECORD_INVALID", "Redis job field is invalid");
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis job projection revision is invalid");
      }
      if (typeof serializedEvent !== "string" || Buffer.byteLength(serializedEvent, "utf8") > 1024 * 1024) {
        throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job event exceeds 1048576 bytes");
      }
      const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
      if (!hashTag) {
        throw codedError("HUB_STATE_CONFIG_INVALID", "registryKey must contain a Redis hash tag before job events can be shared");
      }
      const streamKey = `cpb:${hashTag}:job-events:${checkedField.slice("job:".length)}`;
      const nextRevision = expectedRevision + 1;
      const envelope = JSON.stringify({ revision: nextRevision, data: projection });
      if (Buffer.byteLength(envelope, "utf8") > 4 * 1024 * 1024) {
        throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job projection exceeds 4194304 bytes");
      }
      parseStateRecord(envelope, "Redis job projection write");
      const reply = responseArray(await execute(config, [
        "EVAL", JOB_EVENT_APPEND_SCRIPT, 2, config.registryKey, streamKey,
        checkedField, expectedRevision, nextRevision, envelope, serializedEvent,
      ]), "Redis job event append");
      if (reply.length !== 3 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis job event append returned an invalid response");
      }
      return {
        committed: reply[0] === 1,
        revision: responseNonNegativeInteger(reply[1], "Redis job projection revision", "HUB_STATE_RECORD_INVALID"),
        streamId: reply[0] === 1 && typeof reply[2] === "string" ? reply[2] : null,
      };
    },
    readJobEvents: async (field) => {
      const checkedField = stateField(field);
      if (!checkedField.startsWith("job:")) throw codedError("HUB_STATE_RECORD_INVALID", "Redis job field is invalid");
      const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
      if (!hashTag) throw codedError("HUB_STATE_CONFIG_INVALID", "registryKey must contain a Redis hash tag before job events can be shared");
      const streamKey = `cpb:${hashTag}:job-events:${checkedField.slice("job:".length)}`;
      const events: string[] = [];
      let cursor = "-";
      for (let page = 0; page < 10_000; page += 1) {
        const reply = responseArray(await execute(config, ["XRANGE", streamKey, cursor, "+", "COUNT", 10]), "Redis job event read");
        if (reply.length === 0) return events;
        for (const item of reply) {
          const entry = responseArray(item, "Redis job event entry");
          if (entry.length !== 2 || typeof entry[0] !== "string") throw codedError("HUB_STATE_RECORD_INVALID", "Redis job event entry is invalid");
          const fields = responseArray(entry[1], "Redis job event fields");
          const eventIndex = fields.findIndex((value) => value === "event");
          if (eventIndex < 0 || typeof fields[eventIndex + 1] !== "string") throw codedError("HUB_STATE_RECORD_INVALID", "Redis job event payload is missing");
          events.push(fields[eventIndex + 1] as string);
          if (events.length > 100_000) throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job event history exceeds 100000 events");
          cursor = `(${entry[0]}`;
        }
        if (reply.length < 10) return events;
      }
      throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis job event read exceeded its page bound");
    },
    readAccessAuditHead,
    appendAccessAudit: async (expectedSequence, expectedHash, recordHash, serializedRecord, maxBytes) => {
      if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0
        || !/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(recordHash)
        || typeof serializedRecord !== "string" || Buffer.byteLength(serializedRecord, "utf8") > 16 * 1024
        || !Number.isSafeInteger(maxBytes) || maxBytes < 64 * 1024) {
        throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit append input is invalid");
      }
      const reply = responseArray(await execute(config, [
        "EVAL", ACCESS_AUDIT_APPEND_SCRIPT, 2, config.registryKey, accessAuditStreamKey(),
        expectedSequence, expectedHash, recordHash, serializedRecord, maxBytes,
      ]), "Redis access audit append");
      if (reply.length !== 6 || ![0, 1].includes(Number(reply[0]))
        || typeof reply[2] !== "string" || !/^[a-f0-9]{64}$/.test(reply[2])) {
        throw codedError("HUB_ACCESS_AUDIT_INVALID", "Redis access audit append returned an invalid response");
      }
      return {
        committed: reply[0] === 1,
        sequence: responseNonNegativeInteger(reply[1], "Redis access audit append sequence", "HUB_ACCESS_AUDIT_INVALID"),
        hash: reply[2],
        sizeBytes: responseNonNegativeInteger(reply[3], "Redis access audit append bytes", "HUB_ACCESS_AUDIT_INVALID"),
        streamId: reply[0] === 1 && typeof reply[4] === "string" && reply[4] ? reply[4] : null,
        maxBytes: responseNonNegativeInteger(reply[5], "Redis access audit append max bytes", "HUB_ACCESS_AUDIT_INVALID"),
      };
    },
    readAccessAuditRecords,
    purgeTerminalJob: async (token, field, expectedRevision) => {
      const checked = maintenanceInput(token);
      const checkedField = stateField(field);
      if (!checkedField.startsWith("job:")
        || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis terminal job purge input is invalid");
      }
      const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
      if (!hashTag) throw configurationError("Redis state config registryKey must contain a hash tag");
      const streamKey = `cpb:${hashTag}:job-events:${checkedField.slice("job:".length)}`;
      const reply = responseArray(await execute(config, [
        "EVAL", PURGE_TERMINAL_JOB_SCRIPT, 2, config.registryKey, streamKey,
        checked.token, checkedField, expectedRevision,
      ]), "Redis terminal job purge");
      if (reply.length !== 3 || ![0, 1].includes(Number(reply[0])) || ![0, 1].includes(Number(reply[1]))) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis terminal job purge returned an invalid response");
      }
      return {
        purged: reply[0] === 1,
        terminal: reply[1] === 1,
        revision: responseNonNegativeInteger(reply[2], "Redis terminal job purge revision", "HUB_STATE_RECORD_INVALID"),
      };
    },
    deleteExpiredTombstone: async (token, field, expectedRevision, cutoffMs) => {
      const checked = maintenanceInput(token);
      const checkedField = stateField(field);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1
        || !Number.isSafeInteger(cutoffMs) || cutoffMs < 0) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis tombstone deletion input is invalid");
      }
      const reply = responseArray(await execute(config, [
        "EVAL", DELETE_EXPIRED_TOMBSTONE_SCRIPT, 1, config.registryKey,
        checked.token, checkedField, expectedRevision, cutoffMs,
      ]), "Redis tombstone deletion");
      if (reply.length !== 3 || ![0, 1].includes(Number(reply[0])) || ![0, 1].includes(Number(reply[1]))) {
        throw codedError("HUB_STATE_RECORD_INVALID", "Redis tombstone deletion returned an invalid response");
      }
      return {
        deleted: reply[0] === 1,
        eligible: reply[1] === 1,
        revision: responseNonNegativeInteger(reply[2], "Redis tombstone deletion revision", "HUB_STATE_RECORD_INVALID"),
      };
    },
    scanStateRecords: async (prefix, includeDeleted = false) => {
      const checkedPrefix = stateField(prefix, "state field prefix");
      const records = new Map<string, RedisStateRecord>();
      let cursor = "0";
      let scannedRecords = 0;
      let scannedBytes = 0;
      let pages = 0;
      const startedAt = Date.now();
      do {
        pages += 1;
        if (pages > MAX_SCAN_PAGES || Date.now() - startedAt > MAX_SCAN_MS) {
          throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis state record scan exceeded its work bound");
        }
        const reply = responseArray(await execute(config, [
          "HSCAN", config.registryKey, cursor, "MATCH", `${checkedPrefix}*`, "COUNT", STATE_SCAN_COUNT,
        ]), "Redis state record scan");
        if (reply.length !== 2 || typeof reply[0] !== "string") {
          throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record scan returned an invalid cursor");
        }
        const fields = responseArray(reply[1], "Redis state record scan fields");
        if (fields.length % 2 !== 0) {
          throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record scan returned an invalid field list");
        }
        for (let index = 0; index < fields.length; index += 2) {
          const field = fields[index];
          const rawRecord = fields[index + 1];
          if (typeof field !== "string" || !field.startsWith(checkedPrefix)) {
            throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record scan returned an invalid field");
          }
          scannedRecords += 1;
          scannedBytes += Buffer.byteLength(field, "utf8")
            + (typeof rawRecord === "string" ? Buffer.byteLength(rawRecord, "utf8") : 0);
          if (scannedRecords > MAX_SCAN_RECORDS || scannedBytes > MAX_SCAN_BYTES) {
            throw codedError("HUB_STATE_RECORD_TOO_LARGE", "Redis state record scan exceeded its size bound");
          }
          const record = parseStateRecord(rawRecord, `Redis state record ${field}`);
          if (record.data !== null || includeDeleted) records.set(field, record);
        }
        cursor = reply[0];
        if (!/^\d+$/.test(cursor)) {
          throw codedError("HUB_STATE_RECORD_INVALID", "Redis state record scan cursor is invalid");
        }
      } while (cursor !== "0");
      return [...records.entries()].map(([field, record]) => ({ field, record }));
    },
    acquireMaintenance: async (token, operation, ttlMs) => {
      const checked = maintenanceInput(token, operation);
      const reply = responseArray(await execute(config, [
        "EVAL", MAINTENANCE_ACQUIRE_SCRIPT, 1, config.registryKey,
        checked.token, checked.operation as string, maintenanceTtl(ttlMs),
      ]), "Redis maintenance acquire");
      if (reply.length !== 3 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance acquire returned an invalid response");
      }
      return {
        acquired: reply[0] === 1,
        serverTime: maintenanceIso(reply[1], "Redis maintenance acquire server time") as string,
        expiresAt: maintenanceIso(reply[2], "Redis maintenance acquire expiry") as string,
      };
    },
    renewMaintenance: async (token, ttlMs) => {
      const checked = maintenanceInput(token);
      const reply = responseArray(await execute(config, [
        "EVAL", MAINTENANCE_RENEW_SCRIPT, 1, config.registryKey,
        checked.token, maintenanceTtl(ttlMs),
      ]), "Redis maintenance renew");
      if (reply.length !== 3 || (reply[0] !== 0 && reply[0] !== 1)) {
        throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance renew returned an invalid response");
      }
      return {
        acquired: reply[0] === 1,
        serverTime: maintenanceIso(reply[1], "Redis maintenance renew server time") as string,
        expiresAt: maintenanceIso(reply[2], "Redis maintenance renew expiry") as string,
      };
    },
    releaseMaintenance: async (token) => {
      const checked = maintenanceInput(token);
      const reply = await execute(config, ["EVAL", MAINTENANCE_RELEASE_SCRIPT, 1, config.registryKey, checked.token]);
      if (reply !== 0 && reply !== 1) throw codedError("HUB_MAINTENANCE_INVALID", "Redis maintenance release returned an invalid response");
      return reply === 1;
    },
    readMaintenance,
    exportSnapshot,
    restoreSnapshot,
    serverTimeMs: async () => {
      const reply = responseArray(await execute(config, ["TIME"]), "Redis server time");
      if (reply.length !== 2 || typeof reply[0] !== "string" || typeof reply[1] !== "string") {
        throw codedError("HUB_STATE_BACKEND_UNAVAILABLE", "Redis TIME returned an invalid response");
      }
      const seconds = responseNonNegativeInteger(reply[0], "Redis server time seconds", "HUB_STATE_BACKEND_UNAVAILABLE");
      const micros = responseNonNegativeInteger(reply[1], "Redis server time microseconds", "HUB_STATE_BACKEND_UNAVAILABLE");
      if (micros >= 1_000_000 || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) {
        throw codedError("HUB_STATE_BACKEND_UNAVAILABLE", "Redis TIME is out of range");
      }
      return seconds * 1_000 + Math.floor(micros / 1_000);
    },
    preflight: async () => {
      const ping = await execute(config, ["PING"]);
      if (ping !== "PONG") throw unavailableError();
      const role = responseArray(await execute(config, ["ROLE"]), "Redis primary-role preflight");
      if (role[0] !== "master") {
        throw codedError("HUB_STATE_BACKEND_NOT_PRIMARY", "Redis stable endpoint is not connected to a writable primary");
      }
      const fields = responseArray(
        await execute(config, ["HMGET", config.registryKey, "revision", "data"]),
        "Redis registry preflight read",
      );
      if (fields.length !== 2 || (fields[0] === null) !== (fields[1] === null)) {
        throw codedError("HUB_REGISTRY_INVALID", "Redis registry fields are inconsistent");
      }
      const hashTag = config.registryKey.match(/\{[^{}]+\}/)?.[0];
      if (!hashTag) throw configurationError("Redis state config registryKey must contain a hash tag");
      const permissions = await execute(config, [
        "EVAL", REGISTRY_PREFLIGHT_SCRIPT, 3, config.registryKey,
        `cpb:${hashTag}:job-events:preflight`, `cpb:${hashTag}:access-audit`,
      ]);
      if (permissions !== 1) throw unavailableError();
      await Promise.all([readRegistry(), readQueue(), readLeader()]);
    },
  };
}

export async function openPinnedHubRedisStateBackend(options: {
  configFile?: unknown;
  hubRoot: string;
}): Promise<HubRedisStateBackend | null> {
  const canonicalHubRoot = await canonicalizeProspectivePath(options.hubRoot);
  const rememberedConfigFile = backendConfigFileByHubRoot.get(canonicalHubRoot);
  const backend = await openHubRedisStateBackend({
    ...options,
    configFile: options.configFile ?? rememberedConfigFile,
    hubRoot: canonicalHubRoot,
  });
  const identity = backend ? `redis:${backend.identityFingerprint}` : "local-file";
  const pinned = backendIdentityByHubRoot.get(canonicalHubRoot);
  if (pinned === undefined) {
    backendIdentityByHubRoot.set(canonicalHubRoot, identity);
    if (backend) backendConfigFileByHubRoot.set(canonicalHubRoot, backend.sourceFile);
  } else if (pinned !== identity) {
    throw configurationError(
      "state backend identity changed while this process is running; stop every control-plane process before changing Redis endpoint, database, registryKey, or backend mode",
    );
  }
  return backend;
}

/** Trusted control-plane handoff for a child that must open the pinned backend. */
export async function pinnedHubRedisConfigFile(hubRoot: string) {
  const canonicalHubRoot = await canonicalizeProspectivePath(hubRoot);
  return backendConfigFileByHubRoot.get(canonicalHubRoot) || null;
}
