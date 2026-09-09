# Concurrent harness saves

The TypeScript refinement host and Python harness use the same adjacent `harness_state.json.lock` directory to serialize saves. Each save rereads the latest state while holding the lock, applies only the changes since its own loaded snapshot, and atomically replaces the file. Unrelated entries and appended refinement events survive concurrent saves. Changes to the same entry cause the entire later save to fail with a reload-and-retry error; no part of that save is persisted.

Both writers retain the schema version loaded from disk. An ordinary memory save preserves the latest schema version; an explicit schema change fails if another writer has already changed the version since the snapshot was loaded.

Python normalizes an invalid stored schema to version 1. Writes containing non-finite numbers such as `NaN` or infinity fail before replacing the file, preserving the previously accepted state and keeping the JSON readable by the host.

Python generates distinct default refinement event IDs for concurrent calls. A pending refinement append fails if another writer has reset or rewritten the existing history. A memory save that leaves its refinement history unchanged preserves that accepted history replacement.

Both writers must use the updated implementation. This protocol does not coordinate with older runtimes or external programs writing the JSON file directly. Local and global stores lock independently; symlink aliases resolve to the same target lock.

Lock acquisition waits up to ten seconds. Reads remain available without acquiring the lock. Normal completion and exceptions release the lock. A process killed during a save can leave the lock directory behind; the protocol deliberately does not expire locks, since a slow or suspended writer could still be active. After stopping every writer to that store, remove the empty lock directory and retry. Automatic stale-lock recovery, power-loss durability, and transactions spanning the separate refinement audit logs are outside this protocol.
