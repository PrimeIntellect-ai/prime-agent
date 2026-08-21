# REL02 release runbook (draft template)

> Complete this record for one release candidate. REL02 approval is blocked until every required field is filled with immutable evidence. This template does not authorize a version bump or publication.

## 1. Release identity and paired inputs

| Field | Required value |
| --- | --- |
| Prime Agent commit (40-character SHA) | `<PA_SHA>` |
| Verifiers commit (40-character SHA) | `<VERIFIERS_SHA>` |
| Prime Agent artifact manifest | `<ARTIFACT_MANIFEST_URL_OR_PATH>` |
| Prime Agent primary artifact SHA-256 | `<SHA256>` |
| All artifact SHA-256 values / `SHA256SUMS` URL | `<URL_OR_PATH>` |
| Release channel and candidate version | `<stable-or-beta> / <VERSION>` |
| Exact REL01 dry-run output | `<URL_OR_PATH>` |

Record the Prime Agent and Verifiers SHAs together. Do not substitute a branch name, abbreviated SHA, mutable release pointer, or later rebuild.

### Production release tags

Production `vX.Y.Z` tags are protected, immutable release identities. The release workflow peels every tag to its commit, including annotated tags, and accepts an existing tag only when it peels exactly to the selected source SHA. A manual production release may create a missing valid tag with GitHub's non-force ref API, but it never updates, moves, or force-pushes an existing release tag. Repository protection must prohibit release-tag mutation and deletion for the release workflow credential. The workflow re-fetches and rechecks the remote tag immediately before advancing stable pointers and again after GitHub release publication, failing on any mismatch.

## 2. Fixed evaluation plan

| Control | Required value |
| --- | --- |
| Fixed GSM8K example IDs, ordered | `<ID_1>, <ID_2>, ...` |
| Lifecycle seeds, ordered | `<SEED_1>, <SEED_2>, ...` |
| Verifiers command and immutable configuration | `<COMMAND_AND_CONFIG_HASH>` |
| Environment/image/toolchain identity | `<IMMUTABLE_REFERENCE>` |

Attach the exact input list and the unmodified command transcript. A rerun must use the same ordered GSM8K IDs and lifecycle seeds.

## 3. Canary and raw evidence retention

- Canary scope and success criteria: `<SCOPE_AND_CRITERIA>`
- Canary start/end timestamps (UTC): `<TIMESTAMPS>`
- Canary result and operator: `<RESULT_AND_OPERATOR>`
- Immutable raw logs, traces, outputs, and metrics location: `<URL_OR_PATH>`
- Retention owner and minimum retention period: `<OWNER_AND_PERIOD>`
- Artifact download/hash verification transcript: `<URL_OR_PATH>`

Keep raw evidence before producing summaries, decisions, cleanup, or rollback. Link the original bytes and their hashes, not only dashboards or prose.

## 4. Depth-1 S01 decision

| Item | Record |
| --- | --- |
| Depth-1 S01 result | `<PASS / FAIL / BLOCKED>` |
| Decision | `<PROMOTE / HOLD / ROLLBACK>` |
| Evidence reviewed | `<URL_OR_PATHS>` |
| Approver and UTC timestamp | `<NAME_AND_TIME>` |
| Rationale | `<RATIONALE>` |

A missing, failed, or non-reproducible depth-1 S01 result is **HOLD**; it is not implicit approval.

## 5. Rollback plan

- Trigger(s): `<TRIGGERS>`
- Exact channel/pointer or deployment to restore: `<IMMUTABLE_PREVIOUS_REFERENCE>`
- Operator and approval path: `<OWNER_AND_APPROVER>`
- Verification command and expected artifact hash after rollback: `<COMMAND_AND_SHA256>`
- Raw rollback transcript location: `<URL_OR_PATH>`

## Completion

- [ ] Paired Prime Agent and Verifiers SHAs are recorded.
- [ ] Artifact manifest, each artifact hash, and REL01 dry-run output match the Prime Agent SHA.
- [ ] Fixed GSM8K IDs and lifecycle seeds are recorded and used.
- [ ] Canary evidence is retained as raw immutable material.
- [ ] A depth-1 S01 decision is explicit.
- [ ] Rollback reference and verification are ready.
