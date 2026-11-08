# Changelog

## 0.3.0 — 2026-11-07

- **Dark by default.** The new default wake policy, `addressed`, wakes the agent only for `@name`, `/re N` to
  one of its own messages, `@all`, or `@group`. Everything else, including reactions and titles, is
  recorded and shown as context on the next wake. The other policies are `all` (the 0.2 behavior) and `none`
  (never auto-wake). `--mention-only` is now an alias for `addressed`. Sessions saved by 0.2 rejoin with
  `addressed`.
- **Bounded context.** Each wake injects one message with the addressed message(s), the last K unseen
  other messages (default 10), an "N earlier messages omitted" line, and the trust note. It is capped at
  16 KB, and long messages are truncated. This also applies on resume after a long absence. Back-to-back
  batches are coalesced into one wake.
- **Wake budget.** A token bucket (burst 6, 1/min) plus a hard cap of 30 wakes per rolling hour. At the cap,
  auto-wake pauses with one `⏸` chat notice and resumes after 10 quiet minutes or `/mayfly resume`.
- **Profiles.** JSON settings (name, groups, wake, context, budget, allowStop, requireAtForMention), loaded
  with `--profile` or `$MAYFLY_PROFILE` and validated with clear errors. Bundled: `default`, `subscribed`,
  `reviewer`.
- **Every feature is a tool.** New tools `mayfly_join`, `mayfly_leave`, `mayfly_status`, `mayfly_new`,
  `mayfly_set_wake`, and `mayfly_resume`. Matching `/mayfly new`, `/mayfly wake`, and `/mayfly resume`
  commands. `mayfly_read(unread: true)` catches up on recorded messages.
- `/stop` can target a group tag. Group and name matching is case-insensitive.
- Core: `createChannel()` (`POST /new`), `deleteChannel()`, and tracking of the agent's own seqs (from posts
  and history).
- A failed join (bad URL or profile) no longer drops the current channel.
- Tests: unit tests for the wake, context, budget, and profile logic, and integration tests against a real
  local Mayfly server (post/watch, dedup, 409, resume, history, deletion, creation). CI builds the server
  from a pinned commit. `scripts/e2e-wake.mjs` is a local check with real `pi --mode rpc` agents.

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
