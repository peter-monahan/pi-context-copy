import { type CompactionEntry, type SessionEntry, type SessionManager } from "@earendil-works/pi-coding-agent";
export interface ContextCopyConfiguration {
    sourceSessionId: string;
    model: {
        provider: string;
        modelId: string;
    } | null;
    thinkingLevel: string;
}
export interface ContextCopyPlan {
    mode: "fork" | "clone";
    sourceSessionId: string;
    sourceEntryId: string | null;
    sourcePointEntryId: string | null;
    sourceCompactionId?: string;
    model: {
        provider: string;
        modelId: string;
    } | null;
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
export declare function planContextFork(entries: readonly SessionEntry[], selectedPromptId: string, configuration: ContextCopyConfiguration): ContextCopyPlan;
export declare function planContextClone(entries: readonly SessionEntry[], leafId: string | null, configuration: ContextCopyConfiguration): ContextCopyPlan;
export declare function materializeContextCopy(plan: ContextCopyPlan, target: SessionManager): ContextCopyMaterializationResult;
//# sourceMappingURL=index.d.ts.map