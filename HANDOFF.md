# Handoff: zh web OAuth callback fix, session 2026-10-02 (build VM)

Status for the production bug found 2026-10-01 ~22:11 WIB (Z.ai browser login
in zh web mode pends forever). Read CONTEXT.md first. The previous handoff
(zh web, session 2026-09-29, plus the pending v3.14.4 sync runbook) follows
below, unchanged and still current.

## Status: fix implemented, verified, pushed on `fix/web-oauth-callback`

Work branch `fix/web-oauth-callback` (base: main @ b209d84), two commits:

1. `fix: keep server-provided OAuth callback URL in zh web login` (ea6a204):
   the fix plus the regression test.
2. `docs: record OAuth callback fix status and VM handoff`: this section.

Root cause: `startOAuthWithPolling` in
`packages/services/src/oauth/oauthService.ts` unconditionally rewrote the
authorize URL returned by the zcode.z.ai `cli/init` endpoint: `redirect_uri`
(Z.AI) and `redirect` (BigModel) were set to
`<origin>/app/oauth/login?redirect=zcode://oauth/callback&app_version=...`.
The official CLI callback (`https://zcode.z.ai/api/v1/oauth/cli/callback/zai`)
is the only thing that marks the server-side flow ready for polling; browsers
cannot follow `zcode://`, so `pollPendingOAuth` never resolved.

Fix: the rewrite is removed; the server-provided authorize URL passes through
byte-identical. The desktop deep-link contract stays intact
(`buildDesktopOAuthRedirectUriFromEnv`, the legacy non-polling `startOAuth`
flow, `handleCallback`). No desktop-vs-web gate was added: zh ships no desktop
client that registers `zcode://` (the web platform stub's `onOAuthCallback` is
a no-op), and host-side polling completes regardless of what the browser lands
on, so the deep-link path is dead code here and the unconditional default is
the pass-through.

Verified on the build VM (2026-10-02):

- `bun test packages/services/test/`: 14 pass / 0 fail, including the new
  `packages/services/test/oauthPollingAuthorizeUrl.test.ts`: Z.AI and BigModel
  authorize URLs pass through unchanged (no `/app/oauth/login`, no
  `zcode://`), state preserved; polling resolves to a logged-in session via a
  stubbed init/poll backend; the legacy provider config still builds the
  desktop relay URL (`/app/oauth/login` + `zcode://oauth/callback`).
- `bunx oxlint` on both changed files: 0 warnings.
- `tsc --noEmit -p packages/services/tsconfig.json`: clean.
- `bun packages/server/scripts/build.mjs` rebuilt `dist/entry-http.js`: the
  `searchParams.set("redirect_uri"|"redirect", ...)` rewrites are gone from
  the bundle; the remaining `zcode://oauth/callback` (3x) and `/app/oauth/login`
  (1x) literals are the intentional desktop deep-link contract and provider
  config fallbacks.
- Live check against the rebuilt bundle serving on 127.0.0.1:4190:
  `startOAuthWithPolling("zai")` over WebSocket RPC returned the real
  zcode.z.ai init response unchanged:
  `redirect_uri=https://zcode.z.ai/api/v1/oauth/cli/callback/zai`, state
  intact, nothing rewritten. Matches the hot patch verified on the deployment
  VM the same evening.
- Not verified (needs a real Z.ai account + browser): completing an actual
  login end to end and watching the UI flip to logged in without reload. The
  polling completion path itself is covered by the stubbed-poll test above.

## Remaining work for the Mac session

1. `sh build-all.sh` on the Mac (skipped on the VM: 964 MB RAM while the
   production `zh-web.service` runs on the same box; a full build risks OOM).
2. Open the PR for `fix/web-oauth-callback`, squash-merge per convention.
3. Real-browser E2E (Mac or after deploy): run `zh web`, complete a Z.ai
   login, confirm the polling log resolves and the UI shows logged in.
4. Deploy: the deployment VM (`zh-web.service`, install root
   `~/.local/share/zheadless`, v0.5.1) still runs the hand-hot-patched
   `server/entry-http.js` (backup alongside:
   `entry-http.js.bak-oauthcb-20261001`, confirmed to still contain the
   rewrite). Redeploy the web asset from the released tag so the source fix
   replaces the hot patch, then delete the backup file.
5. If shipping immediately, bump the root version in the same round
   (CONTEXT.md convention).

## Session incident on the build VM (2026-10-01 ~23:16)

