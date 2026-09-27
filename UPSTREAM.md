# Upstream components

Just Type IME (就打个字) does not fetch the engine or dictionaries at runtime (its only
network access is the optional update reminder; see README "Network use"). The RIME engine and the
pinyin schemas are bundled into `main.js` at build time, which means this
repository and every release **redistribute** the upstream artifacts listed below.

- Project: My RIME
- Version: 0.10.9
- Source: https://github.com/LibreService/my_rime/tree/c73ea172d28f07031ba87a1d71c4d2e1c8ba82a3
- Package: https://www.npmjs.com/package/@libreservice/my-rime/v/0.10.9
- License: AGPL-3.0-or-later

The unmodified production Worker is `src/vendor/my-rime-worker.txt`, copied from
the npm package's `dist/worker.js`. Its engine files (`rime.js`, `rime.wasm`,
`rime.data`) and the schema packages are fetched at build time by
`scripts/fetch-assets.mjs`; their source URLs and sha256 digests are recorded in
`src/assets/ASSETS.json`.

A resolver injected ahead of the Worker rewrites `importScripts`, `fetch`, and
`XMLHttpRequest.open` to local Blob URLs, and fails loudly rather than falling
back to the network.

The Worker is otherwise unmodified except one fail-loud substitution:
`pinyin_simp`'s dependency list `bi=["stroke"]` becomes `bi=[]`. The product
does not use stroke reverse lookup; keeping that edge would pull in `luna_pinyin`.
The substitution must match exactly once or startup throws.

`pinyin_simp.schema.yaml` is trimmed the same way at fetch time (see
`scripts/fetch-assets.mjs`). Upstream bytes are pinned in
`src/assets/assets.lock.json`.

For the full list of bundled third-party works and their licenses, see
`THIRD_PARTY_NOTICES.md`.
