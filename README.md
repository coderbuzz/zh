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

```sh
git clone https://github.com/coderbuzz/zheadless.git
cd zheadless
sh install.sh
```

The installer checks for [Bun](https://bun.sh) and installs it if missing,
runs `bun install`, builds the workspace packages with `build-all.sh`, and
symlinks the launcher into `~/.local/bin`. To install the symlink elsewhere:

```sh
PREFIX=/usr/local/bin sh install.sh
```

To remove the symlink:

```sh
sh install.sh --uninstall
```

After installing, `zh` is callable from any console. Verify with
`zh version`.

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
TypeScript entry `packages/cli/src/main.ts` directly, so no bundling step
stands between a code change and the next run. Only when bun is absent does
the launcher fall back to `node` with a prebuilt `packages/cli/dist/zcode.cjs`,
which this repository does not build by default.

## Build

```sh
bun run build        # or: sh build-all.sh
```

This compiles every workspace package with `tsc` in dependency order
(13 packages). `dynamic-workflow` additionally runs a codegen step
(`scripts/generate-libs.mjs`) on first build; the build script runs it
automatically when the generated file is missing. `packages/formal-proof`
is a Vite demo app outside the main build.

`bun run build` inside `packages/cli` additionally produces a
self-contained node bundle at `packages/cli/dist/zcode.cjs` (about 28 MB),
which the launcher uses as its node fallback; the repository does not build
it by default.

## Layout

- `packages/cli` — entry point and command routing (prompt, TUI, protocol servers)
- `packages/core` — runtime, output, environment
- `packages/bootstrap` — agent bootstrapping: model factory, skills, auth, telemetry
- `packages/provider`, `packages/provider-node` — AI SDK providers
- `packages/adapters` — node adapters (logger, clipboard, search)
- `packages/dynamic-workflow`, `packages/dynamic-workflow-runtime` — workflow engine
- `packages/contracts`, `packages/shared`, `packages/shared-types` — types and shared code
- `packages/i18n`, `packages/telemetry`, `packages/model-option-map` — support modules
- `packages/zcode-cua` — computer-use broker contracts
- `bin/zh` — launcher script; `install.sh` — installer
- `config/provider/zcode-builtin.json` — bundled provider/model catalog the CLI
  seeds from on first run
- `patches/` — pinned `@ai-sdk` patches applied on install

## Status

Work in progress. The headless prompt path, protocol servers, skills, and the
Bun runtime are verified working. The single-binary (SEA) bundling pipeline
from upstream zcode is not part of this repository yet.
