# zheadless

Zero-dependency headless browser automation toolkit, scaffolded from zcode
and stripped down to run on a minimal VPS (no browser binaries required for
the core build).

## Layout

- `packages/` — workspace packages (core, CLI, and support modules)
- `patches/` — dependency patches applied on install
- `build-all.sh` / `build-rest.sh` — build entry points

## Build

```sh
./build-all.sh
```

Requires [bun](https://bun.sh). Install dependencies first with `bun install`
if `node_modules/` is missing.

## Status

Work in progress. Watch this space.
