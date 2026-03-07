# Agent Orchestrator Review Guidance

## What matters most

This repository is an orchestration layer for parallel AI coding agents. High-value review comments should focus on:

- session lifecycle correctness and state transitions
- workspace isolation and branch/worktree safety
- SCM, tracker, and notifier integrations behaving correctly under partial failure
- plugin contract compatibility across packages
- web/API routes safely propagating orchestrator state to the dashboard

## Security boundaries

This codebase regularly crosses trust boundaries:

- shell and subprocess execution
- tmux session management
- git and GitHub CLI usage
- AppleScript / terminal automation
- webhook and API payload handling

Prefer comments about injection risk, unsafe interpolation, missing timeouts, or assumptions about external command output over generic style feedback.

## Project-specific conventions

- `packages/core/src/types.ts` is the source of truth for shared contracts.
- Config changes should stay aligned across Zod schemas, `agent-orchestrator.yaml.example`, README/docs, and tests.
- Local runtime imports should use explicit `.js` extensions.
- Node builtins should use the `node:` prefix.
- Avoid `as unknown as T` and unguarded `JSON.parse` in production code.
- Plugins should follow the `manifest` + `create` + `satisfies PluginModule<T>` export pattern.

## Testing expectations

Missing regression coverage is review-worthy when a change touches:

- lifecycle/status transitions
- config loading or config generation
- serialization / API payload shapes
- plugin command execution or cleanup behavior
- session restore / kill / merge flows

## Low-priority areas

Treat these as intentionally lower-signal for review:

- `scripts/` legacy shell helpers
- `artifacts/` design and planning documents
- `packages/web/src/lib/mock-data.ts`
