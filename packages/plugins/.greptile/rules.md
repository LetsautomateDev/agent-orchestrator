# Plugin Review Guidance

Plugins are where this repository touches the outside world. High-signal comments usually come from boundary handling, not formatting.

## Focus areas

- Command execution should use `execFile` or `spawn` with argv arrays and timeouts.
- Do not manually shell-escape with `JSON.stringify` or string concatenation.
- GitHub, Linear, Slack, tmux, iTerm2, webhook, and filesystem responses are all fallible and should be parsed defensively.
- Cleanup must be symmetrical with setup: if a plugin creates a session, temp file, symlink, listener, or subprocess, it needs a reliable teardown path.

## Contract expectations

- Manifest `name` and `slot` should match the package purpose.
- Plugin behavior should implement the relevant core interface instead of inventing parallel local contracts.
- Changes to plugin output or metadata format should be reviewed for downstream impact in CLI, web, and core services.
