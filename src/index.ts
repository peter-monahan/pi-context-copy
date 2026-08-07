import {
  buildContextEntries,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomMessageEntry,
  type SessionEntry,
  type SessionManager,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";

export interface ContextCopyConfiguration {
  sourceSessionId: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
}

export interface ContextCopyPlan {
  mode: "fork" | "clone";
  sourceSessionId: string;
  sourceEntryId: string | null;
  sourcePointEntryId: string | null;
  sourceCompactionId?: string;
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  draft: string;
  contextEntries: SessionEntry[];
  retainedEntries: SessionEntry[];
  subsequentEntries: SessionEntry[];
  compaction?: CompactionEntry;
}

export interface ContextCopyMaterializationResult {
  draft: string;
  entryIds: Map<string, string>;
}

export function planContextFork(
  entries: readonly SessionEntry[],
  selectedPromptId: string,
  configuration: ContextCopyConfiguration,
): ContextCopyPlan {
  const selected = uniqueEntry(entries, selectedPromptId);
  if (selected.type !== "message" || selected.message.role !== "user") {
    throw new Error("Context forks require a user prompt entry");
  }
  return planContextCopy(entries, "fork", selectedPromptId, selected.parentId, restorableUserPromptText(selected.message.content), configuration);
}

export function planContextClone(
  entries: readonly SessionEntry[],
  leafId: string | null,
  configuration: ContextCopyConfiguration,
): ContextCopyPlan {
  if (leafId !== null) uniqueEntry(entries, leafId);
  return planContextCopy(entries, "clone", leafId, leafId, "", configuration);
}

export function materializeContextCopy(
  plan: ContextCopyPlan,
  target: SessionManager,
): ContextCopyMaterializationResult {
  if (target.getEntries().length !== 0) {
    throw new Error("Context copy target must be an empty session");
  }
  if (target.getHeader()?.parentSession !== undefined) {
    throw new Error("Context copy target must be detached from family lineage");
  }
  validateMaterializationPlan(plan);

  const entryIds = new Map<string, string>();
  if (plan.model) target.appendModelChange(plan.model.provider, plan.model.modelId);
  target.appendThinkingLevelChange(plan.thinkingLevel);

  if (plan.compaction) {
    for (const entry of plan.retainedEntries) appendContextEntry(target, entry, entryIds);
    const firstKeptId = firstMaterializedId(plan.retainedEntries, entryIds);
    if (!firstKeptId) {
      throw new Error("Cannot materialize a compaction without a retained context entry");
    }
    const compactionId = target.appendCompaction(
      plan.compaction.summary,
      firstKeptId,
      plan.compaction.tokensBefore,
      clone(plan.compaction.details),
      plan.compaction.fromHook,
    );
    entryIds.set(plan.compaction.id, compactionId);
    for (const entry of plan.subsequentEntries) appendContextEntry(target, entry, entryIds);
  } else {
    for (const entry of plan.subsequentEntries) appendContextEntry(target, entry, entryIds);
  }

  target.appendCustomEntry("pi-context-copy", {
    version: 1,
    mode: plan.mode,
    sourceSessionId: plan.sourceSessionId,
    sourceEntryId: plan.sourceEntryId,
    sourcePointEntryId: plan.sourcePointEntryId,
    ...(plan.sourceCompactionId === undefined ? {} : { sourceCompactionId: plan.sourceCompactionId }),
  });

  return { draft: plan.draft, entryIds };
}

function planContextCopy(
  entries: readonly SessionEntry[],
  mode: "fork" | "clone",
  sourceEntryId: string | null,
  pointLeafId: string | null,
  draft: string,
  configuration: ContextCopyConfiguration,
): ContextCopyPlan {
  const copiedEntries = clone([...entries]);
  const branch = historicalBranch(copiedEntries, pointLeafId);
  const contextEntries = buildContextEntries(copiedEntries, pointLeafId);
  const compaction = latestCompaction(branch);

  if (!compaction) {
    return {
      mode,
      sourceSessionId: configuration.sourceSessionId,
      sourceEntryId,
      sourcePointEntryId: pointLeafId,
      model: clone(configuration.model),
      thinkingLevel: configuration.thinkingLevel,
      draft,
      contextEntries,
      retainedEntries: [],
      subsequentEntries: contextEntries,
    };
  }

  const compactionIndex = branch.findIndex((entry) => entry.id === compaction.id);
  const firstKeptIndex = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
    throw new Error("Historical compaction has an invalid retained-context boundary");
  }
  const retainedEntries = branch.slice(firstKeptIndex, compactionIndex);
  const subsequentEntries = branch.slice(compactionIndex + 1);

  return {
    mode,
    sourceSessionId: configuration.sourceSessionId,
    sourceEntryId,
    sourcePointEntryId: pointLeafId,
    sourceCompactionId: compaction.id,
    model: clone(configuration.model),
    thinkingLevel: configuration.thinkingLevel,
    draft,
    contextEntries,
    retainedEntries,
    subsequentEntries,
    compaction,
  };
}

