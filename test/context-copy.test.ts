import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager, buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { materializeContextCopy, planContextClone, planContextFork } from "../src/index.ts";

function assistant(text: string, timestamp: number) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.3-codex",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp,
  };
}

function messageView(messages: ReturnType<typeof buildSessionContext>["messages"]) {
  return messages.map((message) => {
    if (message.role === "compactionSummary") return { role: message.role, summary: message.summary };
    if (message.role === "branchSummary") return { role: message.role, summary: message.summary };
    if (message.role === "user") return { role: message.role, content: message.content };
    if (message.role === "assistant") return { role: message.role, content: message.content };
    if (message.role === "toolResult") return { role: message.role, toolCallId: message.toolCallId, content: message.content };
    if (message.role === "bashExecution") return { role: message.role, command: message.command, output: message.output };
    return { role: message.role, content: message.content };
  });
}

test("a historical fork uses the compaction available before its selected prompt", () => {
  const source = SessionManager.inMemory("/workspace");
  source.appendMessage({ role: "user", content: "old request", timestamp: 1 });
  source.appendMessage(assistant("old answer", 2));
  const keptUserId = source.appendMessage({ role: "user", content: "kept request", timestamp: 3 });
  source.appendMessage(assistant("kept answer", 4));
  const historicalCompactionId = source.appendCompaction("historical summary", keptUserId, 100);
  source.appendMessage({ role: "user", content: "after summary", timestamp: 5 });
  source.appendMessage(assistant("after answer", 6));
  const selectedPromptId = source.appendMessage({ role: "user", content: "restore this prompt", timestamp: 7 });
  const selectedAnswerId = source.appendMessage(assistant("future answer", 8));
  source.appendCompaction("future summary", selectedAnswerId, 200);

  const plan = planContextFork(source.getEntries(), selectedPromptId, {
    sourceSessionId: source.getSessionId(),
    model: { provider: "openai-codex", modelId: "gpt-5.3-codex" },
    thinkingLevel: "high",
  });

  assert.equal(plan.sourceCompactionId, historicalCompactionId);
  assert.equal(plan.draft, "restore this prompt");
  assert.deepEqual(
    plan.contextEntries.map((entry) => entry.type === "compaction" ? `compaction:${entry.summary}` : entry.id),
    [`compaction:historical summary`, keptUserId, source.getBranch(selectedPromptId)[3]?.id, source.getBranch(selectedPromptId)[5]?.id, source.getBranch(selectedPromptId)[6]?.id],
  );
  assert.ok(!plan.contextEntries.some((entry) => entry.type === "compaction" && entry.summary === "future summary"));
});

test("materialization creates independent canonical context with rewritten entry ancestry", () => {
  const source = SessionManager.inMemory("/workspace");
  source.appendMessage({ role: "user", content: "summarized request", timestamp: 1 });
  source.appendMessage(assistant("summarized answer", 2));
  const keptUserId = source.appendMessage({ role: "user", content: "kept request", timestamp: 3 });
  source.appendMessage(assistant("kept answer", 4));
  source.appendCompaction("work before the retained turn", keptUserId, 80, { readFiles: ["src/a.ts"] });
  source.appendMessage({ role: "user", content: "latest request", timestamp: 5 });
  source.appendMessage(assistant("latest answer", 6));
  const selectedPromptId = source.appendMessage({ role: "user", content: "next task", timestamp: 7 });

  const plan = planContextFork(source.getEntries(), selectedPromptId, {
    sourceSessionId: source.getSessionId(),
    model: { provider: "openai-codex", modelId: "gpt-5.3-codex" },
    thinkingLevel: "high",
  });
  const target = SessionManager.inMemory("/workspace");
  const result = materializeContextCopy(plan, target);

  const expected = buildSessionContext(source.getEntries(), source.getEntry(selectedPromptId)?.parentId);
  const actual = target.buildSessionContext();
  assert.deepEqual(messageView(actual.messages), messageView(expected.messages));
  assert.deepEqual(actual.model, { provider: "openai-codex", modelId: "gpt-5.3-codex" });
  assert.equal(actual.thinkingLevel, "high");
  assert.equal(target.getHeader()?.parentSession, undefined);
  assert.equal(result.draft, "next task");
  assert.ok(target.getEntries().every((entry) => !source.getEntry(entry.id)));

  const targetIds = new Set(target.getEntries().map((entry) => entry.id));
  for (const entry of target.getBranch()) {
    assert.ok(entry.parentId === null || targetIds.has(entry.parentId));
  }
  const provenance = target.getEntries().find(
    (entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === "pi-context-copy",
  );
  assert.deepEqual(provenance?.data, {
    version: 1,
    mode: "fork",
    sourceSessionId: source.getSessionId(),
    sourceEntryId: selectedPromptId,
    sourcePointEntryId: source.getEntry(selectedPromptId)?.parentId,
    sourceCompactionId: plan.sourceCompactionId,
  });
});

test("a fork rejects prompts whose non-text content cannot be restored as an editor draft", () => {
  const source = SessionManager.inMemory("/workspace");
  const selectedId = source.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "Inspect this image" },
      { type: "image", data: "base64-data", mimeType: "image/png" },
    ],
    timestamp: 1,
  });

  assert.throws(() => planContextFork(source.getEntries(), selectedId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "off",
  }), /text-only user prompt/);
});

test("invalid source context is rejected before mutating the detached target", () => {
  const invalidEntry = {
    type: "message",
    id: "invalid-summary-message",
    parentId: null,
    timestamp: new Date(1).toISOString(),
    message: {
      role: "compactionSummary",
      summary: "stored in the wrong entry type",
      tokensBefore: 10,
      timestamp: 1,
    },
  } as SessionEntry;
  const plan = planContextClone([invalidEntry], invalidEntry.id, {
    sourceSessionId: "source-session",
    model: { provider: "openai-codex", modelId: "gpt-5.3-codex" },
    thinkingLevel: "high",
  });
  const target = SessionManager.inMemory("/workspace");

  assert.throws(() => materializeContextCopy(plan, target), /Unsupported summary message entry/);
  assert.deepEqual(target.getEntries(), []);
});
