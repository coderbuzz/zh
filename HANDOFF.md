# Handoff: zh web mobile fixes (drawer, boot auto-reload, section navbar), session 2026-10-02

Read CONTEXT.md first. This round audited why zh web lacks desktop-app features
and shipped three mobile fixes in packages/web only — no new @zcode/ui patches.
Released as v0.5.3.

## Audit conclusions (do not re-litigate)

- zh web is built from the newest PUBLIC upstream tag, v3.14.3
  (`ZCODE_VENDORED_REV` = 29628c9; `zai-org/ZCode` origin HEAD and tag list
  still stop at v3.14.3 as of 2026-10-02). The desktop app and the
  zcode.z.ai/remote/v4 controller run v3.14.4, built 2026-09-29 from commit
  `10bbcea5` (app.asar `build-meta.json`) which does not exist in the public
  repo. The app.asar has no sourcemaps (the `.ts` files inside are third-party
  node_modules); it is usable as a behavior reference only. Missing features
  are version gaps, not zh bugs:
  - Trust Build daily claim card = upstream `manualClaimPlan` (banner, claim
    ticket dialog, share sheet, billing API `/api/v1/zcode-plan/billing/preview`,
    desktop host action `claim_zcode_plan`). Zero occurrences in v3.14.3 source
    or the zh dist. Decision: wait for the v3.14.4 vendor sync; do not port
    from the minified bundle.
  - Message action row (copy/like/dislike/fork/time) EXISTS in 3.14.3 but is
    hover-only (`group-hover/assistant-turn:opacity-100`); 3.14.4 adds
    `compactForRemoteControl` which keeps it visible in the remote surface.
  - 3.14.4 also ships a `WebRemoteControlMobileShell` (phone home/chat pages,
    `webRemoteControl.mobileShell.*` i18n, history back support); the interim
    drawer glue below is meant to be dropped when the vendor sync lands.

## Fixes in this release

- `packages/web/src/mobileShell.ts`: the drawer closes on tapping navigating
  sidebar entries (`[data-testid^="task-item-"]`, `conversation-new-task`,
  `automations-open`, `plugin-store-sidebar-open`) via a capture-phase click
  listener that dispatches the existing `zh:close-sidebar` event; taps on inner
  row buttons (pin/archive/menu triggers) are ignored. Workspace rows
  deliberately do NOT close: their tap expands the workspace task list, which
  the user still needs on screen.
- `packages/web/src/mobileShell.css`: on `(hover: none) and (pointer: coarse)`
  the hover-revealed action rows (copy/like/fork/time under assistant turns,
  edit under user rows) are always visible, mirroring 3.14.4's
  compactForRemoteControl behavior on touch until the sync lands.
- `packages/web/src/mobileShell.css`: while a section main is mounted
  (`#automations-main-toast-anchor` or `[data-testid="plugin-store-root"]`),
  the floating top overlay becomes a solid full-width navbar and the section
  main gets 56px (`h-14`) padding-top. Root cause: the section breadcrumb row
  renders only when `isDesktop` (AutomationsMainBreadcrumbFrame), and on phones
  the shell main area is full width because the sidebar is a drawer. On the
  chat view neither marker exists and the overlay keeps the upstream floating
  style. CSS gotchas verified the hard way: nested `:has()` is invalid and
  silently dropped (single-level `:has` only), and the section scopes are
  `ScopedErrorBoundary`, not keep-alive, so they really unmount on navigation.
- `packages/web/src/main.tsx`: a failed web bootstrap (WebSocket connect) now
  auto-reloads after 1s within a budget of 3 reloads per 60s, tracked in
  sessionStorage (`zh:web-bootstrap-reloads`); past the budget the error card
  with manual Retry stays, and a successful boot clears the counter. Cause:
  mobile browsers park background tabs and drop the WebSocket; when Chrome
  restores the tab the boot connect races the network stack coming back up.

## Verification

- `bunx oxlint` clean on all three files; `tsc --noEmit --noResolve` shows no
  errors in the added code. Repo suite `bun test packages/services/test/`:
  14 pass / 0 fail (clean env).
- Runtime matrix in a real browser (in-app Chrome, 390x844 viewport) against
  the bun-built bundle: drawer closes on task row and nav entries, does not
  close on inner row buttons / workspace row / plain areas, works repeatedly;
  after close the mirror clears and the scrim hides. Guard: 13/13 assertions
  including a real page reload fired by the guard itself; budget exhaustion,
  stale-window reset, and clear-on-success all verified.
- CSS fixture: 9/9 across section-open (navbar + offsets) and chat-view
  (floating overlay restored) states.
