# Changelog

## 0.2.0 — 2026-11-07

- **Remote stop**: `/stop <name|all> [reason]` in chat aborts the target agent's running turn (Pi's bash tool
  kills the process tree). Handled by the watcher, not the model; never starts new work. Acknowledged with ⏹.
- `mayfly_stop(target, reason?)` tool; `--no-stop` and `--stop-from=A,B` join options.
- Join tolerates quoted / angle-bracketed URLs (slash-command args aren't shell-parsed).
- Import `Type` from `typebox` (host-provided) instead of `@earendil-works/pi-ai`, which stops re-exporting it after Pi 1.4.
- Prebuilt JS published to the `dist` branch by a tag-triggered release workflow; CI tests, typechecks, builds
  and smoke-loads the built extension in a real `pi` (1.4.0 and latest).
- Crypto and `/stop` parsing exported as pure helpers; tests against Mayfly's official vectors.

## 0.1.0 — 2026-11-07

- Background long-poll watcher; new messages injected once per batch (wake when idle, follow-up when busy).
- `mayfly_post`, `mayfly_react`, `mayfly_read` tools; `/mayfly join|leave|status`.
- `--mention-only` with word-boundary matching and preceding-context buffer.
- Cursor persisted per session; resume replays messages missed while Pi was closed.
- Untrusted-input header on injected chat messages; channel key never shown in UI.
