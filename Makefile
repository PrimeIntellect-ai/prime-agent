# Merge gate (AGENTS.md): fmt + clippy + test + release build must pass before every merge.
check:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	cargo build --release --workspace


# Supply-chain gates (docs/installer-ci-design.md §7/§9) — local mirrors of the
# ci.yml workflow jobs. They fail loudly when the tool is missing instead of
# silently skipping the gate.

deny:
	@command -v cargo-deny >/dev/null 2>&1 || { echo "cargo-deny not installed (cargo install cargo-deny --locked)"; exit 1; }
	cargo deny --all-features --workspace check advisories licenses

# Windows cfg-hygiene gate (docs/windows-readiness.md): cross-target check +
# clippy at -D warnings for every crate and test, the local mirror of the
# staged ci.yml windows-cross job. Fails loudly when the target is missing
# instead of silently skipping the gate.
windows-cross:
	@rustup target list --installed | grep -q x86_64-pc-windows-gnu || { echo "x86_64-pc-windows-gnu target not installed (rustup target add x86_64-pc-windows-gnu)"; exit 1; }
	cargo check --workspace --target x86_64-pc-windows-gnu --all-targets
	cargo clippy --workspace --target x86_64-pc-windows-gnu --all-targets -- -D warnings

# Lints the live + staged workflow files (see ci/workflows/README.md for
# why part of the set is still staged).
actionlint:
	@command -v actionlint >/dev/null 2>&1 || { echo "actionlint not installed (see rhysd/actionlint releases)"; exit 1; }
	actionlint .github/workflows/ci.yml .github/workflows/continuous.yml .github/workflows/release.yml ci/workflows/ci.yml ci/workflows/benchmark.yml

# Perf wave + regression gate (benchmark.yml job, the local mirror): runs the
# TS binary and a fresh release build side by side in a fresh Prime sandbox
# (both sides on one quiet machine, the methodology BENCHMARKS.md requires)
# and gates the rust medians against scripts/battery/perf-baseline.json.
# PA_BENCH_NO_SANDBOX=1 runs it on the bare runner instead.
perf-wave:
	scripts/battery/ci_perf_wave.sh

# Local mirror of the release build-job gates (docs/installer-ci-design.md §9):
# release build against the committed lockfile, deterministic tarball assembly,
# then end-to-end verification of the host-target artifact. The vendored
# prime-agent-runtime/ at the repo root is the default runtime sidecar
# (kernel-packaging lane); pass RUNTIME_DIR to re-anchor it.
VERSION := $(shell sed -n 's/^version *= *"\([^"]*\)".*/\1/p' Cargo.toml | head -1)
TARGET := $(shell rustc -vV | sed -n 's/^host: //p')
RUNTIME_DIR ?=
RUNTIME_FLAG = $(if $(RUNTIME_DIR),--runtime-dir $(RUNTIME_DIR),)

# Bundled catalog assets (catalog spec §3.2 layer 2): generated at build
# time, never committed. CI generates the offline fixture snapshot (it passes
# the full packer gates: >= 42 transport tuples, >= 68 services) so builds
# never depend on the catalog repo being reachable; CATALOG_ASSETS_MODE=network
# switches the dry-runs to the live fetch for packaging parity.
CATALOG_ASSETS_DIR = target/catalog-assets
CATALOG_ASSETS_MODE ?= fixture
CATALOG_ASSETS_FLAG = --catalog-assets $(CATALOG_ASSETS_DIR)

# Live-catalog asset generation (network fetch; packaging parity with the
# TS release flow — CI itself uses the fixture snapshot for reliability).
catalog-assets:
	python3 scripts/release/bundle_catalog.py generate --network --out $(CATALOG_ASSETS_DIR)

# Offline asset generation: the synthetic full-gate fixture snapshot.
catalog-assets-fixture:
	python3 scripts/release/bundle_catalog.py generate --fixture --out $(CATALOG_ASSETS_DIR)

release-dry-run:
	cargo build --release --locked --workspace
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/release/assemble_artifacts.py \
		--repo-root . --version "$(VERSION)" --target "$(TARGET)" $(RUNTIME_FLAG) \
		$(CATALOG_ASSETS_FLAG) --out-dir target/release/dist
	python3 scripts/release/verify_release.py \
		--dist-dir target/release/dist --version "$(VERSION)" --target "$(TARGET)"

# Local mirror of the continuous.yml build job (docs/installer-ci-design.md §9):
# same release build, but commit-stamped: the tarball carries a package.json
# version manifest and the binary must report "<version>-continuous.<sha>".
GIT_SHA := $(shell git rev-parse HEAD)

continuous-dry-run:
	cargo build --release --locked --workspace
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/release/assemble_artifacts.py \
		--repo-root . --version "$(VERSION)" --target "$(TARGET)" $(RUNTIME_FLAG) \
		--sha "$(GIT_SHA)" $(CATALOG_ASSETS_FLAG) --out-dir target/release/dist
	python3 scripts/release/verify_release.py \
		--dist-dir target/release/dist --version "$(VERSION)" --target "$(TARGET)" \
		--sha "$(GIT_SHA)"

# Optional hardening: embed the dependency list in the binary for incident
# response (docs/installer-ci-design.md §7).
audit-build:
	@command -v cargo-auditable >/dev/null 2>&1 || { echo "cargo-auditable not installed (cargo install cargo-auditable --locked)"; exit 1; }
	cargo auditable build --release --locked --workspace

# Packaging dry-run: stage the exe-adjacent release layout, version-pin,
# hash, and tar the artifact under target/release-package. Generates the
# bundled catalog assets first (same modes as the dry-runs above).
package:
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/package_release.py $(CATALOG_ASSETS_FLAG)

# Bundled-catalog gates (scripts/release/test_catalog_assets.py): the
# offline fixture passes the full packer validation, the packer hard-fails
# on missing/invalid assets, network mode is verified against a local HTTP
# server, and the assets land in the tarball layout the installer expects.
catalog-assets-gates:
	python3 scripts/release/test_catalog_assets.py

# OPERATOR STEP (Kevin): promote the staged workflows to .github/workflows/.
# Needs a push credential with the GitHub `workflow` scope — run from a
# machine that has it (the dev box's token does NOT; a scoped-token push gets
# remote-rejected). Requires a clean `main` checkout; pushes straight to main.
activate-workflows:
	@git rev-parse --abbrev-ref HEAD | grep -qx main || { echo "run on a main checkout (got $$(git rev-parse --abbrev-ref HEAD))"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "main has uncommitted changes; commit or stash first"; exit 1; }
	git pull --ff-only
	git mv ci/workflows/continuous.yml ci/workflows/release.yml .github/workflows/
	git commit -m "ci: activate the continuous + release workflows (.github/workflows/)"
	git push origin main
	@echo "workflows live: verify with gh workflow list (continuous + release active)"

.PHONY: check deny windows-cross actionlint perf-wave release-dry-run continuous-dry-run audit-build package activate-workflows catalog-assets catalog-assets-fixture catalog-assets-gates
