import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { enforceChannelPolicy, readChannelPolicyEvents } from "../server/services/channel/channel-commands.js";
import { dispatchSession } from "../server/services/review/review-dispatch.js";
import { createSession, getSession, updateSession } from "../server/services/review/review-session.js";
import { registerProject } from "../server/services/hub/hub-registry.js";
import { tempRoot } from "./helpers.js";
async function withRuntimeEnv(env, fn) {
    const previous = new Map();
    for (const key of Object.keys(env))
        previous.set(key, process.env[key]);
    Object.assign(process.env, env);
    try {
        await fn();
    }
    finally {
        for (const [key, value] of previous) {
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
    }
}
test("channel policy audit stays in hub control root when project runtime env is polluted", async () => {
    const cpbRoot = await tempRoot("cpb-channel-source");
    const hubRoot = await tempRoot("cpb-channel-hub");
    const projectRuntimeRoot = await tempRoot("cpb-channel-project-runtime");
    await withRuntimeEnv({
        CPB_HUB_ROOT: hubRoot,
        CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot,
    }, async () => {
        await enforceChannelPolicy(cpbRoot, { enabled: true, default: "deny" }, {
            channel: "slack",
            action: "cancel",
            project: "flow",
        });
        const events = await readChannelPolicyEvents(cpbRoot);
        assert.equal(events.length, 1);
        assert.equal(events[0].request.project, "flow");
        assert.equal(existsSync(path.join(hubRoot, "channel-policy-events.jsonl")), true);
        assert.equal(existsSync(path.join(projectRuntimeRoot, "channel-policy-events.jsonl")), false);
        assert.equal(existsSync(path.join(cpbRoot, "cpb-task")), false);
    });
});
test("review sessions stay in hub control root when project runtime env is polluted", async () => {
    const cpbRoot = await tempRoot("cpb-review-source");
    const hubRoot = await tempRoot("cpb-review-hub");
    const projectRuntimeRoot = await tempRoot("cpb-review-project-runtime");
    const sourcePath = await tempRoot("cpb-review-project-source");
    await withRuntimeEnv({
        CPB_HUB_ROOT: hubRoot,
        CPB_PROJECT_RUNTIME_ROOT: projectRuntimeRoot,
    }, async () => {
        await registerProject(hubRoot, { id: "flow", sourcePath, skipCodeGraphGate: true });
        const session = await createSession(cpbRoot, { project: "flow", intent: "review runtime root" });
        await updateSession(cpbRoot, session.sessionId, { status: "user_review" }, { hubRoot, skipTransitionCheck: true });
        const dispatched = await dispatchSession(cpbRoot, session.sessionId, { hubRoot });
        const loaded = await getSession(cpbRoot, session.sessionId);
        assert.equal(loaded?.sessionId, session.sessionId);
        assert.equal(dispatched.ok, true);
        assert.equal(loaded?.status, "dispatched");
        assert.equal(existsSync(path.join(hubRoot, "reviews", `${session.sessionId}.json`)), true);
        assert.equal(existsSync(path.join(projectRuntimeRoot, "reviews", `${session.sessionId}.json`)), false);
        assert.equal(existsSync(path.join(projectRuntimeRoot, "reviews", `.lock-dispatch-${session.sessionId}`)), false);
        assert.equal(existsSync(path.join(cpbRoot, "cpb-task")), false);
    });
});
