# Runtime Boundary Contract

## Layers

- `core/`: pure policy and parsing helpers. It must not import `server/`, `bridges/`, `cli/`, or `runtime/`.
- `server/services/`: durable state, registries, HTTP-facing orchestration helpers, and runtime-root path ownership.
- `bridges/`: executable compatibility wrappers and phase/pipeline adapters.
- `cli/`: command routing and command-specific adapters.
- `runtime/`: long-running worker/generic-evolve orchestration and the Rust runtime adapter.

## Temporary Exceptions

- `runtime/acp-pool.js` may call `bridges/acp-client.mjs` until ACP client process launch is moved behind a neutral adapter.
- Runtime orchestration files may import selected `server/services/*` while durable state remains owned by server services.

## Direction

New pure logic goes to `core/`.
New executable compatibility surfaces go to `bridges/`.
New CLI routing goes to `cli/commands/`.
New durable state writes stay in `server/services/` until a single migration moves them behind a runtime adapter.
