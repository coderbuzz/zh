# CONTEXT.md

Shared context for any agent session working in this repository. Read this
before doing anything else; it compresses what previous sessions learned the
expensive way.

## What this repo is

zheadless (`zh`) is a headless agent runner extracted from the zcode
monorepo (github.com/coderbuzz/zcode). It packages the zcode CLI agent for
machines with no display: an orchestrator sends a prompt (`zh -p`) or holds a
long-lived stdio protocol connection (`zh app-server` / `zh agent-server`),
and the agent plans, calls tools, loads skills, drives dynamic workflows, and
can browse with a real Chromium. Install is one line:

```sh
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh
```

Latest release: **v0.1.3**. License: MIT (owner's call; upstream zcode is
Apache-2.0). Repo owner: coderbuzz (Indra Gunawan).

## Current state (verified, not aspirational)

- Install methods: `binary` (default, bun --compile standalone, no runtime
  needed), `bundle` (minified `dist/zcode.cjs`, bun first, node fallback),
  `source` (built on the target machine). Checksums verified from
  SHA256SUMS; `--uninstall`, `--prefix`, `--home`, `--asset-dir` supported.
- Agent loop, `--output-format json` (sessionId + usage stats for
  orchestrators), `--target`, `--resume`, skills (user + project scope),
  dynamic workflows: all working headless.
- Browser use (`--browser-use=headless` + `--browser-executable`): executes
  real JavaScript in the page. Verified in a bare Debian 12 container with
  the linux-x64 binary: one-liner install, agent loop, then
  `navigator.userAgent` returned through Chromium.
- Protocol servers: `app-server` and `agent-server` both start the same
  `ZCodeProtocolAgentServer` (NDJSON, ZCode Protocol v4 over stdio). Method
  table: `packages/shared/src/zcode-protocol-v4/transport.ts` (V4_METHODS);
  dispatcher: `packages/bootstrap/src/zcode-protocol/server.ts`. Boot and
  clean shutdown verified; a worked frame-level handshake example is still
  missing (see open threads).
- Release pipeline: GitHub Actions on `v*` tags (`.github/workflows/
  release.yml`). Publishes bundle, 4 standalone binaries
  (linux/darwin x64+arm64), playwright-core driver asset, SHA256SUMS.
  `zh version` comes from the tag via `ZCODE_BUILD_VERSION` (bundle) and
  `--define` (binary); source builds read the root package.json.
- Build: workspace packages compile with `tsc` via `build-all.sh` in
  dependency order; the CLI bundle is built by Bun.build
  (`packages/cli/scripts/build.mjs`, esbuild fully removed).

## Key decisions and invariants

- **Bun is the priority runtime.** `bin/zh` resolves symlinks, walks up, and
  execs `bun packages/cli/src/main.ts` (source checkout) or
  `dist/zcode.cjs` (bundle). node only runs the prebuilt bundle when bun is
  absent.
- **The repo must stay self-contained.** No references to the upstream
  monorepo: `config/provider/zcode-builtin.json` (bundled model catalog) and
  `official-plugins/` (node-repl-host 0.6.0, browser-use 0.5.1, harvested
  from the official marketplace cache) are committed here. If you touch
  `.gitignore`, remember `!official-plugins/*/dist/` keeps the plugin dist
  tracked.
- **Bundling playwright-core into the single-file bundle does not work**
  (runtime package assets + require.resolve; the inline build fails on
  chromium-bidi). It ships as a release asset instead, extracted by the
  installer into `<install root>/node_modules`.
- **Plugin lookup walks up.** `candidateBaseDirs()` in
  `packages/bootstrap/src/app/bundled-plugins.ts` includes walk-up anchors
  from the real executable (realpath of argv[1], execPath fallback for
  virtual `$bunfs` paths inside bun --compile binaries). Same pattern in
  `loadCliPlaywrightChromium()` and the provider config lookup in
  `provider-runtime-env.ts`. Copy this pattern for anything that must find
  repo-shipped files at runtime.
- **`node:sea` does not exist in Bun.** Never import it statically; guard
  with `process.getBuiltinModule?.("node:sea")`. Three sites are already
  guarded (core/environment, tui-runtime-loader, sea-playwright-runtime).
- **TUI is out of scope so far.** `@zcode/tui` was never extracted; `zh tui`
  fails with a clear "Cannot find package" error by design.

## Gotchas (learned the hard way)

- **The desktop ZCode app pollutes the environment on this Mac.** Its
  `ZCODE_*` variables (broker paths, provider config overrides) leak into
  shells. When testing "bare VM" behavior, strip every `ZCODE_*` var and use
  an isolated HOME: only `~/.zcode/v2/credentials.json` and
  `~/.zcode/v2/provider_config.json` are needed for auth.
- **`~/.zcode/cli/plugins/cache/zcode-plugins-official/` masks missing
  plugins.** The desktop app seeds it; a repo without `official-plugins/`
  looked fine here and broke on a bare machine. Test browsing with an
  isolated HOME, not just stripped env.
- `bun scripts/build.mjs`, not `node`: `Bun.build` needs the bun runtime.
  `outfile` alone is ignored; use `outdir` + literal `naming.entry`.
- OrbStack is installed on this machine: `docker run` gives a clean Linux
  test bed in seconds (debian:bookworm-slim worked well; `apt install
  chromium` provides the browser).
- Agents under test may silently fall back to HTTP fetch when browsing is
  requested. Verify real browser execution by asking for a value that only
  exists at runtime, like `navigator.userAgent`.
- The desktop app sets `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, which bypasses the bundled config
  lookup. Unset them when testing that path.

## Conventions

- Docs follow the antislop skill (loaded from ~/.agents/skills): no em
  dashes, no buzzwords, no unverifiable claims; every claim in README/Status
  was demonstrated. Keep that bar.
- Workflow: branch, conventional commit, PR, squash-merge, delete branch.
  Releases are a tag push away; bump the root version in the same round.
- Verify before claiming: clean-room builds (`rm -rf node_modules
  packages/*/dist`), container tests, agent prompts with exact-match
  replies. Report failures as failures.

## Open threads

1. **TUI inclusion research** (next session): complexity and size cost of
   bringing `@zcode/tui` from the upstream monorepo (workspace packages,
   Ink 7 + yoga-layout, top-level-await CJS implications for the bun-built
   bundle).
2. **zh as a browser-accessible UI server** (next session): explore serving
   an orchestrator UI from `zh` like the zcode remote feature
   (zcode.z.ai/remote/v4). Relevant hooks already in the code:
   `presentationSurface` (`desktop_local_host` vs `remote_workspace_host`,
   see `zcode-protocol-entrypoint.ts`), the v4 protocol's
   controller/conversation subscribe model, and the fact that the desktop
   app is itself just an app-server client.
3. Protocol handshake worked example for the README (frames are schema-rich;
   needs a real client session to capture).
4. Windows binaries; darwin signing.
