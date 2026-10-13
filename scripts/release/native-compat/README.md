# Native installer compatibility assets

Shipped TypeScript native installers validate these paths before activating a
release and whenever validating an installed release for rollback. Rust ships
the real historical assets to preserve that contract. They are not loaded by
Rust's renderer or image implementation.

- `theme/prime.json` and `export-html/template.html` are unmodified from
  Prime Agent v0.9.8, commit `7d442aafa985f9342134fac16c2ef41f03fb45c1`, paths
  `packages/coding-agent/src/modes/interactive/theme/prime.json` and
  `packages/coding-agent/src/core/export-html/template.html`.
- `photon_rs_bg.wasm` and `PHOTON-LICENSE.md` are unmodified from
  `@silvia-odwyer/photon-node` 0.3.4, the dependency used by that release.
  Source: https://registry.npmjs.org/@silvia-odwyer/photon-node/-/photon-node-0.3.4.tgz
  Tarball SHA-256: `5a23015c1cd2c38e3c492dd96929985247b92f52d2ff0fb948d29edca52bc50a`.
  Wasm SHA-256: `10468181565c56004c867f3a4af96f89a0ef5a63a72f2b5fb12c1f1992a3615c`.

The assembler also supplies `package.json` for every release and copies the
maintained `install-rust.sh` to `install.sh`. The old updater keeps executing
its existing installer; the downloaded installer is not a migration hook.
The bundled installer is available for manual Rust installation/repair and
uses the Rust installer's arguments and environment contract.

Keep these wire-level file names unchanged while supporting those installers.
