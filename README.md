# zh

Headless agent runner built from [zcode](https://github.com/coderbuzz/zcode).
It packages the zcode CLI for machines with no display: an orchestrator sends a
prompt over SSH or stdio, the agent plans, calls tools, and returns the result.
No browser, no TUI, no display server required.

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
symlinks `zh` into `~/.local/bin`, and smoke tests it. Pick a method
explicitly if you prefer:

```sh
# standalone executable per OS/arch, no bun or node needed (default)
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=binary

# minified bundle + launcher; runs with bun, falls back to node
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=bundle

# build from source on the target machine; needs bun
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh -s -- --method=source
```

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
independent bundle plus standalone binaries for linux-x64, linux-arm64,
darwin-x64, and darwin-arm64. The darwin binaries are unsigned; macOS may
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

### Protocol mode

For long-lived orchestration, `app-server` and `agent-server` expose the
ZCode Protocol over stdio. The orchestrator keeps the process alive and
exchanges JSON frames instead of spawning `zh` per prompt:

```sh
zh app-server
```

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
map, `bun run build -- --release` minifies and drops the map (about 14 MB),
which is what release assets contain.

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
  `install-remote.sh` — one-line remote installer (binary, bundle, or source)
- `.github/workflows/release.yml` — release pipeline: bundle, standalone
  binaries, and checksums published on every `v*` tag
- `config/provider/zcode-builtin.json` — bundled provider/model catalog the CLI
  seeds from on first run
- `patches/` — pinned `@ai-sdk` patches applied on install

## Status

Ready for unattended work. Verified against this codebase: all three install
methods completed a real headless agent prompt on a clean environment,
checksum verification included; a build from a wiped workspace (`node_modules`
and `dist` removed) passes end to end; releases are produced by GitHub Actions
from a single tag push.

Known limits: the interactive TUI is not part of this repository (the
upstream `@zcode/tui` package was not extracted, so `zh tui` fails with an
error rather than opening a terminal UI); there are no Windows binaries yet;
the darwin binaries are unsigned. Browser use (`--browser-use=headless`)
drives a real Chromium end to end on the source and bundle installs; the
standalone binary installs the `playwright-core` driver but its node-repl
browser bridge is not registered yet, so prefer `--method=bundle` when the
orchestrator needs browsing.

## License

[MIT](LICENSE). This repository builds on code extracted from the
[zcode](https://github.com/coderbuzz/zcode) project.
