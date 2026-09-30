import { existsSync, writeFileSync } from "node:fs";
import { buildContextEntries, } from "@earendil-works/pi-coding-agent";
export function planContextFork(entries, selectedPromptId, configuration) {
    const selected = uniqueEntry(entries, selectedPromptId);
    if (selected.type !== "message" || selected.message.role !== "user") {
        throw new Error("Context forks require a user prompt entry");
    }
    return planContextCopy(entries, "fork", selectedPromptId, selected.parentId, restorableUserPromptText(selected.message.content), configuration);
}
export function planContextClone(entries, leafId, configuration) {
    if (leafId !== null)
        uniqueEntry(entries, leafId);
    return planContextCopy(entries, "clone", leafId, leafId, "", configuration);
}
export function materializeContextCopy(plan, target) {
    if (target.getEntries().length !== 0) {
        throw new Error("Context copy target must be an empty session");
    }
    if (target.getHeader()?.parentSession !== undefined) {
        throw new Error("Context copy target must be detached from family lineage");
    }
    validateMaterializationPlan(plan);
    const entryIds = new Map();
    if (plan.model)
        target.appendModelChange(plan.model.provider, plan.model.modelId);
    target.appendThinkingLevelChange(plan.thinkingLevel);
    if (plan.compaction) {
        if (plan.compaction.systemMessage) {
            target.appendMessage(clone(plan.compaction.systemMessage));
        }
        for (const entry of plan.retainedEntries)
            appendContextEntry(target, entry, entryIds);
        const firstKeptId = firstMaterializedId(plan.retainedEntries, entryIds);
        if (!firstKeptId) {
            throw new Error("Cannot materialize a compaction without a retained context entry");
        }
        const compactionId = target.appendCompaction(plan.compaction.summary, firstKeptId, plan.compaction.tokensBefore, clone(plan.compaction.details), plan.compaction.fromHook, clone(plan.compaction.usage));
        entryIds.set(plan.compaction.id, compactionId);
        for (const entry of plan.subsequentEntries)
            appendContextEntry(target, entry, entryIds);
    }
    else {
        for (const entry of plan.subsequentEntries)
            appendContextEntry(target, entry, entryIds);
    }
    target.appendCustomEntry("pi-context-copy", {
        version: 1,
        mode: plan.mode,
        sourceSessionId: plan.sourceSessionId,
        sourceEntryId: plan.sourceEntryId,
        sourcePointEntryId: plan.sourcePointEntryId,
        ...(plan.sourceCompactionId === undefined ? {} : { sourceCompactionId: plan.sourceCompactionId }),
    });
    persistUnflushedSession(target);
    return { draft: plan.draft, entryIds };
}
function planContextCopy(entries, mode, sourceEntryId, pointLeafId, draft, configuration) {
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
    const retainedEntries = branch.slice(firstKeptIndex, compactionIndex).filter((entry) => !compaction.systemMessage || entry.type !== "message" || entry.message.role !== "system");
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
function historicalBranch(entries, leafId) {
    if (leafId === null)
        return [];
    const byId = new Map();
    for (const entry of entries) {
        if (byId.has(entry.id))
            throw new Error(`Duplicate session entry ID: ${entry.id}`);
        byId.set(entry.id, entry);
    }
    const reversed = [];
    const visited = new Set();
    let current = byId.get(leafId);
    if (!current)
        throw new Error(`Session entry not found: ${leafId}`);
    while (current) {
        if (visited.has(current.id))
            throw new Error("Session entry ancestry contains a cycle");
        visited.add(current.id);
        reversed.push(current);
        current = current.parentId === null ? undefined : byId.get(current.parentId);
        if (reversed.at(-1)?.parentId !== null && current === undefined) {
            throw new Error("Session entry ancestry is incomplete");
        }
    }
    return reversed.reverse();
}
function latestCompaction(branch) {
    for (let index = branch.length - 1; index >= 0; index -= 1) {
        const entry = branch[index];
        if (entry?.type === "compaction")
            return entry;
    }
    return undefined;
}
function uniqueEntry(entries, id) {
    const matches = entries.filter((entry) => entry.id === id);
    if (matches.length !== 1)
        throw new Error(matches.length === 0 ? `Session entry not found: ${id}` : `Duplicate session entry ID: ${id}`);
    return matches[0];
}
function persistUnflushedSession(manager) {
    if (!manager.isPersisted())
        return;
    const path = manager.getSessionFile();
    if (!path)
        throw new Error("Persisted context-copy target has no session file");
    if (existsSync(path))
        return;
    const header = manager.getHeader();
    if (!header)
        throw new Error("Context-copy session header is unavailable");
    const jsonl = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(path, `${jsonl}\n`, { flag: "wx" });
}
function validateMaterializationPlan(plan) {
    if (plan.compaction && !plan.retainedEntries.some(isMaterializedContextEntry)) {
        throw new Error("Cannot materialize a compaction without a retained context entry");
    }
    const editableSourceIds = new Set();
    for (const entry of [...plan.retainedEntries, ...plan.subsequentEntries]) {
        if (entry.type === "compaction") {
            throw new Error(`Unexpected nested compaction entry: ${entry.id}`);
        }
        if (entry.type === "message" && (entry.message.role === "compactionSummary" || entry.message.role === "branchSummary")) {
            throw new Error(`Unsupported summary message entry: ${entry.id}`);
        }
        if (entry.type === "context_edit" && !editableSourceIds.has(entry.targetId)) {
            throw new Error(`Context edit target is unavailable or not editable in copied context: ${entry.targetId}`);
        }
        if (isContextEditableEntry(entry))
            editableSourceIds.add(entry.id);
    }
}
function isMaterializedContextEntry(entry) {
    return entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary";
}
function isContextEditableEntry(entry) {
    if (entry.type === "custom_message")
        return true;
    if (entry.type !== "message")
        return false;
    return ["user", "assistant", "toolResult"].includes(entry.message.role);
}
function appendContextEntry(target, entry, entryIds) {
    let newId;
    if (entry.type === "message")
        newId = appendMessage(target, entry);
    else if (entry.type === "custom_message")
        newId = appendCustomMessage(target, entry);
    else if (entry.type === "branch_summary")
        newId = appendBranchSummary(target, entry);
    else if (entry.type === "context_edit")
        newId = appendContextEdit(target, entry, entryIds);
    if (newId !== undefined)
        entryIds.set(entry.id, newId);
}
function appendMessage(target, entry) {
    if (entry.message.role === "compactionSummary" || entry.message.role === "branchSummary") {
        throw new Error(`Unsupported summary message entry: ${entry.id}`);
    }
    return target.appendMessage(clone(entry.message));
}
function appendCustomMessage(target, entry) {
    return target.appendCustomMessageEntry(entry.customType, clone(entry.content), entry.display, clone(entry.details));
}
function appendBranchSummary(target, entry) {
    return target.branchWithSummary(target.getLeafId(), entry.summary, clone(entry.details), entry.fromHook, clone(entry.usage));
}
function appendContextEdit(target, entry, entryIds) {
    const targetId = entryIds.get(entry.targetId);
    if (!targetId)
        throw new Error(`Context edit target is unavailable in copied context: ${entry.targetId}`);
    return target.appendContextEdit(targetId, clone(entry.replacement));
}
function firstMaterializedId(entries, ids) {
    for (const entry of entries) {
        const id = ids.get(entry.id);
        if (id)
            return id;
    }
    return undefined;
}
function restorableUserPromptText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content) || content.some((part) => !isTextPart(part))) {
        throw new Error("Context forks currently require a text-only user prompt");
    }
    return content.map((part) => part.text).join("");
}
function isTextPart(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const part = value;
    return part.type === "text" && typeof part.text === "string";
}
function clone(value) {
    return value === undefined ? value : structuredClone(value);
}
