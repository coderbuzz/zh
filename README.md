# zh

Headless agent runner built from [zcode](https://github.com/coderbuzz/zcode).
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
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh
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
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=auto

# standalone executable per OS/arch, no bun or node needed
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=binary

# minified bundle + launcher; runs with bun, falls back to node
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=bundle

# build from source on the target machine; needs bun
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=source
```

What `auto` does, in order:

1. Looks for a usable runtime in `PATH` first, then in known install
   locations (`~/.bun/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, and
   `~/.nvm/versions/node/*`): `bun` (any 1.x) or `node` >= 22.
2. Runtime found: it installs the bundle. Runtimes whose directory is not in
   `PATH` are recorded in `~/.local/share/zheadless/.zh-runtime`, and the
   launcher prefers those pinned binaries, so `zh` also works in
   non-interactive shells.
3. No runtime: it installs the standalone binary for this OS/arch. If the
   release has no binary asset for the platform, the install fails with
   instructions to install bun or node (or force `--method=bundle`).

Files live under `~/.local/share/zheadless` (`--home` to change) and the
launcher goes to `~/.local/bin/zh` (`--prefix` to change). Re-running the
installer repairs an existing install; remove everything with:

```sh
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --uninstall
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
records the absolute path in `~/.local/share/zheadless/.zh-runtime`; the
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

- `packages/cli` — entry point and command routing (prompt, protocol servers)
- `packages/core` — runtime, output, environment
- `packages/bootstrap` — agent bootstrapping: model factory, skills, auth, telemetry
- `packages/provider`, `packages/provider-node` — AI SDK providers
- `packages/adapters` — node adapters (logger, clipboard, search)
- `packages/dynamic-workflow`, `packages/dynamic-workflow-runtime` — workflow engine
- `packages/contracts`, `packages/shared`, `packages/shared-types` — types and shared code
- `packages/i18n`, `packages/telemetry`, `packages/model-option-map` — support modules
- `packages/zcode-cua` — computer-use broker contracts
- `bin/zh` — launcher script; `install.sh` — source installer;
  `install-remote.sh` — one-line remote installer (auto, binary, bundle, or source)
- `packages/tui` — the interactive terminal interface (`zh tui`), bundled to
  `dist/index.js` and kept external from the CLI bundle;
  `scripts/stage-tui-runtime.mjs` — builds the TUI runtime release asset
- `.github/workflows/release.yml` — release pipeline: bundle, standalone
  binaries, and checksums published on every `v*` tag
- `config/provider/zcode-builtin.json` — bundled provider/model catalog the CLI
  seeds from on first run
- `patches/` — pinned `@ai-sdk` patches applied on install

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
[zcode](https://github.com/coderbuzz/zcode) project.