The 2026-10-01 session died during cleanup: `pkill -f entry-http.js` matched
its own shell command line (killing the turn) and also terminated the
production `zh-web.service` process. systemd restarted production within
about 2 minutes (later verified healthy, 401-without-token posture intact),
but the session never recovered, likely compounded by memory pressure
(964 MB RAM, swap in use). Rules going forward on this VM: stop services via
`systemctl`, never `pkill -f` with a pattern that can match the running
command, and avoid heavy builds while `zh-web.service` runs.

---

# Handoff: `zh web` (open thread #1), session 2026-09-29

Written from the 2026-09-29 session that had to stop mid-verification (browser
automation calls kept getting cancelled on this machine; the work continues on
another machine). Read CONTEXT.md first, then this file. Everything below is
verified fact unless labeled otherwise.

## Where things stand

Branch `feat/zh-web` (based on main at 40e5ab9e, the vendor merge) holds all
implementation commits:

- 0eb02ec1 feat(cli): add the zh web command
- ea715d92 feat(web): zh branding and the Bun web build
- baadef3b feat(server): bundle the HTTP entry with Bun and stage its runtime
- 3065514e build(ci): ship the zh web release asset

On main (already pushed): `scripts/sync-vendor.sh` tracks
`rpc client services server web`; the vendor branch was regenerated at the
same baseline (zcode v3.14.3 = 29628c9, vendor commit 6745ff8) and merged as
40e5ab9e "Merge vendor/upstream: zcode v3.14.3 web mode packages". 22 packages
now live on the vendor branch. main and vendor/upstream are pushed.

## What was researched and decided (do not re-litigate)

- **Bun.build fully replaces Vite for packages/web.** Verified empirically on
  bun 1.4.2 against the real app (not a toy): HTML entry, `define` including
  `import.meta.env.*` keys, `alias`, and JSX all work. Reference comparison at
  the same rev: vite 144 MB / 6137 files / 2246 sourcemaps vs bun 60-63 MB /
  ~3956 files / 0 maps.
- **Three Bun.build gaps, all handled in `packages/web/scripts/build.mjs`:**
  1. `new Worker(new URL(...), import.meta.url)` is not transformed: two ui
     sites (diffs worker, workspace file-search worker) are text-rewritten to
     `/workers/*.js` public paths and built as separate worker bundles. The
     diffs worker must bundle `@pierre/diffs/worker/worker.js` directly as the
     entry or its side-effect-only import tree-shakes to 0 bytes (the upstream
     vite config disables treeshake for workers for the same reason).
  2. `?url` imports (pdf.js worker .mjs, two .wasm) need an onResolve+onLoad
     plugin with a namespace and the `file` loader.
  3. `new URL("../../../public/icon_512@2x.png", import.meta.url)` in
     UpdateStatusDialog is rewritten to `/icon_512@2x.png` (icon copied into
     dist; dialog is unreachable in web mode anyway).
