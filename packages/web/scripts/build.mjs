// Bun.build replacement for the upstream vite build. packages/web is vendored
// as source and built in CI inside an upstream zcode checkout (pinned rev);
// the built dist is published as the zh web release asset. Run with bun:
//   bun packages/web/scripts/build.mjs [--outdir <dir>]
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const webRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(webRoot, "../..");
const outDir = (() => {
  const flagIndex = process.argv.indexOf("--outdir");
  if (flagIndex >= 0 && process.argv[flagIndex + 1]) return resolve(process.argv[flagIndex + 1]);
  return resolve(webRoot, "dist");
})();
const TAILWIND_VERSION = "4.2.2";

// ---------------------------------------------------------------------------
// 1. Tailwind pre-pass. The vite build used @tailwindcss/vite; the CLI is the
// same v4 compiler. Output is plain CSS (every @import and @plugin resolved),
// so Bun.build can bundle it as a static stylesheet.
// ---------------------------------------------------------------------------
const genCss = resolve(webRoot, ".build/tailwind.gen.css");
await mkdir(dirname(genCss), { recursive: true });
const tailwind = spawnSync(
  "bunx",
  [
    `@tailwindcss/cli@${TAILWIND_VERSION}`,
    // In the CI overlay the build runs inside the upstream monorepo checkout,
    // where packages/ui holds the shared UI sources.
    "-i",
    resolve(repoRoot, "packages", "ui", "src", "styles.css"),
    "-o",
    genCss,
  ],
  { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] },
);
if (tailwind.status !== 0) throw new Error(`tailwind css build failed (${tailwind.status})`);

// The generated CSS references KaTeX fonts with relative url(fonts/...);
// staging them next to the file lets Bun.build inline them into the bundle.
await cp(
  join(dirname(require.resolve("katex/dist/katex.min.css")), "fonts"),
  resolve(dirname(genCss), "fonts"),
  { recursive: true },
);

// ---------------------------------------------------------------------------
// 2. Build-time defines, replicating vite.config.ts.
// ---------------------------------------------------------------------------
const { version } = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
const { pickProductEndpointEnv, resolveRuntimeZCodeEndpointOrigin, resolveZaiOAuthClientId, resolveZaiOAuthOrigin } =
  await import(resolve(repoRoot, "packages/shared/src/zcodeEndpoint.ts"));
const env = process.env;
// Release runs pass ZCODE_BUILD_VERSION so the web UI reports the zh release
// version, matching the CLI bundle's convention.
const resolvedVersion = env.ZCODE_BUILD_VERSION?.trim() || version;
const zcodeEnv = env.ZCODE_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
const endpointEnv = { ...env, ZCODE_ENV: zcodeEnv };
const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);
const define = {
  __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
  __ZCODE_VERSION__: JSON.stringify(resolvedVersion),
  __ZCODE_COMMIT__: JSON.stringify(env.ZCODE_COMMIT || "unknown"),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
  "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
  "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
  "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
  "import.meta.env.VITE_CONVERSATION_SHARE_PREVIEW_MOCK": "false",
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  "import.meta.env.BASE_URL": '"/"',
};

const alias = {
  "@": resolve(repoRoot, "packages/ui/src"),
  "d3-path": resolve(repoRoot, "node_modules/d3-path/src/index.js"),
};

// ---------------------------------------------------------------------------
// 3. Plugins.
// ---------------------------------------------------------------------------
// `import x from "file?url"` must yield the runtime URL of a copied asset.
const urlPlugin = {
  name: "zh:url-suffix",
  setup(build) {
    build.onResolve({ filter: /\?url$/ }, (args) => {
      const target = args.path.slice(0, -"?url".length);
      // Relative specifiers resolve against the importer; bare specifiers come
      // from the monorepo node_modules (pdfjs-dist, @extend-ai/*).
      const resolved = target.startsWith(".") || target.startsWith("/")
        ? resolve(dirname(args.importer), target)
        : require.resolve(target, { paths: [repoRoot] });
      return { path: resolved, namespace: "url-asset" };
    });
    build.onLoad({ filter: /.*/, namespace: "url-asset" }, async (args) => ({
      contents: new Uint8Array(await Bun.file(args.path).arrayBuffer()),
      loader: "file",
    }));
  },
};

