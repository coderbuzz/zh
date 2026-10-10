# zh

Headless agent runner built from [ZCode](https://github.com/zai-org/ZCode).
Runs fully headless for VMs and orchestrators, with the full interactive TUI
when you need it.

It packages the zcode CLI for machines with no display: an orchestrator sends a
prompt over SSH or stdio, the agent plans, calls tools, and returns the result.
Headless runs never require a display server. For interactive sessions, `zh
tui` opens the full zcode terminal interface.

The agent loop is the zcode agent. It reads and writes files, runs shell
commands, loads local skills, and can drive dynamic workflows. Prompt runs
default to permission mode `yolo`, which fits unattended VMs; scope it down
with `--mode build|edit|plan` when the task warrants it.

## Install

One line, no git required:

```sh
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh
```

The installer downloads the latest release, verifies its SHA256 checksums,
symlinks `zh` into `~/.local/bin`, and smoke tests it. The default method is
`auto`: bundle when the machine already has a usable runtime (bun, or
node >= 22, the runtime contract of the prebuilt bundle), standalone binary
otherwise. The bundle reuses the runtime already installed instead of
shipping one, which is why developer machines usually get it. Pick a method
explicitly if you prefer:

```sh
# auto: bundle when bun or node >= 22 is present, binary otherwise (default)
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh -s -- --method=auto

# standalone executable per OS/arch, no bun or node needed
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh -s -- --method=binary

# minified bundle + launcher; runs with bun, falls back to node
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh -s -- --method=bundle

# build from source on the target machine; needs bun
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh -s -- --method=source
```

What `auto` does, in order:

1. Looks for a usable runtime in `PATH` first, then in known install
   locations (`~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, and
   `~/.nvm/versions/node/*`): `bun` (any 1.x) or `node` >= 22.
2. Runtime found: it installs the bundle. Runtimes whose directory is not in
   `PATH` are recorded in `~/.local/share/zh/.zh-runtime`, and the
   launcher prefers those pinned binaries, so `zh` also works in
   non-interactive shells.
3. No runtime: it installs the standalone binary for this OS/arch. If the
   release has no binary asset for the platform, the install fails with
   instructions to install bun or node (or force `--method=bundle`).

Files live under `~/.local/share/zh` (`--home` to change) and the
launcher goes to `~/.local/bin/zh` (`--prefix` to change). Re-running the
installer repairs an existing install (an install root left at the old
`~/.local/share/zheadless` is moved to the new path automatically, with a
symlink left behind); remove everything with:

```sh
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zh/main/install-remote.sh | sh -s -- --uninstall
```

From a clone of this repository, `sh install.sh` does the same as
`--method=source` plus a `bun install` refresh. Verify any install with
`zh version`.

Releases are built by GitHub Actions on every `v*` tag: a platform
independent bundle, standalone binaries for linux-x64, linux-arm64,
darwin-x64, and darwin-arm64, the playwright-core driver, and the TUI runtime
asset. The darwin binaries are unsigned; macOS may
ask you to clear the quarantine flag before first run.

## Authentication

`zh login zai --no-browser` prints an OAuth URL; complete it on any machine
with a browser. `zh login bigmodel` is the alternative provider. Credentials
are shared with the regular zcode CLI storage, so a machine that already
logged in through zcode needs no extra setup.

## Usage

Run one prompt in the current directory and exit:

```sh
zh -p "audit the failing tests and fix them"
```

Machine-readable output for an orchestrator:

```sh
zh -p "write a migration for the users table" --output-format json
```

Set a session goal instead of a one-shot prompt:

```sh
zh --target "keep the flaky test suite green"
```

Other flags worth knowing:

- `--mode build|edit|plan|yolo` sets the permission mode (default for
  `-p` is `yolo`)
- `--attach <path>` adds a local file to the prompt, repeatable
- `--resume <sessionId>` / `-c` continue a previous session
- `--disallowed-tools "Bash Edit"` removes tools for one run
- `--cwd <path>` runs in another directory

### Interactive TUI

`zh tui` opens the upstream zcode terminal interface: the zcode logo screen,
prompt composer, model and effort switching, slash commands, and the session
workflow views. It needs a real terminal; without a TTY it prints
`TUI requires an interactive terminal.` and exits.

The TUI runtime (`@zcode/tui` and its dependency closure) ships as its own
release asset, `zheadless-tui-runtime-<tag>.tar.gz`, which the installer
extracts into `<install root>/node_modules` next to the playwright-core
driver. On the binary install, `zh tui` re-executes the bundled
`dist/zcode.cjs` through the binary's own bun runtime (`BUN_BE_BUN=1`): a
compiled binary cannot resolve the TUI's on-disk dependencies by itself, and
the bundle on disk resolves them normally.

### Protocol mode

For long-lived orchestration, `app-server` and `agent-server` run the ZCode
Protocol server: a process that speaks newline-delimited JSON frames on stdio
and stays alive across many prompts, so the orchestrator keeps one connection
instead of spawning `zh` per request.

```sh
zh app-server
```

Both commands start the same protocol server; the two names match the host
roles upstream zcode uses:

- **`app-server`** fronts the whole application surface: the session index,
  workspace config, multiple conversations, attachments, and usage stats.
  Use it when your orchestrator is a service that manages many sessions or
  workspaces, for example a pool of agents behind a dashboard. This is how
  the zcode desktop, web, and mobile clients drive the CLI.
- **`agent-server`** is the same server used as a single-agent endpoint: one
  process, one workspace, one conversation stream. Use it when a job or an
  editor extension owns exactly one agent and wants a persistent connection,
  for example a CI bot that keeps a session warm across steps.

The wire contract lives in `packages/shared/src/zcode-protocol-v4/` (method
table in `transport.ts`) and the dispatcher in
`packages/bootstrap/src/zcode-protocol/server.ts`. Methods include
`v4/connection/flow`, `v4/controller/subscribe`, `v4/conversation/subscribe`,
`v4/conversation/rowsRange`, the `v4/conversation/workflowRun*` family,
`v4/attachment/*`, `v4/usage/stats`, and `v4/command`.

An orchestrator skeleton looks like this (exact frame params come from the
schema files above):

```js
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const server = spawn("zh", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
const frames = createInterface(server.stdout);
frames.on("line", (line) => console.log("frame:", JSON.parse(line)));

const send = (frame) => server.stdin.write(`${JSON.stringify(frame)}\n`);
send({ jsonrpc: "2.0", id: 1, method: "v4/connection/flow", params: {} });
```

Killing the process (or closing its stdin) shuts the session down cleanly;
the server reports `Protocol input closed` on stderr and exits.

### Web mode

`zh web` serves the web UI over HTTP and spawns the same agent child, so a
browser on another machine can run prompts against a workspace:

```sh
zh web --host 0.0.0.0 --port 4180
```

The banner prints the local and network URLs with a per-start token. The
static shell is public by design; `/api/*` and `/ws` are token-gated from a
non-loopback client (401 without the token, 200 and 101 with the token from
the banner). Bound to loopback, the default, the server starts with no
token and gates nothing.

`zh web` opens a browser automatically when bound to loopback. On a headless
host (no `DISPLAY`/`WAYLAND_DISPLAY`, or running under systemd or SSH) it
skips the attempt and says so; `--open` forces the attempt and `--no-open`
always disables it. A missing `xdg-open` is reported as a hint instead of
crashing the server.

The browser keeps its WebSocket to `/ws` alive with server pings and an
app-level heartbeat, and reconnects automatically with backoff after an
idle-proxy timeout, a network switch, or a server restart; the active
session is restored on reconnect without a page refresh. If the WebSocket
upgrade is rejected by an auth wall (for example an expired Cloudflare
Access session, which answers with a redirect instead of 101), reconnecting
stops and the page reloads so the browser can sign in again.

The server runtime needs Node >= 22 on `PATH` (the node-pty native addon);
`ZH_WEB_NODE` overrides the lookup. The web dist ships as its own release
asset, `zheadless-web-<tag>.tar.gz`, which `install-remote.sh --web`
extracts into the install root; `zh web` finds `<root>/web` and
`<root>/server` by walking up from its own entry.

Upstream web-mode stubs, unchanged: the file picker, the remote workspace
wizard (SSH, WSL, Docker), the embedded browser, and phone remote render
but do not drive a real backend. Branding covers the shell surfaces only
(tab title, favicon, boot logo, and the document title strings in the web
entry); strings inside `@zcode/ui` stay upstream.

Free plan offers: when the signed-in account has a claimable free-token
plan (the desktop app's limited-time promotions), every page load checks
for it — `GET /api/coding-plan/manual-claim/previews` mirrors the zcode-plan
billing preview API — and the shell renders a Claim banner. Claiming opens
a dialog and goes through `POST /api/coding-plan/manual-claim/claim`; the
Aliyun captcha verify param is obtained in the browser (config from
`/api/coding-plan/captcha-config`), while the server adds the auth,
captcha, app-version, and platform headers. With no usable captcha config
the claim is refused client-side, matching the desktop app.

### Automations (scheduled tasks)

Since 0.5.17 the headless web server runs the automation scheduler itself
(upstream puts it in the desktop app's dedicated scheduler process, which
`zh web` does not have). Every automation created from a chat session
(`CronCreate`) or the UI is stored in `~/.zcode/v2/tasks-index.sqlite` and
polled every 20 seconds by the server process:

- A due automation is dispatched in-process: the scheduler claims it
  (single-flight, crash-safe), creates or resumes the target task, sends the
  saved prompt, and records the run in the automation's History tab
  (`dispatched` / `failed_to_dispatch` with retry backoff, then the real
  turn outcome `succeeded` / `failed` / `stopped`).
- A fire missed while the host was not running is not silently rolled to the
  next occurrence. Within a 5-minute grace window it still fires
  (catch-up); beyond it the run is recorded as `skipped`
  (`missed_while_host_not_running`) and a pure one-shot automation is
  finalized as `completed`, so the History tab always shows what happened.
- **Run now** works: the server wires the immediate dispatcher that desktop
  hosts provide, so the UI button enqueues a manual run instead of failing
  with "Automation immediate dispatcher is unavailable". Manual runs do not
  move the cron schedule.

### Moving zcode state to a web server host

`zh web` reads the same `~/.zcode/v2` state as the desktop app. The
credential store encrypts its values with a key derived from the local
platform, home directory, and user name, so a `credentials.json` copied
from another machine cannot be decrypted there. On decrypt failure the
OAuth session entries are removed (upstream forced-logout semantic) and
the UI falls back to the welcome screen. Since 0.5.1 this is loud: the
server logs `credential value failed to decrypt`, backs the original file
up next to itself as `credentials.json.corrupt-<hash>.bak`, and logs
`cleared local OAuth session` when the OAuth entries are removed.

Two supported ways to bring state over:

- Set `ZCODE_CREDENTIAL_SECRET` on the web server host to the source
  machine's secret. With the default derivation the secret is
  `zcode-credential-fallback:<platform>:<homedir>:<username>`, for example
  `zcode-credential-fallback:darwin:/Users/indra:indra`. If the source
  machine already sets `ZCODE_CREDENTIAL_SECRET`, use that same value.
  Restore the `.bak` backup if the store was already rewritten.
- Or start clean: copy only `provider_config.json` (API-key providers and
  model rules) and sign in through the web welcome screen.

The minimal state set for `zh web` is `credentials.json` plus
`provider_config.json`. `tasks-index.sqlite` and its `-shm`/`-wal`
sidecars are not needed; do not copy them out of a running desktop app.

### Skills

`zh skills list` shows the local skills the agent will load, from
`~/.agents/skills` and the workspace. Dropping a skill into one of those
directories is enough; the next run picks it up.

## Runtime

Bun is the priority runtime. The `zh` launcher (a plain `sh` script) checks
for `bun` first, adds `~/.bun/bin` to `PATH` for fresh installs, and runs the
freshest entry it can find: the TypeScript source in a source checkout, or
the prebuilt `dist/zcode.cjs` in a bundle install. Only when bun is absent
does the launcher fall back to `node` with the bundle. The `--method=binary`
install skips the launcher entirely: `zh` is a standalone executable with
the bun runtime embedded.

When the installer picks the bundle and the validated runtime lives outside
the default `PATH` (version managers, `~/.bun` before the profile reload), it
records the absolute path in `~/.local/share/zh/.zh-runtime`; the
launcher sources that file and prefers the pinned binaries over `PATH`
lookup, so `zh` also works in non-interactive shells.

## Build

```sh
bun run build        # or: sh build-all.sh
```

This compiles every workspace package with `tsc` in dependency order
(13 packages). `dynamic-workflow` additionally runs a codegen step
(`scripts/generate-libs.mjs`) on first build; the build script runs it
automatically when the generated file is missing. `packages/formal-proof`
is a Vite demo app outside the main build.

`bun run build` inside `packages/cli` additionally produces the node bundle
at `packages/cli/dist/zcode.cjs`: plain `bun run build` keeps a debug source
map, `bun run build -- --release` minifies and drops the map (about 12 MB),
which is what release assets contain. The bundle is built by Bun's own
bundler; `ZCODE_BUILD_VERSION=<tag>` overrides the version reported by
`zh version`, which the release pipeline sets from the git tag.

## Layout

- `packages/cli`: entry point and command routing (prompt, protocol servers)
- `packages/core`: runtime, output, environment
- `packages/bootstrap`: agent bootstrapping (model factory, skills, auth, telemetry)
- `packages/provider`, `packages/provider-node`: AI SDK providers
- `packages/adapters`: node adapters (logger, clipboard, search)
- `packages/dynamic-workflow`, `packages/dynamic-workflow-runtime`: workflow engine
- `packages/contracts`, `packages/shared`, `packages/shared-types`: types and shared code
- `packages/i18n`, `packages/telemetry`, `packages/model-option-map`: support modules
- `packages/zcode-cua`: computer-use broker contracts
- `bin/zh`: launcher script; `install.sh`: source installer;
  `install-remote.sh`: one-line remote installer (auto, binary, bundle, or source)
- `packages/tui`: the interactive terminal interface (`zh tui`), bundled to
  `dist/index.js` and kept external from the CLI bundle;
  `scripts/stage-tui-runtime.mjs`: builds the TUI runtime release asset
- `.github/workflows/release.yml`: release pipeline (bundle, standalone
  binaries, and checksums published on every `v*` tag)
- `config/provider/zcode-builtin.json`: bundled provider/model catalog the CLI
  seeds from on first run
- `patches/`: pinned `@ai-sdk` patches applied on install

## Status

Production ready for unattended headless work.

- One-line install on Linux (x64, arm64) and macOS (Apple silicon, Intel),
  with no bun, node, or git required. Every install method is self-contained:
  the browser driver and the interactive TUI runtime come with the install.
- `zh -p` returns plain text or machine-readable JSON with session and usage
  data for orchestrators.
- `zh app-server` / `zh agent-server` hold one NDJSON connection across many
  prompts, for orchestrators that keep sessions warm.
- `zh tui` opens the full zcode terminal interface. It needs a real terminal
  (a local terminal or an SSH session with a TTY) and exits with a clear
  message otherwise. Running `zh` with no arguments opens it.
- Browser use drives a real headless Chromium through `--browser-use=headless`.

Known limits, stated plainly: no Windows binaries yet; darwin binaries are
unsigned, so macOS may ask you to clear the quarantine flag on first run; the
protocol server's frame-level handshake is documented as a schema reference
rather than a worked example.

If you find a gap, the fastest path is `zh -p` against this repository.

## License

[MIT](LICENSE). This repository builds on code extracted from the
[ZCode](https://github.com/zai-org/ZCode) project.
