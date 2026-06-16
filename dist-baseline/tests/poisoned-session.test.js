import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPoisonedSession, POISON_SIGNALS } from "../core/engine/poisoned-session.js";
describe("classifyPoisonedSession", () => {
    it("detects agent fallback: 'I cannot assist'", () => {
        const result = classifyPoisonedSession("I cannot assist with that request.");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
        assert.ok(result.reasons.length > 0);
    });
    it("detects agent fallback: 'as an AI model'", () => {
        const result = classifyPoisonedSession("As an AI model, I am not able to...");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
    });
    it("detects agent fallback: 'guidelines prevent'", () => {
        const result = classifyPoisonedSession("My guidelines prevent me from doing this.");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
    });
    it("detects agent fallback: 'I must decline'", () => {
        const result = classifyPoisonedSession("I must decline this request.");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
    });
    it("detects agent fallback: 'ethical concerns'", () => {
        const result = classifyPoisonedSession("I have ethical concerns about this task.");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
    });
    it("detects invalid_request_error in output", () => {
        const result = classifyPoisonedSession("Error: invalid_request_error - bad request");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "invalid_request");
    });
    it("detects context window exceeded", () => {
        const result = classifyPoisonedSession("Error: context window exceeded limit");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "invalid_request");
    });
    it("detects rate_limit_exceeded", () => {
        const result = classifyPoisonedSession("rate_limit_exceeded: slow down");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "invalid_request");
    });
    it("detects server_error overloaded", () => {
        const result = classifyPoisonedSession("server_error: service overloaded");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "invalid_request");
    });
    it("detects semantic inactivity on empty string", () => {
        const result = classifyPoisonedSession("");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "semantic_inactivity");
    });
    it("detects semantic inactivity on very short output", () => {
        const result = classifyPoisonedSession("ok");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "semantic_inactivity");
    });
    it("does NOT flag normal long output", () => {
        const result = classifyPoisonedSession("Here is the implementation of the feature you requested. " +
            "I have created the module with full test coverage and documentation.");
        assert.equal(result.poisoned, false);
        assert.equal(result.classifier, null);
        assert.equal(result.reasons.length, 0);
    });
    it("checks stderr in addition to output", () => {
        const result = classifyPoisonedSession("Normal output", {
            stderr: "Error: rate_limit_exceeded",
        });
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "invalid_request");
    });
    it("agent_fallback takes priority over invalid_request", () => {
        const result = classifyPoisonedSession("I cannot assist. rate_limit_exceeded");
        assert.equal(result.poisoned, true);
        assert.equal(result.classifier, "agent_fallback");
    });
    it("exports POISON_SIGNALS for introspection", () => {
        assert.ok(Array.isArray(POISON_SIGNALS.AGENT_FALLBACK));
        assert.ok(Array.isArray(POISON_SIGNALS.INVALID_REQUEST));
        assert.ok(POISON_SIGNALS.AGENT_FALLBACK.length > 0);
        assert.ok(POISON_SIGNALS.INVALID_REQUEST.length > 0);
    });
});