function historicalBranch(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
  if (leafId === null) return [];
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error(`Duplicate session entry ID: ${entry.id}`);
    byId.set(entry.id, entry);
  }

  const reversed: SessionEntry[] = [];
  const visited = new Set<string>();
  let current = byId.get(leafId);
  if (!current) throw new Error(`Session entry not found: ${leafId}`);
  while (current) {
    if (visited.has(current.id)) throw new Error("Session entry ancestry contains a cycle");
    visited.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
    if (reversed.at(-1)?.parentId !== null && current === undefined) {
      throw new Error("Session entry ancestry is incomplete");
    }
  }
  return reversed.reverse();
}

function latestCompaction(branch: readonly SessionEntry[]): CompactionEntry | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") return entry;
  }
  return undefined;
}

function uniqueEntry(entries: readonly SessionEntry[], id: string): SessionEntry {
  const matches = entries.filter((entry) => entry.id === id);
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `Session entry not found: ${id}` : `Duplicate session entry ID: ${id}`);
  return matches[0]!;
}

function validateMaterializationPlan(plan: ContextCopyPlan): void {
  if (plan.compaction && !plan.retainedEntries.some(isMaterializedContextEntry)) {
    throw new Error("Cannot materialize a compaction without a retained context entry");
  }
  for (const entry of [...plan.retainedEntries, ...plan.subsequentEntries]) {
    if (entry.type === "compaction") {
      throw new Error(`Unexpected nested compaction entry: ${entry.id}`);
    }
    if (entry.type === "message" && (entry.message.role === "compactionSummary" || entry.message.role === "branchSummary")) {
      throw new Error(`Unsupported summary message entry: ${entry.id}`);
    }
  }
}

function isMaterializedContextEntry(entry: SessionEntry): boolean {
  return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}

function appendContextEntry(target: SessionManager, entry: SessionEntry, entryIds: Map<string, string>): void {
  let newId: string | undefined;
  if (entry.type === "message") newId = appendMessage(target, entry);
  else if (entry.type === "custom_message") newId = appendCustomMessage(target, entry);
  else if (entry.type === "branch_summary") newId = appendBranchSummary(target, entry);
  if (newId !== undefined) entryIds.set(entry.id, newId);
}

function appendMessage(target: SessionManager, entry: SessionMessageEntry): string {
  if (entry.message.role === "compactionSummary" || entry.message.role === "branchSummary") {
    throw new Error(`Unsupported summary message entry: ${entry.id}`);
  }
  return target.appendMessage(clone(entry.message) as Parameters<SessionManager["appendMessage"]>[0]);
}

function appendCustomMessage(target: SessionManager, entry: CustomMessageEntry): string {
  return target.appendCustomMessageEntry(entry.customType, clone(entry.content), entry.display, clone(entry.details));
}

function appendBranchSummary(target: SessionManager, entry: BranchSummaryEntry): string {
  return target.branchWithSummary(target.getLeafId(), entry.summary, clone(entry.details), entry.fromHook);
}

function firstMaterializedId(entries: readonly SessionEntry[], ids: ReadonlyMap<string, string>): string | undefined {
  for (const entry of entries) {
    const id = ids.get(entry.id);
    if (id) return id;
  }
  return undefined;
}

function restorableUserPromptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || content.some((part: unknown) => !isTextPart(part))) {
    throw new Error("Context forks currently require a text-only user prompt");
  }
  return content.map((part: { type: "text"; text: string }) => part.text).join("");
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  if (typeof value !== "object" || value === null) return false;
  const part = value as Record<string, unknown>;
  return part.type === "text" && typeof part.text === "string";
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
