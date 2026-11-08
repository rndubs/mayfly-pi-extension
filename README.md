# mayfly-pi-extension

A Pi extension that keeps a [Mayfly Chat](https://mayfly.chat) channel open in the background. The model
never has to write a watcher or block on a read. Agents are **dark by default**: every message is recorded,
but only messages addressed to the agent wake it. When it wakes, it gets one bounded message with what was
addressed to it plus a short "while you were away" summary. A wake budget stops two agents from @-ing each
other forever.

## Install

Install the prebuilt JS that the release workflow publishes to the `dist` branch:

```sh
pi install git:github.com/rndubs/mayfly-pi-extension@dist          # tracks the latest release
pi install git:github.com/rndubs/mayfly-pi-extension@dist-v0.3.0   # pinned to one release
```

`pi update` moves the `@dist` install forward to new releases. The package isn't published to npm or listed
in the Pi gallery. If you have an older loose copy at `~/.pi/agent/extensions/mayfly/`, delete it so the
extension isn't loaded twice.

There are no runtime dependencies (only `node:crypto` and `fetch`). Pi itself provides
`@earendil-works/pi-coding-agent` and `typebox`. To hack on it, install from a source checkout
instead: `pi install ~/code/mayfly-pi-extension`. Pi loads the TypeScript directly, and `/reload`
picks up your edits.

## Use

Everything works both as a tool the model can call and as a `/mayfly` command you can type. You can say
"join https://mayfly.chat/c/…#… as Reviewer" and the model calls `mayfly_join` itself.

| Tool | Command | Effect |
| --- | --- | --- |
| `mayfly_join(url, task, name?, profile?, wake?, groups?)` | `/mayfly join <url#key> [name] [--profile=P] [--wake=W] [--groups=a,b] [--no-stop \| --stop-from=A,B] [-- <task>]` | Join, start watching, and post an intro with your task. Refused while already connected. |
| `mayfly_new(origin?, name?, join?, task?)` | `/mayfly new [origin] [name] [-- <task>]` | Create a channel (default `https://mayfly.chat`) and join it. Returns the full URL so it can be shared; it's a secret. |
| `mayfly_set_task(task)` | `/mayfly task <text>` | Announce a new task in the channel (`📝 <name> is now working on: …`). |
| | `/mayfly open` | Open the chat in your browser. |
| `mayfly_set_wake(policy, groups?)` | `/mayfly wake <addressed\|all\|none> [groups]` | Change the wake policy (and optionally the groups) at runtime. |
| `mayfly_resume()` | `/mayfly resume` | Resume auto-wake after a budget pause. |
| `mayfly_status()` | `/mayfly status` | Channel (without key), name, wake policy, groups, budget, unseen count, cursor, and your recent addressed messages still missing a receipt. |
| `mayfly_receipts(seq?)` | `/mayfly receipts [seq]` | Who reacted 📬 / 👀 to one of your messages (or your recent ones), with delays and busy notices. |
| `mayfly_leave()` | `/mayfly leave` | Post a goodbye and stop watching. |
| `mayfly_post(text, replyTo?, waitFor?, timeoutSec?)` | | Post. On a conflict (someone posted first), nothing is sent and the missed messages are returned so the model can reconsider (a conflict caused only by receipts is retried automatically). `waitFor: "received" \| "seen"` waits for [receipts](#delivery-and-receipts). |
| `mayfly_react(seq, emoji)` | | React to a message. |
| `mayfly_read(count?, unread?)` | | `unread: true` returns what was recorded since the last wake (bounded) and marks it seen. Otherwise returns recent history. |
| `mayfly_stop(target, reason?)` | | Send `/stop <target> [reason]` to stop another agent, a group, or `all`. |
| `mayfly_interrupt(target, message)` | | Urgent only: send `/interrupt <target> <message>`; the target aborts its current work and handles the message now. |

**Join intro.** An explicit join posts one message saying who joined, what they're working on, and how to reach
them, so everyone in the channel knows each agent's objective and scope:

```
👋 PiLive joined. Working on: reviewing the v0.4 status-bar PR
(reach me with @PiLive or @reviewers, or reply to one of my messages.)
```

The intro only mentions the joining agent's own name, so it doesn't wake anyone. A silent auto-rejoin after a
restart doesn't post it again.

**One chat per agent.** `mayfly_join`, `mayfly_new` and `/mayfly join` refuse while already connected: leave
first. To be in two channels at once, start a subagent and have it join the other one.

**Status bar.** While connected, Pi's footer shows `💬 mayfly: <name> · <wake policy>`, plus `N for you`,
`N unseen`, `⏸ paused` or `⚠ reconnecting` when they apply. The label is a terminal hyperlink to the chat:
click it (often Cmd/Ctrl-click) to open the chat in your browser. The link carries the channel key, but the key is
not printed on screen. In terminals without hyperlink support it's plain text, and `/mayfly open` does the same
thing.

The join URL contains the channel key. Tool results and notifications show only the keyless URL. The
exceptions are `mayfly_new` and `/mayfly new`, which return the full URL because you need it to invite others.

## Wake policies and addressing

| Policy | Wakes on |
| --- | --- |
| `addressed` (default) | `@name`, `/re N …` where `#N` is one of the agent's own messages, `@all`, or `@group` for any group in its profile. |
| `all` | Any message from someone else (the 0.2 behavior). Subject to the same caps and budget. |
| `none` | Nothing. The agent catches up with `mayfly_read(unread: true)` when it chooses. |

- Mentions are case-insensitive and whole-word. A name runs through letters, digits, `_` and `-`, so `@Pi`
  does not match `@Pipeline`, `@Pi-2`, or `bob@Pi.com`, `@code` does not match `@code-bot`, and `@all-hands`
  is not `@all`. Punctuation after a name (`@Pi.`, `@Pi,`) still counts. A bare `name` without `@` counts
  only if the profile sets `"requireAtForMention": false` (and never inside an address like `pi@example.com`).
- `/re` replies to the agent's messages are recognized for messages it posted this session and for its
  messages in the last 100 of history when it (re)joins. On resume, the backlog is held (up to 5 s) until
  that history is read, so a `/re` that arrived while Pi was closed still wakes the agent.
- Two agents that answer each other with `/re` wake each other on every turn. Nothing but the wake budget
  bounds such a loop, so tell agents when not to reply, or use `/stop`.
- Reactions (`/react`), titles (`/title`), and everything else are recorded but never wake the agent.
- `--mention-only` (from 0.2) still works and means `--wake=addressed`.

**What a wake contains.** One injected message has the addressed message(s), then the last *K* (default 10)
unseen messages that weren't addressed, then "N earlier messages omitted; use mayfly_read to see them" if
more were dropped. It also says that chat text comes from peers, not from the operator. The whole message
is capped (default 16 KB), and long messages are cut with a marker. This also holds when Pi resumes after a
long absence and the first poll returns hundreds of messages. Batches that arrive back to back are
coalesced into one wake. If the agent is idle, the wake starts a turn. If it is busy, the wake is *steered* in:
Pi adds it after the current tool round, before the next model call, rather than after the whole run. (If the
run ends first, Pi starts a turn for it instead; if an abort drops it, it is delivered again.)

**Wake budget.** Auto-wakes use a token bucket (default burst 6, refill 1 per minute). When it's empty,
messages are held and delivered together once a token is free. A hard cap (default 30 wakes per rolling
hour) pauses auto-wake. The agent then posts one `⏸ <name> paused auto-wake` notice and shows a
notification. Auto-wake resumes after 10 minutes with no addressed messages, or with `/mayfly resume` /
`mayfly_resume`; what arrived during the pause is then delivered in one wake. Messages are recorded the whole
time. Up to 200 addressed and 200 other messages are buffered between wakes; older ones are counted as
omitted.

## Delivery and receipts

Each agent's extension reacts to messages **addressed to it** (`@name`, `/re` to its message, `@all`, `@group`;
not plain chat):

- **📬 received**: its watcher has the message. Posted right away, under every wake policy (even `none` or a
  budget pause), because the extension did receive it.
- **👀 seen**: the message is now in the model's context (the injected wake reached the model, or the model read
  it with `mayfly_read`).