- Not yet verified on a physical phone (needs the deploy of this release):
  park zh.coderbuzz.dev and return — it should reload itself without the error
  card; open Automations / Plugin Marketplace — title sits below the navbar and
  scrolling stays clear of the overlay icons.

---

# Handoff: zh web OAuth callback fix, session 2026-10-02 (build VM + Mac)

Status for the production bug found 2026-10-01 ~22:11 WIB (Z.ai browser login
in zh web mode pends forever). Read CONTEXT.md first. The previous handoff
(zh web, session 2026-09-29, plus the pending v3.14.4 sync runbook) follows
below, unchanged and still current.

## Status update, Mac session 2026-10-02: merged, released as v0.5.2, deployed

Everything is done except the real-account login step (needs the owner's
Z.ai credentials in a browser):

- Merged: PR #34 squash-merged to main as f7cc6c49
  (`fix: keep server-provided OAuth callback URL in zh web login (#34)`);
  branch deleted.
- Mac build: `sh build-all.sh` with every `ZCODE_*` desktop var stripped
  (14 leaked vars found and unset) — all packages OK. `bun test
  packages/services/test/`: 14 pass / 0 fail, including the 4 tests in
  `oauthPollingAuthorizeUrl.test.ts`.
- Release: PR #35 bumped the root version to 0.5.2; tag `v0.5.2` pushed at
  b52b88b8; release workflow completed and published all assets, including
  `zheadless-web-v0.5.2.tar.gz` (SHA256SUMS-verified before deploy).
- Deploy: the deployment VM is `indra@34.168.150.46` (host
  instance-20260813-081715); `zh-web.service` is a USER service
  (`systemctl --user`), port 8787, install root `~/.local/share/zheadless`.
  Redeployed by stopping the service, replacing `web/` + `server/` from the
  released web asset, and restarting. Verified: service active; `/` 200;
  `/api` and `/ws` 401 without token; token via `?token=` passes the gate
  (Bearer header is not how the server validates — see `hasValidLiteToken` in
  `packages/server/src/http.ts`). The deployed `entry-http.js` has 0 hits for
  the `redirect_uri`/`redirect` rewrites and keeps the intentional
  `zcode://oauth/callback` (3x) + `/app/oauth/login` (1x) deep-link
  literals. `entry-http.js.bak-oauthcb-20261001` is deleted (went with the
  replaced `server/` dir). Note: the unit Description still says v0.5.1
  (cosmetic), and the VM's agent bundle `dist/zcode.cjs` is still v0.5.1 —
  harmless for this fix, which lives in the server bundle.
- Real-browser E2E on the Mac (isolated: `ZCODE_DATA_BASE_DIR=/tmp/zh-e2e-oauth`,
  `bin/zh web --host 127.0.0.1 --port 4193 --no-open`): clicking Connect to
  Z.ai starts polling and the browser tab opens
  `https://chat.z.ai/auth?...redirect_uri=https%3A%2F%2Fzcode.z.ai%2Fapi%2Fv1%2Foauth%2Fcli%2Fcallback%2Fzai&state=...`
  — the official callback, nothing rewritten, state intact. COMPLETED
  2026-10-02 ~08:26 WIB with the owner's real Z.ai account: flow started
  08:26:31, `OAuth polling flow completed { provider: 'zai' }` logged at
  08:26:36 (5.6 s — the old build pended forever here), credentials.json in
  the isolated store gained the `oauth:zai` session + active provider, and
  the UI left the welcome gate for the onboarding wizard in the same tab
  without a manual reload. Also clean-room verified with OrbStack
  (node:22-slim): the released `zheadless-web-v0.5.2.tar.gz` boots alone,
  serves the UI, enforces the 401 posture, and passes the authorize URL
  through byte-identical — the asset is self-contained. (Container note:
  accessing a token-protected server without `?token=` shows "Web bootstrap
  failed / WebSocket connection failed" by design; the lite token comes from
  the query param.) The E2E server with its isolated data dir
  (/tmp/zh-e2e-oauth) was left running on port 4193 for the owner to try.

## Status (from the build VM session): fix implemented, verified, pushed on `fix/web-oauth-callback`

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

## Remaining work for the Mac session (all done 2026-10-02, see status update above)

1. ~~`sh build-all.sh` on the Mac~~ done.
2. ~~Open the PR for `fix/web-oauth-callback`, squash-merge~~ done (PR #34).
3. ~~Real-browser E2E~~ done — full login with the real account completed
   2026-10-02 ~08:26 WIB; polling resolved in 5.6 s and the UI flipped to
   logged in without a reload.
4. ~~Deploy + delete `entry-http.js.bak-oauthcb-20261001`~~ done.
5. ~~Bump the root version~~ done (v0.5.2, PR #35).

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
