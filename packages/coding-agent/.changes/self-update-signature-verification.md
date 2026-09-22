Self-updates now require a cosign signature. `prime-agent update` verifies a Sigstore bundle over
`SHA256SUMS` before it trusts any digest, with the signer pinned to the Prime Intellect repository,
the release workflow file and an allowed ref. A missing, broken or foreign signature refuses the
update and keeps the installed version.

`PRIME_AGENT_DOWNLOAD_BASE_URL` can still move the download origin for development, but it no longer
weakens anything: it must be a bare https URL (no credentials, query string or fragment; a trailing
slash is dropped), verification and the pinned identity are unchanged, and release URLs are built
from it with the URL API. Before the installer runs, `prime-agent update` now prints the signer
identity (repository, workflow and ref) the checksums were verified against and, when the override
is in effect, a warning naming the origin the files are fetched from. A recorded install source
with the same defects refuses the update instead of producing a malformed request.

Homebrew and npm copies are detected correctly. A compiled binary installed in a Homebrew keg now
reports `homebrew` and is updated with `brew upgrade prime-agent` instead of overwriting the keg; a
compiled binary installed under `node_modules` reports `npm`.