// Bun.build does not transform `new Worker(new URL("./x.ts", import.meta.url))`
// (verified on bun 1.4.2): the string survives verbatim and the worker is never
// emitted. Rewrite the known sites to static public paths and build the workers
// separately below. A failed replace means upstream changed the line; fail
// loudly instead of shipping a broken worker URL.
const workerRewrites = [
  {
    filter: /DiffsWorkerPoolProvider\.tsx$/,
    from: 'new URL("../workers/diffs.worker.ts", import.meta.url)',
    to: '"/workers/diffs.worker.js"',
  },
  {
    filter: /workspaceFileSearchFilterBackend\.ts$/,
    from: 'new URL("./workspaceFileSearchFilter.worker.ts", import.meta.url)',
    to: '"/workers/workspaceFileSearchFilter.worker.js"',
  },
  {
    filter: /UpdateStatusDialog\.tsx$/,
    from: 'new URL("../../../public/icon_512@2x.png", import.meta.url).href',
    to: '"/icon_512@2x.png"',
  },
];
const rewritePlugin = {
  name: "zh:worker-urls",
  setup(build) {
    for (const rule of workerRewrites) {
      build.onLoad({ filter: rule.filter }, async (args) => {
        const source = await Bun.file(args.path).text();
        if (!source.includes(rule.from)) {
          throw new Error(`zh:worker-urls: expected text not found in ${args.path}`);
        }
        return { contents: source.replaceAll(rule.from, rule.to), loader: "tsx" };
      });
    }
  },
};

// The UI stylesheet is precompiled by the tailwind CLI above; point the
// `@zcode/ui/styles.css` import at that file instead of the raw source.
const stylesPlugin = {
  name: "zh:ui-styles",
  setup(build) {
    build.onResolve({ filter: /^@zcode\/ui\/styles\.css$/ }, () => ({ path: genCss }));
  },
};

// ---------------------------------------------------------------------------
// 4. Main browser build (HTML entry, like vite).
// ---------------------------------------------------------------------------
await rm(outDir, { force: true, recursive: true });
const result = await Bun.build({
  entrypoints: [resolve(webRoot, "index.html")],
  outdir: outDir,
  target: "browser",
  format: "esm",
  splitting: true,
  minify: true,
  sourcemap: "none",
  define,
  alias,
  plugins: [urlPlugin, rewritePlugin, stylesPlugin],
});
if (!result.success) {
  for (const log of result.logs) console.error(String(log));
  throw new Error("bun build failed");
}

// ---------------------------------------------------------------------------
// 5. Worker bundles at the rewritten public paths.
// ---------------------------------------------------------------------------
const workerEntries = [
  // Entry code is never tree-shaken; the import-only diffs.worker.ts is (its
  // package does not mark worker.js as side-effectful, and Bun.build has no
  // treeshake toggle), so bundle the pierre worker module itself.
  [Bun.resolveSync("@pierre/diffs/worker/worker.js", [repoRoot]), "diffs.worker.js"],
  [
    resolve(repoRoot, "packages/ui/src/workspace-file-search/workspaceFileSearchFilter.worker.ts"),
    "workspaceFileSearchFilter.worker.js",
  ],
];
for (const [entry, name] of workerEntries) {
  const workerResult = await Bun.build({
    entrypoints: [entry],
    outdir: join(outDir, "workers"),
    naming: { entry: name },
    target: "browser",
    format: "esm",
    minify: true,
    sourcemap: "none",
    alias,
    plugins: [urlPlugin],
  });
  if (!workerResult.success) {
    for (const log of workerResult.logs) console.error(String(log));
    throw new Error(`worker build failed: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Static assets the vite build provided via plugins and public/.
// ---------------------------------------------------------------------------
// pdf.js CMaps (upstream pdfJsCMapsPlugin): copy every bcmap into dist.
const cmapsDir = join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps");
await cp(cmapsDir, join(outDir, "pdfjs", "cmaps"), { recursive: true });
// public/ (favicon.ico, material-icons) plus the dock icon the rewritten
// UpdateStatusDialog URL points at.
await cp(resolve(webRoot, "public"), outDir, { recursive: true });
await cp(resolve(repoRoot, "public/icon_512@2x.png"), join(outDir, "icon_512@2x.png"));
// Upstream thirdPartyNoticesVitePlugin: notices asset + license link.
await cp(resolve(repoRoot, "THIRD-PARTY-NOTICES.md"), join(outDir, "THIRD-PARTY-NOTICES.md"));
const htmlPath = join(outDir, "index.html");
let html = await readFile(htmlPath, "utf8");
html = html.replace(
  "<head>",
  '<head>\n    <link rel="license" href="/THIRD-PARTY-NOTICES.md" />',
);
await writeFile(htmlPath, html);

console.log(`zh web build done -> ${outDir}`);
