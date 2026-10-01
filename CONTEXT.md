# CONTEXT.md

Shared context for any agent session working in this repository. Read this
before doing anything else; it compresses what previous sessions learned the
expensive way.

## What this repo is

zheadless (`zh`) is a headless agent runner extracted from the ZCode
monorepo (github.com/zai-org/ZCode). It packages the zcode CLI agent for
machines with no display: an orchestrator sends a prompt (`zh -p`) or holds a
long-lived stdio protocol connection (`zh app-server` / `zh agent-server`),
and the agent plans, calls tools, loads skills, drives dynamic workflows, and
can browse with a real Chromium. Install is one line:

```sh
curl -fsSL https://raw.githubusercontent.com/coderbuzz/zheadless/main/install-remote.sh | sh
```

Latest release: **v0.5.0** (zh web mode; PR #28). License: MIT (owner's call;
upstream zcode is Apache-2.0). Repo owner: coderbuzz (Indra Gunawan).

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
  (linux/darwin x64+arm64, each carrying `dist/zcode.cjs` for the TUI
  re-exec), playwright-core driver, TUI runtime asset, SHA256SUMS.
  `zh version` comes from the tag via `ZCODE_BUILD_VERSION` (bundle) and
  `--define` (binary); source runs take it from the launcher's env export.
- Build: workspace packages compile with `tsc` via `build-all.sh` in
  dependency order; the CLI bundle is built by Bun.build
  (`packages/cli/scripts/build.mjs`, esbuild fully removed).

## Key decisions and invariants

- **Bun is the priority runtime.** `bin/zh` resolves symlinks, walks up, and
  execs `bun packages/cli/src/main.ts` (source checkout) or
  `dist/zcode.cjs` (bundle). node only runs the prebuilt bundle when bun is
  absent.
- **Installer default is `auto`.** `install-remote.sh` picks the bundle when a
  usable runtime already exists (bun >= 1 or node >= 22, the runtime contract
  of `dist/zcode.cjs`), the standalone binary otherwise. Bundle installs pin
  the validated runtime paths in `<install root>/.zh-runtime` (only when their
  directories are not in `PATH`); `bin/zh` sources that file and prefers the
  pinned binaries over `PATH` lookup, so non-interactive shells (cron, agents)
  work too. Bundle layouts ship no root `package.json`; the launcher guards
  its `sed` version probe with `[ -f ]`, and `zh version` stays correct via
  the compile-time `__CLI_VERSION__`.
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
- **The TUI is included.** `packages/tui` is the upstream `@zcode/tui`
  package (OpenTUI native renderer + React 19, not Ink/yoga as an earlier
  handoff guessed). `tsc` emits declarations, then `bun scripts/build.mjs`
  bundles `dist/index.js` (~1.2 MB ESM) with every non-`@zcode` dependency
  external. The CLI bundle stays free of it (top-level await in OpenTUI's
  native loader can never enter a CJS bundle) and ships as a release asset
  built by `scripts/stage-tui-runtime.mjs` (68 packages, ~14.7 MB tar.gz,
  natives for all four targets via npm pack, no `.map` files, koffi trimmed
  to the four build triplets).
- **bun --compile binaries are hermetic.** A dynamic `import()` of a file on
  disk resolves that file's bare imports against the embedded module graph
  only, never against disk `node_modules`, and `Bun.plugin` does not hook it
  (`createRequire` and `NODE_PATH` do not help either). The TUI path in
  `tui-runtime-loader.ts` escapes by re-executing the binary as the bun CLI
  (`BUN_BE_BUN=1`) running the on-disk `dist/zcode.cjs`, which is why binary
  release tarballs now also carry `dist/zcode.cjs`.

## Upstream sync (vendor branch)

zheadless tracks `zai-org/ZCode` releases directly. The fork
`coderbuzz/zcode` is archived (read-only; merged once at v3.14.3, then
dormant — kept only as history, nothing fetches from it). The sibling
clone at `../zcode` is a plain clone of `zai-org/ZCode` and the default
`ZCODE_REPO` for `scripts/sync-vendor.sh`; fetch new release tags there
from `origin`.

- `vendor/upstream` is a generated branch holding verbatim copies of the
  tracked zcode files, laid out like this repo: 17 packages (11 from
  `apps/zcode-cli/packages`, 6 from the monorepo root),
  `config/provider/zcode-builtin.json`, `patches/@ai-sdk__*.patch`,
  `third-party/`, `THIRD-PARTY-NOTICES.md`. Written only by
  `scripts/sync-vendor.sh`. Patch the copies on main, never on the vendor
  branch.
- Per release: fetch the tag in a zcode clone, run
  `ZCODE_REPO=<clone> sh scripts/sync-vendor.sh <rev>`, then on main
  `git merge vendor/upstream`, and tag the vendor tip `vendor/vX.Y.Z`. Git
  re-applies this repo's patch layer three-way; a conflict means upstream
  touched the same hunk. Vendor merges land as real merge commits on main,
  never squashed: the ancestry is what makes the next sync a 3-way merge.