- **Tailwind v4**: the `@tailwindcss/vite` plugin is replaced by a pinned
  `bunx @tailwindcss/cli@4.2.2` pre-pass over `packages/ui/src/styles.css`
  (same compiler; 499 KB CSS in ~0.2 s; all `@import`/`@plugin` resolved).
  KaTeX fonts are staged next to the generated CSS so Bun.build inlines them
  as data URLs (that is why the bun dist is a few MB larger than vite's).
- **index.html script src must be relative** (`./src/main.tsx`): Bun.build
  resolves root-absolute paths against cwd.
- **Server build**: tsup/esbuild are NOT used (repo policy: esbuild removed).
  `packages/server/scripts/build.mjs` (Bun.build) emits `dist/entry-http.js`
  only; the upstream `dist/remote` single-file bundle is intentionally not
  built. Externals: ssh2, node-pty, undici, axios, form-data, combined-stream,
  proxy-from-env, follow-redirects, node-forge, yaml, yazl, yauzl.
- **The server runs under Node >= 22, not bun** (node-pty native addon) --
  owner decision, keep it. Agent child stays under bun.
- **The web server resolves its node binary** from `ZH_WEB_NODE` env, then
  `.zh-runtime` `ZH_RUNTIME_NODE`, then PATH, then errors with a clear message
  (version-checked >= 22).
- **node-pty prebuilds**: npm node-pty 1.1.0 ships only darwin/win32
  prebuilds; linux ones come from the four `@lydell/node-pty-*@1.2.0-beta.10`
  packages. bun install skips os/cpu-gated packages, so
  `scripts/stage-server-runtime.mjs` fetches missing ones from the registry
  (Bun fetch of registry.npmjs.org metadata + tarball, then tar -xzf).
  Root devDependencies were tried and do NOT help; do not add them back.
- **packages/web is excluded from the zh workspace** (`"workspaces":
  ["packages/*", "!packages/web"]`) because `@zcode/ui` is deliberately not
  vendored and `bun install` would fail. Web builds only in CI, inside an
  upstream monorepo checkout.
- **One release asset** `zheadless-web-<tag>.tar.gz` containing `web/` +
  `server/`, extracted by `install-remote.sh --web` into the install root.
  `zh web` finds `<root>/server/entry-http.js` + `<root>/web/` by walking up
  from the real entry anchor (bundle path or execPath for the binary), or the
  source layout `packages/server/dist` + `packages/web/dist`.
- **Branding scope** (owner decision): tab title, favicon, boot logo, and the
  four document.title strings in main.tsx are zh. Strings inside @zcode/ui
  stay upstream; document as a limitation, do not patch @zcode/ui.
- `zh web --help` shows the GLOBAL help (run.ts intercepts --help before
  command dispatch). Do not add per-command help handling.

## Verification evidence (2026-09-29, this machine)

All with every `ZCODE_*` var stripped (desktop app pollution; use the wrapper
recipe in CONTEXT.md gotchas or: `for v in $(env | sed -n
's/^\(ZCODE_[^=]*\)=.*/\1/p'); do unset "$v"; done`).

1. Clean-room build PASS: `rm -rf node_modules packages/*/dist` then
   `bun install && sh build-all.sh` -> 15/15 OK (13 tsc packages, tui, server).
2. `bun run typecheck` in packages/cli PASS (one fix applied: the duplicate
   `help === true` narrowing in run.ts).
3. CLI bundle built: `packages/cli/dist/zcode.cjs` 24.8 MB.
4. Web dist built via CI-overlay simulation (rsync packages/web into the
   ../zcode clone checkout at 29628c9, `pnpm install` once because rsync
   --delete removes pnpm's per-package node_modules links, then
   `ZCODE_BUILD_VERSION=0.4.0-local bun packages/web/scripts/build.mjs`):
   60 MB, version string verified inside a chunk. The dist lives at
   `packages/web/dist` in this repo now (gitignored) so `zh web` source-layout
   resolution works locally.
5. Server runtime staged: `/tmp/zh-server-stage` (88 MB) with entry-http.js,
   notices, and all four platform node-pty prebuilds
   (darwin-arm64/x64, linux-arm64/x64).
6. **zh web ran end-to-end from the bundle**:
   `bun packages/cli/dist/zcode.cjs web --port 4180 --no-open` from
   `/tmp/zh-web-ws` -> banner printed, agent child =
   `bun .../dist/zcode.cjs app-server --stdio`, server log showed
   `zcode-server:http http://127.0.0.1:4180`, and the browser loaded the UI:
   tab title **"zh - Web + Server"**, sidebar rendered with real workspace
   history (zh-web-ws project visible).
7. Earlier standalone smoke test (same bun dist, static file server, no
   backend): title "ZCode - Web" set at runtime and the correct
   "Web bootstrap failed / WebSocket connection failed" screen rendered --
   proves the bundle executes without a dev server.

## Remaining work (in order)

1. **Browser chat round-trip** against `zh web` (port 4180 recipe above):
   send "balas persis satu kata: SIAP", expect the exact reply. Close the
   command palette (Escape) first; the composer is a textbox below.
   NOTE: on the 2026-09-29 machine the browser tool cancelled on
   `tab.cua.keypress` repeatedly; use playwright locators or a fresh machine.
2. **PTY terminal test**: open the terminal panel, run `echo hi` and
   `git branch --show-current`, verify output.
3. **Auth checks** (server running with `--host 0.0.0.0`):
   - `curl -s -o /dev/null -w "%{http_code}" http://<lan-ip>:<port>/` from
     OUTSIDE the machine (or another container) must be 401 without token;
   - `http://<lan-ip>:<port>/?token=<token from banner>` must load (200 +
     app boots). Loopback stays tokenless by default.
4. **Container test** (OrbStack, debian:bookworm-slim): install bun + node,
   then the release layout by hand (bundle tarball content + staged web/server
   tree, or run install-remote.sh with --asset-dir pointing at locally built
   assets), start `zh web --host 0.0.0.0 --port 4180`, and repeat the chat
   round-trip from the host against the container IP with a token.
   `scripts/stage-server-runtime.mjs` output + `packages/cli/dist/zcode.cjs`
   + `bin/zh` + `packages/web/dist` is exactly the release layout
   (`<root>/bin/zh`, `<root>/dist/zcode.cjs`, `<root>/web/`, `<root>/server/`).
5. **Docs**: close CONTEXT.md open thread #1 with the final decisions and this
   evidence; README section for web mode (usage, Node >= 22 requirement,
   limitations: file picker, remote workspace wizard SSH/WSL/Docker, embedded
   browser, phone-remote are upstream stubs; @zcode/ui strings stay upstream;
   web dist is built in CI, not locally). Follow the antislop rules.
6. **PR**: push feat/zh-web (done), open PR, squash-merge, delete branch.
   Bump root version (0.5.0) in the same round if releasing immediately;
   CI already builds the web asset on the next tag.
7. Before merging, re-check `.github/workflows/release.yml` job wiring only
   by reading (build-web -> packages needs web-dist artifact; ZCODE_VENDORED_REV
   env must match the vendor baseline; update it when vendor moves).

## Pending upstream sync: zcode v3.14.4 (blocked on upstream)

Announced on the official changelog (2026-09-29) but NOT yet in git as of
2026-10-01: `zai-org/ZCode` has no v3.14.4 tag/release and its `main` still
sits at `29628c9` (v3.14.3). The `../zcode` clone was re-created 2026-10-01
as a plain clone of `zai-org/ZCode` (the `coderbuzz/zcode` fork is archived;
nothing fetches from it). Run this once the tag exists:

1. Confirm availability: `git -C ../zcode ls-remote origin refs/tags/v3.14.4`.
2. `git -C ../zcode fetch origin tag v3.14.4`.
3. Pre-check conflicts: `git -C ../zcode diff --stat 29628c9...v3.14.4`,
   grep the diff for captcha, and check changed paths against the patch
   layer (CONTEXT.md "Upstream sync"). Locally-modified vendored files at
   v3.14.3: `cli/src/{arguments,run,provider-runtime-env,
   sea-playwright-runtime,tui-runtime-loader}.ts`, `core/src/environment.ts`,
   `bootstrap/src/app/{bundled-plugins,official-plugin-definitions}.ts`,
   `adapters/src/browser/index.ts`, i18n locales en-US/zh-CN,
   `rpc/src/logging-middleware.ts`, `services` credentialService +
   oauthCredentialRepo, `web` index.html + main.tsx, the five package.json
   build tweaks, `config/provider/zcode-builtin.json`. The CAPTCHA fix most
   likely lands under `services/src/model-provider/` (no local mods there).
4. `sh scripts/sync-vendor.sh v3.14.4` (ZCODE_REPO defaults to `../zcode`).
   Read the NOTICE lines; for a new upstream package extend the mapping
   lists, commit `vendor: track <pkgs> in the sync mapping` on main first,
   then re-run.
5. On main: `git merge vendor/upstream` — real merge commit, never squash;
   subject `Merge vendor/upstream: zcode v3.14.4 ...`. Keep the patch layer
   on conflicts; nothing to drop (the CAPTCHA fix touches no local patch).
6. `git tag vendor/v3.14.4` on the new vendor commit.
7. Update `ZCODE_VENDORED_REV` in `.github/workflows/release.yml` to the new
   full SHA (see Remaining work item 7).
8. Update the Baseline line in CONTEXT.md to `vendor/v3.14.4 (<short>)`.
9. Sanity: `sh build-all.sh`; `zh web` smoke test; grep the merged tree for
   the new captcha code; confirm the diff does not break the packages/web
   CI-overlay build contract.
10. Push `main` + `vendor/upstream` + the tag.

## Handy paths and commands

- Clean-env wrapper from this session: `/tmp/zh-clean-env.sh` (recreate from
  the snippet above; it just unsets every ZCODE_* var and execs).
- Run zh web locally (bundle path):
  `cd /tmp/zh-web-ws && bun .../packages/cli/dist/zcode.cjs web --port 4180 --no-open`
- Rebuild web dist locally (needs the ../zcode clone at 29628c9; note the
  clone was re-created 2026-10-01, so run `pnpm install` there first):
  rsync overlay per step 4 above.
- Rebuild server bundle + runtime: `bun packages/server/scripts/build.mjs`
  then `bun scripts/stage-server-runtime.mjs /tmp/zh-server-stage`.
