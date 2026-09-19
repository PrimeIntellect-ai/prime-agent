`prime-agent update` resolves the running executable through every symlink before it decides who
owns it. A Homebrew copy invoked through `<prefix>/bin/prime-agent` (a link into the Cellar) is now
refused with `brew upgrade prime-agent` like a copy invoked from the keg itself; previously the
unresolved path passed the Homebrew check and the self-updater could have rewritten the keg.

The signed `SHA256SUMS` and its `SHA256SUMS.sigstore.json` bundle are downloaded under hard size
caps (1 MiB and 4 MiB): a `Content-Length` above the cap is refused before the body is read, and a
chunked or mislabelled body is cut off the moment it passes the cap, so a download origin can no
longer make the updater buffer an unbounded response.

`prime-agent update --rollback` works again for an installation whose recorded `.install-source` is
a legacy `http:` origin. A rollback downloads nothing, so the recorded origin is no longer validated
on that path; an ordinary update from the same source is still refused with a clear error. An origin
override equal to the recorded source is no longer reported as an override.

For CI only, `scripts/build-binary.mjs --test-signer-json <file>` compiles a test binary that pins
the signer described in the file instead of the production release signer, writes it to
`binaries-test-signer/` rather than the release output, and marks every signer line `prime-agent
update` prints with `(test signer override)`. Release builds always compile the override as `null`;
there is no runtime input (environment, file or flag) that can set it.
- Changed `prime-agent update` to refuse an invalid `PRIME_AGENT_DOWNLOAD_BASE_URL` instead of silently falling back to the npm registry package.
- Changed `prime-agent update` to route a compiled binary that npm or Homebrew installed through that package manager instead of the self-updater, and to recognise a Homebrew keg only under a real Homebrew prefix or with brew's install receipt.
- Added release signature verification to the installer: `install.sh` now requires `SHA256SUMS.sigstore.json`, verifies it with cosign when available, and honours `PRIME_AGENT_REQUIRE_SIGNATURE=1`.
- Changed `prime-agent update` to accept a valid `PRIME_AGENT_DOWNLOAD_BASE_URL` override even when the recorded install origin is a legacy `http:` source, instead of forcing a reinstall.
