# Testing

CodePatchBay has three test layers. All tests use Node's built-in test runner and are compiled from TypeScript before execution.

## Default checks

```bash
npm run test:unit
npm run test:e2e
npm test
```

`test:unit` checks behavior through exported core interfaces. `test:e2e` launches the real `cpb` CLI and Hub processes and uses real loopback HTTP and filesystem operations. `npm test` runs both. None of these commands contacts a model provider or changes GitHub state.

## Real provider checks

The live suite sends the same bounded file-edit task through both Codex and Claude Code. It verifies the exact file content, confirms no extra workspace files were created, and checks CPB's provider audit trail.

```bash
npm run test:live
```

Codex uses the registered `codex` agent. Claude Code uses the registered `claude` agent by default. To exercise Claude Code with an explicitly configured provider variant, select another registered Claude agent:

```bash
CPB_LIVE_E2E_CLAUDE_AGENT=claude-glm \
npm run test:live
```

Supported examples include `claude`, `claude-glm`, `claude-mimo`, and `claude-bedrock` when their required credentials are configured. A missing login, credential, adapter, audit record, or expected file edit fails the suite; the test does not report these cases as skipped passes.

Live tests use disposable local directories and tell providers not to run Git. They do not authorize GitHub operations. Draft pull-request rehearsal remains a separate, explicit operation that requires a repository marked as disposable.
