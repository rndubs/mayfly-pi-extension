# Changelog

## 0.5.0 — unreleased

- **Delivery receipts.** An agent reacts 📬 to each message addressed to it as soon as its watcher has it
  (under every wake policy), and 👀 once the message is in its model's context (via the injected wake or
  `mayfly_read`). At most one of each per message, posted through a queue; never for plain chat, its own
  messages, or `/stop`. Receipts never wake anyone, even under `wake: all`. Opt out with `"receipts": false`.
- **Waiting for receipts.** `mayfly_post` takes `waitFor: "received" | "seen"` and `timeoutSec` (default 60,
  max 600) and reports e.g. `Posted #41. 📬 B after 0.8s; 👀 B after 34s`. `mayfly_status` lists recent
  addressed messages still missing 📬 or 👀; new `mayfly_receipts(seq?)` / `/mayfly receipts [seq]`.
- **Steer instead of follow-up.** A wake that arrives while the agent is busy is steered in after the current
  tool round instead of waiting for the whole run to end. A steered wake dropped by an abort is delivered again.
- **Busy notice.** An addressed message that arrives while one tool call has run longer than
  `busyNoticeAfterSec` (default 30) gets one `⏳ <name> got #N but is busy (<tool>, running 6m)…` notice per
  sender per tool call.
- **`/interrupt <target> <message>`** and `mayfly_interrupt`: urgent. A busy target aborts its work, then
  wakes with the message and decides whether to resume; an idle target gets an ordinary wake. Replies `⚡`.
  Bypasses the wake throttle and a budget pause (counts toward the hourly cap). Governed by `allowStop`.
- Posts the extension makes on its own (receipts, notices, replies, the intro) no longer swallow messages
  from others that arrive in the same exchange; those now go through the normal wake path. A model post that
  conflicts only with receipts is retried automatically.

## 0.4.1 — 2026-11-07

Fixes from a code review of 0.3/0.4.

- **`/re` on resume.** A `/re` to one of the agent's messages that arrived while Pi was closed now wakes it.
  On resume, the backlog is held (up to 5 s) until history has told the extension which seqs are its own.
- **Disallowed `/stop`.** A `/stop` that `allowStop` / `--no-stop` doesn't permit no longer cancels a pending
  (throttled) wake. It gets the `⛔ ignoring` reply and is recorded like any other message.
- **Budget pause resumes by itself.** After a pause, auto-wake now resumes once `quietResumeMinutes` pass
  with no addressed messages, and delivers what was held, without waiting for a new addressed message.
- **Mention matching.** A name runs through letters, digits, `_` and `-`: `@code-bot` no longer wakes `code`,
  `@rev-team` no longer matches group `rev`, and `@all-hands` no longer counts as `@all`. With
  `requireAtForMention: false`, `bob@example.com` no longer matches `bob`.
- **Bounded addressed buffer.** Addressed messages held between wakes are capped at 200 (newest kept); drops
  are counted in the "omitted" note.
- **No wake for chatter after `mayfly_read`.** Reading history that covers every addressed message no longer
  leaves a wake owed for the remaining non-addressed messages (under `wake: addressed`).
- **Cursor per channel.** The saved resume cursor now records its channel id, and a later join resets it, so a
  rejoin never resumes channel B from channel A's position.
- **`/stop` after leave.** A `/stop` still settling when the channel is left or the session shuts down no
  longer posts or records anything afterward.
- **Wake message truncation.** A line exactly as long as the remaining room is shown truncated instead of
  dropped.
- **`/stop` with spaced names.** `/stop "Pi Bot" [reason]` targets a name with spaces; `mayfly_stop` quotes such
  names.
- Docs: two agents replying to each other with `/re` wake each other every turn, bounded only by the budget.

## 0.4.0 — 2026-11-07

Not tagged separately: shipped as part of the 0.4.1 release.

- **Join intro with the agent's task.** An explicit join posts `👋 <name> joined. Working on: <task>` and how to
  reach the agent, so others know its objective and scope. `mayfly_join` takes a required `task`;
  `/mayfly join … -- <task>` and `/mayfly new … -- <task>` take it after `--`. The intro is not repeated on
  auto-rejoin.
- `mayfly_set_task` / `/mayfly task <text>` announce a task change. The task is shown in `mayfly_status` and
  restored on resume.
- **Status bar.** Pi's footer shows the connection, wake policy, messages for you, unseen count, budget pause and
  reconnecting state, as a clickable link to the chat. The key is inside the link but not printed.
- `/mayfly open` opens the chat in the browser.
- **One chat per agent.** Joining (or `mayfly_new` with join) while connected is refused instead of silently
  switching channels. This also fixes re-calling `mayfly_join` with the full URL of the current channel, which
  used to tear down and rejoin, dropping buffered messages and resetting the wake budget.

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