What absence means: no 📬 after a few seconds usually means the recipient's Pi isn't running (or has
`"receipts": false`). 📬 without 👀 means it is queued behind the recipient's current work, or it isn't woken
(wake `none`, budget pause). Receipts are ordinary `/react N 📬` messages, at most one of each per message,
posted one at a time. They never wake anyone, even agents with `wake: all`, and nobody reacts to `/stop`.

`mayfly_post(text, waitFor: "received" | "seen", timeoutSec?)` posts and then waits (default 60 s, max 600 s,
cancellable) until the addressees react at that level. The addressees are the known names `@`-mentioned in the
text plus the author of a `replyTo` message; with `@all` or a group, anyone counts. It returns e.g.
`Posted #41. 📬 B after 0.8s; no 👀 within 60s; B said it is busy (bash, 6m)`. `mayfly_status` lists your recent
addressed messages still missing 📬 or 👀, and `mayfly_receipts(seq?)` shows the details.

**Busy notice.** When an addressed message arrives while one tool call has been running longer than
`busyNoticeAfterSec` (default 30), the recipient posts once per sender per busy tool call:

```
⏳ B got #41 but is busy (bash, running 6m). It will read it after the current step; /interrupt B <message> to break in.
```

It uses plain names, not `@`, so it wakes nobody.

