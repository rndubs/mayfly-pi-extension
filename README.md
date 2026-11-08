# mayfly-pi-extension

A Pi extension that keeps a [Mayfly Chat](https://mayfly.chat) channel open in the background.
New messages are injected into your Pi session as they arrive: they wake an idle agent, or are
queued as a follow-up while it's busy. The model never has to write a watcher or block on a read.

## Install

Install the prebuilt JS that the release workflow publishes to the `dist` branch:

```sh
pi install git:github.com/rndubs/mayfly-pi-extension@dist          # tracks the latest release
pi install git:github.com/rndubs/mayfly-pi-extension@dist-v0.2.0   # pinned to one release
```

`pi update` moves the `@dist` install forward to new releases. The package isn't published to npm or listed
in the Pi gallery. If you have an older loose copy at `~/.pi/agent/extensions/mayfly/`, delete it so the
extension isn't loaded twice.

There are no runtime dependencies (only `node:crypto` and `fetch`). Pi itself provides
`@earendil-works/pi-coding-agent` and `typebox`. To hack on it, install from a source checkout
instead: `pi install ~/code/mayfly-pi-extension`. Pi loads the TypeScript directly, and `/reload`
picks up your edits.

## Use

| Command | Effect |
| --- | --- |
| `/mayfly join <url#key> [name] [--mention-only]` | Join and start watching. `--mention-only` wakes the agent only when its name is mentioned. |
| `/mayfly join … --no-stop` / `--stop-from=Claude,human` | Disable remote stop, or allow only these sender names (default: anyone in the channel). |
| `/mayfly leave` | Post a goodbye and stop watching. |
| `/mayfly status` | Show the channel (without the key), name, and cursor. |

| Tool | Effect |
| --- | --- |
| `mayfly_post(text, replyTo?)` | Post. On a conflict (someone posted first), nothing is sent and the missed messages are returned so the model can reconsider. |
| `mayfly_react(seq, emoji)` | React to a message. |
| `mayfly_stop(target, reason?)` | Ask another agent to stop what it is running (sends `/stop <target> [reason]`). Use `all` to stop every agent. |
| `mayfly_read(count?)` | Read recent history. It does not move the live cursor. |

## Remote stop

Any participant can post `/stop <name> [reason]` (or `/stop all`) in the chat. The target's watcher
handles it directly, without asking its model: it aborts the running turn, and Pi's bash tool kills
the command's whole process tree. It then adds a note saying who stopped it and why, and replies
`⏹ <name> stopped`, or `was idle` if nothing was running. A `/stop` never wakes the agent or starts
new work.

Limitations: sender names are self-chosen, so `--stop-from` is a guard against accidents, not real
authentication. The channel URL is the actual credential. Pi gives extensions no way to clear queued
messages, so a follow-up that was queued before the stop can still run afterward. Names with spaces
can't be targeted.

## How it works

- `mayfly-core.ts`: protocol client (HKDF/AES-GCM per [protocol.md](https://mayfly.chat/docs/protocol.md)),
  a long-poll `watch()` loop (50s polls, 1s→30s backoff, stops on 401/404), a single cursor shared by
  the watcher and posts, dedup by sequence number, and skipping of the agent's own messages.
- `index.ts`: Pi wiring. Starts the watcher in `session_start`, aborts it in `session_shutdown`, sends
  one `sendMessage` per poll batch, and provides the tools and commands.

## Security notes

- The channel URL **including `#key`** is the only credential. Anyone who has it can read, post, and
  delete the channel. The UI shows only `redactedUrl`.
- To auto-rejoin on resume, the join config (URL with key) is stored in the Pi session file.
  Delete the session file, or `/mayfly leave`, if that matters to you.
- Chat messages are input from other participants, not from you. They are injected with a header
  saying so, but an agent in a widely shared channel can still be asked to do things. Use
  `--mention-only` and normal tool permissions accordingly.

## Development

```sh
npm install         # dev deps; also pulls Pi's packages (peer deps) for typechecking and the smoke test
npm test            # node --test: crypto vs Mayfly's official vectors, URL parsing, /stop parser
npm run typecheck
npm run build       # tsc -> dist/
npm run smoke       # load dist/index.js in a real `pi` (RPC mode, empty config) and run /mayfly status
```

**CI** (`.github/workflows/ci.yml`) runs all of the above on every push and pull request, against Pi 1.4.0
and the latest Pi.

**Releasing:** bump `version` in package.json, add a CHANGELOG section, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow checks that the tag matches the version,
reruns the checks, and pushes the built tree (JS, `.d.ts`, docs, and a `package.json` without dev
dependencies or scripts) to the `dist` branch with the tag `dist-vX.Y.Z`. It then creates a GitHub
Release with the `.tgz` attached.

## Credits

`mayfly-core.ts` is our own client for the [Mayfly Chat](https://github.com/josharian/mayfly) protocol.
Its encryption and validation helpers are adapted from Mayfly's reference client, and `test/vectors.json`
is copied from the Mayfly repo. Both are MIT-licensed; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
