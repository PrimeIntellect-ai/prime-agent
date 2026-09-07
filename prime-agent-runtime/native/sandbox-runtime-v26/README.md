# Sandbox runtime V26 Bun entry patch

This directory contains the Linux/x86-64 raw entry prelude and fail-closed ELF patcher for one official Bun 1.4.0 input. Its four production patch-pipeline inputs are `prelude.S`, `prelude.bin`, `patch_bun_elf.py`, and this README. The offline probe and supervisor live under `prime-agent-runtime/test/fixtures/sandbox-runtime-v26/`.

The patcher accepts only Bun SHA-256 `33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b`. It validates the complete ELF header, all nine program headers, the interpreter, and both pinned records in the sole `PT_NOTE`. The note bytes remain mapped by the original read-only `PT_LOAD`. The patch changes only `e_entry` and that program-header record, then appends the bound prelude in a congruent, non-overlapping RX `PT_LOAD`. It never modifies the input.

`prelude.bin` is a checked-in template. It contains one exact 32-byte coding-digest sentinel. A release authority must pass a lowercase SHA-256 with `--coding-script-sha256`. The builder hashes the supplied script bytes, requires an exact match, substitutes that digest once in an owned copy of the template, and leaves the checked-in template unchanged. It rejects malformed digests, mismatches, missing or repeated sentinels, and digest collisions. The canonical manifest binds the authorized and observed script digest, fixed install path, size, template and bound-prelude hashes, assembly-source hash, and builder and patcher hashes.

`prelude.S` is a raw-syscall `_start`. It saves the initial stack, RFLAGS, and every general-purpose register. Before the jump to Bun's original entry it checks dumpability, exact argv, an empty environment, `AT_SECURE`, root-owned non-writable path prefixes and coding script, secure-exec identities, groups, every capability vector through target `cap_last_cap=40`, cwd and session facts, `PR_SET_PTRACER`, no-new-privileges, and the same-thread parent-death sequence. It permanently drops gid 65533. It seals descriptors above fd 3, validates fd 3 as the one connected UNIX seqpacket control socket, and compares the `fstat` device and inode identity of fds 0, 1, and 2 against fd 3. Any duplicate fails with exit 126.

The prelude receives the fresh 32-byte challenge and 32-byte launch nonce in the canonical `PARIPV25` 48-byte frame. It builds the exact 128-byte HELLO body with both values, the release-authorized coding digest, live process facts, and `/proc/self/stat` start time. It then accepts the exact credentialed READY frame. Every receive requires one root-parent `SCM_CREDENTIALS`. The parser closes received rights before rejecting malformed or surplus ancillary data. Every failure closes fd 3 and calls `exit_group(126)` without output. fd 3 remains open and CLOEXEC when control jumps to Bun.

There is no native first-stage split. The dynamic loader still runs before artifact entry because the input is a dynamic ELF. No Bun code, C runtime initializer, preinit array, init array, or constructor runs before this prelude. Loader provenance and open-order acceptance remain separate activation gates.

Build:

```sh
SCRIPT=/path/to/authorized/prime-agent-coding-v26.js
SCRIPT_SHA256=$(sha256sum "$SCRIPT" | cut -d' ' -f1)
python3 scripts/build-sandbox-runtime-v26.py \
  --input /path/to/official/bun \
  --coding-script "$SCRIPT" \
  --coding-script-sha256 "$SCRIPT_SHA256" \
  --output /tmp/prime-agent \
  --manifest /tmp/prime-agent-v26.manifest.json
```

Destinations must not exist and may not be aliases, symlinks, or hard links. The builder writes bounded unique same-directory temporary files, applies and syncs their final modes, publishes both without replacement, syncs their directories where supported, and removes both outputs and all owned temporary files if publication fails. It never overwrites an unrelated file.

The output is not checked in. Installation must make it root:65533 mode 2755 with `nlink=1`. The coding script must be installed at `/opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js` as root:root mode 0444 with `nlink=1`. The checked-in template is rebuilt by compiling `prelude.S` and extracting the relocation-free `.text` section exactly.

Production activation remains blocked. The exact cached Docker amd64 emulation returns `ENOSYS` for `close_range` and `EINVAL` for `PR_SET_PTRACER`. Native amd64 target evidence must run the success control before the hostile matrix. Loader open order, install-time inode binding, the wider V25 descriptor and pre-fork socket proof, and a seeded loader-ABI harness remain separate acceptance work.