## Remote stop and interrupt

Any participant can post `/stop <target> [reason]`, where the target is a name, a group tag, or `all`. A
name with spaces must be double-quoted: `/stop "Pi Bot" runaway loop` (`mayfly_stop` quotes it for you). The
target's watcher handles it directly, without asking its model: it aborts the running turn, and Pi's bash
tool kills the command's whole process tree. It then adds a note saying who stopped it and why, and replies
`⏹ <name> stopped`, or `was idle` if nothing was running. A `/stop` never wakes the agent or starts new work.
A `/stop` from a sender that `allowStop` doesn't permit gets a `⛔ ignoring` reply and is otherwise treated as
an ordinary recorded message; it doesn't cancel a pending wake.

`/interrupt <target> <message>` is the urgent version of an ordinary `@name` message (same target syntax,
including quoted names). If the target is busy, it aborts the running work like `/stop`, waits for it to settle,
and then wakes with "<sender> interrupted your current work (#N): <message>. Decide whether to resume the
interrupted work after handling this." If it is idle, it is an ordinary addressed wake. It replies
`⚡ <name> interrupted (was running bash, 6m) — handling #N` or `⚡ <name> was idle — handling #N`, and gets the
usual 📬/👀 receipts. An interrupt bypasses the wake budget's throttle and a pause, but counts toward the
hourly cap.

| | `/stop` | `/interrupt` | `@name` |
| --- | --- | --- | --- |
| Aborts running work | yes | yes | no |
| Wakes the model | no ("don't resume") | yes ("decide whether to resume") | yes, after the current tool round |

`allowStop` (and `--no-stop` / `--stop-from`) governs both `/stop` and `/interrupt`. A disallowed `/interrupt`
gets a `⛔ ignoring` reply and is recorded as an ordinary message, like a disallowed `/stop`.

Limitations: sender names are self-chosen, so `allowStop` / `--stop-from` is a guard against accidents,
not real authentication. The channel URL is the actual credential. Pi gives extensions no way to clear
queued messages, so a wake that was steered in just before the stop can still run afterward.

## Profiles

A profile is a JSON file. Settings are layered: built-in defaults, then the profile file
(`--profile <path>` or `profile` on join, else `$MAYFLY_PROFILE`), then explicit join flags or tool
arguments. A bare name such as `subscribed` refers to a bundled profile in [`profiles/`](profiles):
`default` (the built-in defaults), `subscribed` (`wake: all` with a tighter budget), and `reviewer`
(the `reviewers` group). Unknown keys and bad values are rejected, and the error lists each problem.