- Patch layer to keep or drop consciously on each sync: Bun-safe `node:sea`
  probes (core/environment, cli/sea-playwright-runtime,
  cli/tui-runtime-loader), install-root walk-up lookups
  (bootstrap/bundled-plugins, cli/provider-runtime-env,
  cli/sea-playwright-runtime), TUI re-exec through `dist/zcode.cjs`,
  official-plugins paths, the version fallback in cli/run.ts, the Bun
  bundler scripts (cli, tui), the enriched provider catalog, and the
  playwright error-cause surfacing in adapters/browser. Drop a patch the day
  upstream fixes the same problem.
- The script prints NOTICE lines for upstream files under the mapped roots
  that it did not vendor (a new package, a new cli/tui build script, a new
  patch file). Each line is a mapping decision, not noise.
- Baseline: `vendor/v3.14.3` (snapshot base 4da0360, then 29628c9). The
  first merge into main carried the v3.14.0-to-v3.14.3 update in one step.

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
- **TUI verification needs a terminal that answers.** OpenTUI probes the
  terminal for capabilities (cursor position, XTVERSION) at startup; `script`
  and a bare `tmux` inside a container without a real outer terminal never
  answer, and the renderer stalls with a 1x1 root. A `tmux` on a real host
  works (it answers the queries itself). For CI-friendly render checks use
  OpenTUI's own test renderer:
  `createTestRenderer()` from `@mbears/opentui-core/testing` plus `createRoot`
  from `@mbears/opentui-react` renders to a captured frame with no terminal
  at all.
- `sh build-all.sh` now runs 13 tsc packages plus `packages/tui`, whose build
  needs the bun runtime (`tsc && bun scripts/build.mjs`), and `packages/cli`
  typecheck needs the tui declarations, so the tui entry must stay after
  `bootstrap` in the build order.

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

1. **zh as a browser-accessible UI server** (RESOLVED 2026-09-29, second
   session): implementation shipped in v0.5.0 (PR #28). Host verification was
   already green; the container round-trip failure is now root-caused and the
   earlier open question is answered. Root cause: the credential store cipher
   derives its key from platform/homedir/username
   (`services/src/credential/providers/credentialCipherProvider.ts`), so v2
   state copied from the Mac can never decrypt inside the container; the
   OAuth repo then clears the session entries silently (upstream forced
   logout) and rewrites `credentials.json`, the UI loses the account, and
   after the onboarding wizard Root renders an empty shell (no workspace, no
   welcome gate, `shouldShowRootStartupLoading` false on web). Both original
   hypotheses are settled: H1 (live sqlite copy) is WRONG; a fresh container
   with only `credentials.json` + `provider_config.json` reproduces the
   failure, and `zh -p` answers exactly SIAP in the same container. H2 (a
   web-mode boot gate bug) is also WRONG: with the correct
   `ZCODE_CREDENTIAL_SECRET` the identical container passes everything.
   Evidence (debian:bookworm-slim, release layout /opt/zh from the v0.5.0
   assets): auth 200 public shell / 401,401,401 tokenless or wrong token on
   `/api/*` and `/ws` / 200,101 with the banner token; browser matrix via
   playwright-core + host Chrome: palette Cmd+K open, Escape close, chat
   round-trip with exact sentinel reply, PTY `echo hi` + `git branch
   --show-current`; host matrix re-run green with the patched code. The
   agent child is spawned LAZILY at first browser boot, not at server
   start; a `/proc` scan before the first browser connect correctly shows
   no agent child.
   Fixes in this repo (no `@zcode/ui` patches): `credentialService.load`
   backs the store up once (`credentials.json.corrupt-<hash>.bak`) and logs
   a remedy-bearing warning on the first decrypt failure;
   `OAuthCredentialRepo.clearCorruptOAuthSession` logs the forced logout
   (the server wiring at `services/src/node.ts` builds repo instances whose
   callback was silent); `packages/rpc` logging middleware also logs
   `[rpc:recv]` at call arrival, which is how hanging-vs-never-called RPCs
   get told apart. README documents cross-machine staging
   (`ZCODE_CREDENTIAL_SECRET` formula) and the minimal v2 file set. Known
   upstream leftover, left as-is: the cleaned intermediate state (residual
   api-key entry, no OAuth session) blanks after the wizard instead of
   showing the welcome screen; reachable only through the migration trap
   above, so the warnings plus documentation are the chosen mitigation.
2. Protocol handshake worked example for the README (frames are schema-rich;
   needs a real client session to capture).
3. Windows binaries; darwin signing.
4. TUI runtime asset could drop `.d.ts` and unused shiki engines to shrink
   the 14.7 MB asset.
