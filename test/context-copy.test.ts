import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("a user-only context clone is immediately durable as canonical Pi JSONL", async () => {
  const source = SessionManager.inMemory("/workspace");
  const leafId = source.appendMessage({ role: "user", content: "persist this context", timestamp: 1 });
  const plan = planContextClone(source.getEntries(), leafId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "medium",
  });
  const directory = await mkdtemp(join(tmpdir(), "pi-context-copy-durable-"));
  const target = SessionManager.create("/workspace", directory);

  materializeContextCopy(plan, target);

  const sessionFile = target.getSessionFile();
  assert.ok(sessionFile);
  const reopened = SessionManager.open(sessionFile, directory);
  assert.deepEqual(reopened.buildSessionContext().messages.map((message) => message.role), ["user"]);
  assert.equal(reopened.getHeader()?.parentSession, undefined);
});

test("context replacements and omissions keep their model-visible semantics", () => {
  const source = SessionManager.inMemory("/workspace");
  const replacedId = source.appendMessage({ role: "user", content: "sensitive request", timestamp: 1 });
  source.appendContextEdit(replacedId, { content: "sanitized request" });
  const omittedId = source.appendMessage(assistant("discard this answer", 2));
  const leafId = source.appendContextEdit(omittedId, null);

  const plan = planContextClone(source.getEntries(), leafId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "medium",
  });
  const target = SessionManager.inMemory("/workspace");
  materializeContextCopy(plan, target);

  assert.deepEqual(messageView(target.buildSessionContext().messages), messageView(source.buildSessionContext().messages));
  const copiedEdits = target.getEntries().filter((entry) => entry.type === "context_edit");
  assert.equal(copiedEdits.length, 2);
  assert.ok(copiedEdits.every((entry) => target.getEntry(entry.targetId)?.id === entry.targetId));
});

test("compaction copies preserve the effective system checkpoint and usage", () => {
  const source = SessionManager.inMemory("/workspace");
  source.appendMessage({ role: "system", content: "Use the reviewed tools only.", timestamp: 1 });
  const keptId = source.appendMessage({ role: "user", content: "kept request", timestamp: 2 });
  source.appendMessage({ role: "system", content: "Prefer concise output.", timestamp: 3 });
  source.appendMessage(assistant("kept answer", 4));
  const summaryUsage = assistant("unused", 5).usage;
  source.appendCompaction("earlier work", keptId, 120, undefined, false, summaryUsage);
  const leafId = source.appendMessage({ role: "user", content: "continue", timestamp: 6 });

  const plan = planContextClone(source.getEntries(), leafId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "high",
  });
  const target = SessionManager.inMemory("/workspace");
  materializeContextCopy(plan, target);

  assert.deepEqual(messageView(target.buildSessionContext().messages), messageView(source.buildSessionContext().messages));
  const copiedCompaction = target.getEntries().find((entry) => entry.type === "compaction");
  assert.deepEqual(copiedCompaction?.usage, summaryUsage);
  assert.equal(
    copiedCompaction?.systemMessage?.content,
    "Use the reviewed tools only.\n\nPrefer concise output.",
  );
});

test("usage-only entries stay outside copied model context", () => {
  const source = SessionManager.inMemory("/workspace");
  source.appendMessage({ role: "user", content: "before usage", timestamp: 1 });
  source.appendUsage("cache_warm", "openai-codex", "gpt-test", assistant("unused", 2).usage);
  const leafId = source.appendMessage(assistant("after usage", 3));

  const plan = planContextClone(source.getEntries(), leafId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "off",
  });
  const target = SessionManager.inMemory("/workspace");
  materializeContextCopy(plan, target);

  assert.deepEqual(messageView(target.buildSessionContext().messages), messageView(source.buildSessionContext().messages));
  assert.ok(!target.getEntries().some((entry) => entry.type === "usage"));
});

test("an unavailable context-edit target fails before mutating the detached target", () => {
  const source = SessionManager.inMemory("/workspace");
  const summarizedId = source.appendMessage({ role: "user", content: "summarized away", timestamp: 1 });
  const keptId = source.appendMessage({ role: "user", content: "kept request", timestamp: 2 });
  source.appendCompaction("earlier work", keptId, 80);
  const leafId = source.appendContextEdit(summarizedId, null);
  const plan = planContextClone(source.getEntries(), leafId, {
    sourceSessionId: source.getSessionId(),
    model: null,
    thinkingLevel: "medium",
  });
  const target = SessionManager.inMemory("/workspace");

  assert.throws(() => materializeContextCopy(plan, target), /Context edit target is unavailable/);
  assert.deepEqual(target.getEntries(), []);
});

test("a context edit targeting non-editable system state fails before target mutation", () => {
  const source = SessionManager.inMemory("/workspace");
  const systemId = source.appendMessage({ role: "system", content: "System state", timestamp: 1 });
  const leafId = "invalid-system-edit";
  const entries = [...source.getEntries(), {
    type: "context_edit",
    id: leafId,
    parentId: systemId,
    timestamp: new Date(2).toISOString(),
    targetId: systemId,
    replacement: null,
  } as SessionEntry];
  const plan = planContextClone(entries, leafId, {
    sourceSessionId: source.getSessionId(),
    model: { provider: "openai-codex", modelId: "gpt-test" },
    thinkingLevel: "high",
  });
  const target = SessionManager.inMemory("/workspace");

  assert.throws(() => materializeContextCopy(plan, target), /not editable/);
  assert.deepEqual(target.getEntries(), []);
});

test("a context edit targeting a legacy custom message fails before target mutation", () => {
  const source = SessionManager.inMemory("/workspace");
  const customId = source.appendMessage({
    role: "custom",
    customType: "legacy",
    content: "Legacy custom message",
    display: true,
    timestamp: 1,
  });
  const leafId = "invalid-custom-edit";
  const entries = [...source.getEntries(), {
    type: "context_edit",
    id: leafId,
    parentId: customId,
    timestamp: new Date(2).toISOString(),
    targetId: customId,
    replacement: null,
  } as SessionEntry];
  const plan = planContextClone(entries, leafId, {
    sourceSessionId: source.getSessionId(),
    model: { provider: "openai-codex", modelId: "gpt-test" },
    thinkingLevel: "high",
  });
  const target = SessionManager.inMemory("/workspace");

  assert.throws(() => materializeContextCopy(plan, target), /not editable/);
  assert.deepEqual(target.getEntries(), []);
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
