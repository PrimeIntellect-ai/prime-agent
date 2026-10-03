# Merge gate (AGENTS.md): fmt + clippy + test + release build must pass before every merge.
check:
	cargo fmt --all --check
	cargo clippy --workspace --all-targets -- -D warnings
	cargo test --workspace
	cargo build --release --workspace


# Supply-chain gates — local mirrors of the
# ci.yml workflow jobs. They fail loudly when the tool is missing instead of
# silently skipping the gate.

deny:
	@command -v cargo-deny >/dev/null 2>&1 || { echo "cargo-deny not installed (cargo install cargo-deny --locked)"; exit 1; }
	cargo deny --all-features --workspace check advisories licenses

# Windows cfg-hygiene gate: cross-target check +
# clippy at -D warnings for every crate and test, the local mirror of the
# ci.yml windows-cross job (.github/workflows/ci.yml). Fails loudly when the
# target is missing instead of silently skipping the gate.
windows-cross:
	@rustup target list --installed | grep -q x86_64-pc-windows-gnu || { echo "x86_64-pc-windows-gnu target not installed (rustup target add x86_64-pc-windows-gnu)"; exit 1; }
	cargo check --workspace --target x86_64-pc-windows-gnu --all-targets
	cargo clippy --workspace --target x86_64-pc-windows-gnu --all-targets -- -D warnings

# Windows MSVC cross-check: the release target's own triple (release.yml's
# build-windows job builds x86_64-pc-windows-msvc natively on windows-2022;
# this gate type-checks the same target from a linux host). The check form
# needs MSVC-side C tooling for the native build scripts (ring): cargo-xwin
# wraps the build with the MSVC CRT + clang-cl/llvm-lib, so the gate fails
# loudly when cargo-xwin (or the llvm tools) is missing instead of silently
# skipping. The gnu gate above stays the cheap cfg-hygiene mirror; the
# authoritative msvc build runs on the windows runner.
windows-msvc-cross:
	@rustup target list --installed | grep -q x86_64-pc-windows-msvc || { echo "x86_64-pc-windows-msvc target not installed (rustup target add x86_64-pc-windows-msvc)"; exit 1; }
	@command -v cargo-xwin >/dev/null 2>&1 || { echo "cargo-xwin not installed (cargo install cargo-xwin --locked; it provisions the MSVC CRT + expects clang-cl/llvm-lib on PATH)"; exit 1; }
	cargo xwin check --workspace --target x86_64-pc-windows-msvc --all-targets

# Lints every workflow file (.github/workflows/ is the one home for
# workflow files).
actionlint:
	@command -v actionlint >/dev/null 2>&1 || { echo "actionlint not installed (see rhysd/actionlint releases)"; exit 1; }
	actionlint .github/workflows/ci.yml .github/workflows/codebase-health.yml .github/workflows/contribution-gate.yml \
		.github/workflows/continuous.yml .github/workflows/release.yml .github/workflows/windows-runtime-triage.yml \
		.github/workflows/release-prepare.yml .github/workflows/nightly.yml

# GLIBC baseline gate (the continuous.yml/release.yml build-gnu jobs): a
# GNU/Linux artifact must not require symbols above GLIBC_2.35, the Ubuntu
# 22.04 release baseline. No-op on non-GNU hosts; the authoritative gate runs
# in CI on the Ubuntu 22.04 sandbox runners. POSIX sh throughout: make
# runs recipes with /bin/sh, which is dash on Ubuntu (no [[ ]], no ==).
glibc-gate:
	@case "$(TARGET)" in *-linux-gnu) \
		if ! objdump -T "$(GLIBC_BINARY)" >/dev/null 2>&1; then \
			echo "glibc-gate: unable to inspect $(GLIBC_BINARY) with objdump (build and split first)" >&2; exit 1; \
		fi; \
		syms="$$(objdump -T "$(GLIBC_BINARY)" | grep -o 'GLIBC_[0-9.]*' || true)"; \
		if [ -z "$$syms" ]; then \
			echo "glibc-gate: no GLIBC symbols found in $(GLIBC_BINARY) - refusing to pass without evidence" >&2; exit 1; \
		fi; \
		max_glibc="$$(printf '%s\n' "$$syms" | sort -Vu | tail -1)"; \
		echo "highest GLIBC symbol required: $${max_glibc}"; \
		top="$$(printf '%s\nGLIBC_2.35\n' "$$max_glibc" | sort -Vu | tail -1)"; \
		if [ "$$top" != "GLIBC_2.35" ]; then \
			echo "binary requires $${max_glibc}, above the GLIBC_2.35 (Ubuntu 22.04) baseline" >&2; exit 1; \
		fi \
		;; esac

# Local mirror of the release build-job gates:
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

# Mirror the Linux CI split: Cargo's executable remains unstripped and the
# archive receives a separate shipped ELF plus its detached decoder.
ifneq ($(filter %-unknown-linux-gnu,$(TARGET)),)
RELEASE_BINARY = target/release/dist/prime-agent
RELEASE_DECODER = target/release/dist/prime-agent-$(VERSION)-$(if $(filter aarch64-%,$(TARGET)),linux-arm64,linux-x64).debug.gz
RELEASE_ASSEMBLE_FLAGS = --binary $(RELEASE_BINARY) --decoder $(RELEASE_DECODER)
RELEASE_SPLIT = python3 scripts/release/split_debug.py --binary target/release/prime-agent --shipped $(RELEASE_BINARY) --out target/release/dist --version "$(VERSION)" --target "$(TARGET)"
RELEASE_VERIFY_DECODER = python3 scripts/release/verify_decoders.py target/release/dist
RELEASE_PACKAGE_BUILD = cargo build --release --locked --workspace
RELEASE_PACKAGE_FLAGS = --binary $(RELEASE_BINARY) --decoder $(RELEASE_DECODER) --skip-build
GLIBC_BINARY = $(RELEASE_BINARY)
else
RELEASE_ASSEMBLE_FLAGS =
RELEASE_SPLIT = :
RELEASE_VERIFY_DECODER = :
RELEASE_PACKAGE_BUILD = :
RELEASE_PACKAGE_FLAGS =
endif

