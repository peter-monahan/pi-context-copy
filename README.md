# pi-context-copy

Detached, point-in-time context forks and clones for [Pi](https://github.com/earendil-works/pi-mono).

## Commands

- `/context-fork` selects a user prompt, reconstructs the effective context immediately before it, and restores the prompt as an unsent draft in a new session.
- `/context-fork <entry-id>` performs the same operation for an explicit user-message entry ID.
- `/context-clone` copies the current effective context into a new session with an empty editor.

The new session is an independent, canonical Pi JSONL session. It deliberately omits `parentSession`, so Pi does not treat it as a family descendant.

## Historical context semantics

Context is resolved on the selected entry's ancestry, not from the source session's current leaf:

1. Walk the source branch only through the requested historical point.
2. Find the latest compaction on that prefix.
3. Copy that summary, its retained context, and entries after the compaction through the requested point.
4. Ignore every later entry and later compaction.

Without a historical compaction, the copy contains model-visible entries from the beginning of that branch. Model and thinking configuration come from the active runtime invoking the command. Queues, live operations, labels, names, and display-only custom entries are not copied.

A display-only `pi-context-copy` provenance entry records the source session, source point, mode, and applicable compaction without creating lineage or entering model context.

## Installation

From this checkout:

```bash
pi install /home/peter/pipi/packages/pi-context-copy
```

Pi records the package path and loads `src/extension.ts`. Run `/reload` in an existing Pi process after installation or source changes.

## Library API

Runtime adapters can use the same implementation without invoking extension session replacement:

```ts
import {
  materializeContextCopy,
  planContextClone,
  planContextFork,
} from "pi-context-copy";
```

The exported planner is pure over Pi `SessionEntry` values. `materializeContextCopy()` writes a validated plan into an empty, detached `SessionManager`, rebases session entry IDs and ancestry, and preserves effective model context. A browser or concurrent runtime remains responsible for staging, ownership acquisition, atomic publication, activation, and rollback around that write.

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

The package is intentionally marked private to prevent accidental npm publication. It can still be installed from a local path or Git repository.
