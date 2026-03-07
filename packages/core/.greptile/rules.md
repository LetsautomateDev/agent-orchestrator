# Core Review Guidance

`packages/core` is the behavioral center of the system. Review comments here should aggressively catch contract drift and state-machine regressions.

## Focus areas

- `src/types.ts` changes must propagate to all packages that serialize, deserialize, or display those types.
- `src/config.ts` and config-generation changes should stay aligned with `agent-orchestrator.yaml.example`, README snippets, and validation tests.
- `src/lifecycle-manager.ts` changes should preserve reaction triggering, deduplication, and escalation timing.
- `src/session-manager.ts` changes should preserve cleanup guarantees and fail-fast behavior before resources are created.

## Backwards compatibility

This project intentionally uses flat metadata files and YAML config as long-lived interfaces. Flag changes that silently alter on-disk formats, key names, or semantics without an explicit compatibility story.