# Live-catalog asset generation (network fetch; packaging parity with the
# TS release flow — CI itself uses the fixture snapshot for reliability).
catalog-assets:
	python3 scripts/release/bundle_catalog.py generate --network --out $(CATALOG_ASSETS_DIR)

# Offline asset generation: the synthetic full-gate fixture snapshot.
catalog-assets-fixture:
	python3 scripts/release/bundle_catalog.py generate --fixture --out $(CATALOG_ASSETS_DIR)

release-dry-run:
	cargo build --release --locked --workspace
	$(RELEASE_SPLIT)
	$(MAKE) glibc-gate
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/release/assemble_artifacts.py \
		--repo-root . --version "$(VERSION)" --target "$(TARGET)" $(RUNTIME_FLAG) \
		$(RELEASE_ASSEMBLE_FLAGS) $(CATALOG_ASSETS_FLAG) --out-dir target/release/dist
	$(RELEASE_VERIFY_DECODER)
	python3 scripts/release/verify_release.py \
		--dist-dir target/release/dist --version "$(VERSION)" --target "$(TARGET)"

# Local mirror of the continuous.yml build job:
# same release build, but commit-stamped: the tarball carries a package.json
# version manifest and the binary must report "<version>-continuous.<sha>".
GIT_SHA := $(shell git rev-parse HEAD)

continuous-dry-run:
	cargo build --release --locked --workspace
	$(RELEASE_SPLIT)
	$(MAKE) glibc-gate
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/release/assemble_artifacts.py \
		--repo-root . --version "$(VERSION)" --target "$(TARGET)" $(RUNTIME_FLAG) \
		--sha "$(GIT_SHA)" $(RELEASE_ASSEMBLE_FLAGS) $(CATALOG_ASSETS_FLAG) --out-dir target/release/dist
	$(RELEASE_VERIFY_DECODER)
	python3 scripts/release/verify_release.py \
		--dist-dir target/release/dist --version "$(VERSION)" --target "$(TARGET)" \
		--sha "$(GIT_SHA)"

# Optional hardening: embed the dependency list in the binary for incident
# response.
audit-build:
	@command -v cargo-auditable >/dev/null 2>&1 || { echo "cargo-auditable not installed (cargo install cargo-auditable --locked)"; exit 1; }
	cargo auditable build --release --locked --workspace

# Packaging dry-run: stage the exe-adjacent release layout, version-pin,
# hash, and tar the artifact under target/release-package. Generates the
# bundled catalog assets first (same modes as the dry-runs above).
package:
	$(RELEASE_PACKAGE_BUILD)
	$(RELEASE_SPLIT)
	python3 scripts/release/bundle_catalog.py generate --$(CATALOG_ASSETS_MODE) --out $(CATALOG_ASSETS_DIR)
	python3 scripts/package_release.py $(RELEASE_PACKAGE_FLAGS) $(CATALOG_ASSETS_FLAG)

# Bundled-catalog gates (scripts/release/test_catalog_assets.py): the
# offline fixture passes the full packer validation, the packer hard-fails
# on missing/invalid assets, network mode is verified against a local HTTP
# server, and the assets land in the tarball layout the installer expects.
catalog-assets-gates:
	python3 scripts/release/test_catalog_assets.py

# The changelog fold's contract battery (RELEASE-FLOW-PROPOSAL.md §8): the
# fold is the release-PR's changelog half, and the pathspec security case is
# first - a fragment NAME is data, never a git pathspec, so no root-level
# markdown file can ever become a fold deletion candidate.
fold-gates:
	python3 scripts/release/test_fold_changelog.py

# The consume route's restamp battery (release.yml's beta channel): the
# continuous artifacts restamped to the beta version keep the built bytes
# and carry the release shape - the provenance case is first (a foreign
# commit's artifacts are refused).
restamp-gates:
	python3 scripts/release/test_restamp.py

# The CI shard tooling's contract battery (ci.yml's PR smoke): the stable
# crc32 assignment under the narrowed selection, the scope-aware summary
# audit, the selection resolver the conditional bins build reads, and the
# fail-safe PR-files mapping the changes job feeds it.
shard-gates:
	python3 scripts/test_ci_test_shard.py
	python3 scripts/test_ci_pr_crates.py

# The sandbox-runner provisioning contract battery (scripts/ci/
# register_runner.sh): the security case is first - the registration values
# reach config.sh as argv and the supervisor script path reaches su as
# argv, never as interpolated shell source, and the -- on both su
# invocations keeps a leading-dash value from becoming su's own option.
runner-gates:
	python3 scripts/ci/test_register_runner.py

.PHONY: check deny windows-cross actionlint glibc-gate release-dry-run continuous-dry-run audit-build package catalog-assets catalog-assets-fixture catalog-assets-gates fold-gates restamp-gates shard-gates runner-gates