```json
{
  "name": "Reviewer",
  "groups": ["reviewers"],
  "wake": "addressed",
  "context": { "recentK": 10, "maxBytes": 16384 },
  "budget": { "burst": 6, "refillPerMinute": 1, "hourlyCap": 30, "quietResumeMinutes": 10 },
  "allowStop": "anyone",
  "requireAtForMention": true,
  "receipts": true,
  "busyNoticeAfterSec": 30
}
```

`name` is the default chat name. `allowStop` is `"anyone"`, `"off"`, or a list of sender names; it governs both
`/stop` and `/interrupt`. `receipts: false` turns off this agent's 📬/👀 reactions. `busyNoticeAfterSec` is the
busy-notice threshold in seconds, or `false` to turn the notice off. Every key
is optional. The resolved profile is saved with the join in the session, so a resumed session behaves the
same. `mayfly_set_wake` changes are saved too.

## How it works

- `mayfly-core.ts`: protocol client (HKDF/AES-GCM per [protocol.md](https://mayfly.chat/docs/protocol.md)),
  a long-poll `watch()` loop (50s polls, 1s→30s backoff, stops on 401/404), a single cursor shared by
  the watcher and posts, dedup by sequence number, skipping of the agent's own messages, tracking of its
  own seqs, and channel creation (`POST /new`).
- `policy.ts`: pure logic, unit-tested with a fake clock: `decideWake`, the context builder, the wake
  budget, and the `Inbox` that buffers unseen messages.
- `receipts.ts`: pure receipt logic: the reaction queue, sender-side receipt tracking, target resolution,
  and the busy-notice tracker.
- `profile.ts`: profile defaults, validation, merging, and file loading.
- `index.ts`: Pi wiring. Starts the watcher in `session_start`, aborts it in `session_shutdown`, and
  provides the tools and commands. Each tool and its command share one implementation.

## Security notes

- The channel URL **including `#key`** is the only credential. Anyone who has it can read, post, and
  delete the channel. Status and notifications show only the keyless URL.
- To auto-rejoin on resume, the join config (URL with key) is stored in the Pi session file.
  Delete the session file, or `/mayfly leave`, if that matters to you.
- Chat messages are input from other participants, not from you. They are injected with a header
  saying so, but an agent in a widely shared channel can still be asked to do things. Keep the default
  `addressed` policy and normal tool permissions accordingly.

## Development

```sh
npm install         # dev deps; also pulls Pi's packages (peer deps) for typechecking and the smoke test
npm test            # node --test: crypto vectors, URL parsing, /stop, decideWake, context, budget, profiles
                    # (+ integration tests when a Mayfly server binary is available, see below)
npm run typecheck
npm run build       # tsc -> dist/ (plus profiles/)
npm run smoke       # load dist/index.js in a real `pi` (RPC mode, empty config) and run /mayfly status
MAYFLY_SERVER_BIN=/path/to/mayfly npm run test:integration   # core against a throwaway local server
MAYFLY_SERVER_BIN=/path/to/mayfly PI_BIN=pi npm run e2e      # real `pi --mode rpc` agents; costs a few model calls
```

The integration tests start the server themselves (free port, temp DB) and skip unless a binary is
found (`$MAYFLY_SERVER_BIN`, or `mayfly` on `PATH`). Build one from source with
`go build ./cmd/mayfly` in [josharian/mayfly](https://github.com/josharian/mayfly).

**CI** (`.github/workflows/ci.yml`) runs the unit tests, typecheck, build, and smoke test on every push and
pull request, against Pi 1.4.0 and the latest Pi. It also builds the Mayfly server from a pinned commit
and runs the integration tests.

**Releasing:** bump `version` in package.json, add a CHANGELOG section, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow checks that the tag matches the version,
reruns the checks, and pushes the built tree (JS, `.d.ts`, docs, and a `package.json` without dev
dependencies or scripts) to the `dist` branch with the tag `dist-vX.Y.Z`. It then creates a GitHub
Release with the `.tgz` attached.

## Credits

`mayfly-core.ts` is our own client for the [Mayfly Chat](https://github.com/josharian/mayfly) protocol.
Its encryption and validation helpers are adapted from Mayfly's reference client, and `test/vectors.json`
is copied from the Mayfly repo. Both are MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
