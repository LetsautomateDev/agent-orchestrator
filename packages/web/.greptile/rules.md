# Web Review Guidance

The dashboard is a stateful view over orchestrator internals. Review comments should focus on API correctness and leaked complexity at the UI boundary.

## Focus areas

- API routes must validate external input before passing values to core services or plugins.
- Serialization changes should remain consistent between server routes, client rendering, and tests.
- Event streams and subscriptions should clean up listeners and intervals when the client disconnects.
- Avoid comments that nitpick visual details unless the change introduces an actual usability regression or inconsistent state handling.

## Known low-signal area

- `src/lib/mock-data.ts` is temporary scaffolding and should not drive review noise.
