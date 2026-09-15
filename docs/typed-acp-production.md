# Typed ACP production storage

Configured Grok, Gemini, Devin, Hermes, and custom ACP providers use the typed runtime.
SQLite stores the original journal prefix, binding, source artifacts, and replay records in one database.
A session-scoped endpoint serves artifacts after it checks the live session and project.
Child transcripts use their parent session endpoint and exact native child ID.

Replay imports keep their original load scope. They do not invent historical native roots.
Repeated identical snapshots add no messages. Exact native tool or item identities also permit deduplication across changed snapshots.
Existing live items require matching committed journal records and committed message content before replay reuses their local turn and item.
Changed native content updates that same local item. Missing message proof cannot suppress an import.

Some ACP history has no stable native item identity. Forge cannot prove that such content duplicates locally stored live text.
A changed snapshot can therefore overlap local history. Forge preserves that content in a separate local import group.
Raw replay records remain durable, including records whose UI projection was deduplicated.
