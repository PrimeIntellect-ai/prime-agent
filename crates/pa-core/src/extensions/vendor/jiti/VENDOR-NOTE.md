# Vendored jiti

jiti v2.7.0 (MIT, https://github.com/unjs/jiti), vendored as the
`jiti/static` dist files so the extension host runs the same module loader
the TS product uses (`packages/coding-agent/src/core/extensions/loader.ts`
`loadExtensionModule`: `createJiti` from `jiti/static`, `moduleCache: false`)
without an `npm install` at runtime or a network dependency in CI.

Contents: `lib/jiti-static.mjs`, `dist/jiti.cjs`, `dist/babel.cjs`
(the three files the static entry needs at runtime), plus `package.json` and
`LICENSE` for provenance and attribution. To update: download the jiti
release tarball, copy the same five files, and re-run the extension-host tests
(`cargo test -p pa-core extension`).

Materialized under `<agentDir>/extension-host/runtime-<sha256>/` at first use
(`script.rs`), next to the host script that imports it.

Provenance check: the vendored files are byte-identical to the official
`jiti-2.7.0.tgz` npm tarball (sha256-verified for all three runtime files;
the tarball's own dist carries a stale internal `rE: "2.6.1"` version
string - upstream's, not ours).
