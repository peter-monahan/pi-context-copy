# Repository guidance

- Pi session JSONL is canonical; do not create another transcript store.
- Context copies are detached top-level sessions and must not set `parentSession`.
- Select context at the requested historical ancestry point; never use a later compaction.
- Preserve effective model context, tool-call/result relationships, model, and thinking configuration.
- Exclude queues, live operations, labels, display metadata, and other non-context activity.
- Fail closed before mutating a target when source context cannot be represented safely.
- Keep the exported planner and materializer independent of any particular UI.
- Add dependencies only when a small local implementation is insufficient.
