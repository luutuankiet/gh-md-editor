---
symptom: "after git pull the dev server page never gets past its loading skeleton, and the network tab shows a 500 for a src/lib file"
area: dev environment / Vite
verified: 2026-11-12
---

# The dev app hangs on its skeleton after pulling

## Symptom

`npm run dev:server` starts, the page paints its boot skeleton and stays there.
Nothing in the page says why. The browser's network tab shows one module from
`src/` answered with **500**; the first time this happened it was
`src/lib/lsp/client.ts`. The reason is only in the terminal running Vite:

```text
[vite] Internal server error: Failed to resolve import "@codemirror/lsp-client" from "src/lib/lsp/client.ts". Does the file exist?
  Plugin: vite:import-analysis
```

On a fresh dependency scan Vite also prints, once, at startup:

```text
Error: The following dependencies are imported but could not be resolved:

  @codemirror/lsp-client (imported by .../src/lib/lsp/client.ts)

Are they installed?
```

## Mechanism

A pull brought in a commit that added a dependency to `package.json`, and
`node_modules` was not reinstalled. The skeleton in `server/web/index.html` is
inline HTML that paints before any script, and it is only hidden once the Svelte
app mounts into its sibling. One unresolvable import anywhere in the module graph
stops the app from mounting, so the skeleton stays up indefinitely with no
in-page error.

**It can hide for a while.** Vite's pre-bundle cache
(`server/node_modules/.vite/deps`) may still hold a copy of the package from an
earlier install; while it does, the module is served from the cache and
everything works. Reproduced on 2026-11-12: with the package removed from
`node_modules`, a dev server on the warm cache served `client.ts` with 200; the
same server started with `--force` answered 500 with the error above.

## Fix

```text
npm install
```

Then restart every running Vite dev server, so it scans its dependencies again.

## How to verify

Request the module the network tab flagged straight from the dev server and
expect 200. Files outside the Vite root are served under `/@fs/`:

```text
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:<port>/@fs$PWD/src/lib/lsp/client.ts"
```
