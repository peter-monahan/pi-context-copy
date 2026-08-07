import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";

function fakePi() {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const pi = {
    registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
      commands.set(name, command);
    },
    getThinkingLevel() {
      return "high";
    },
  } as unknown as ExtensionAPI;
  return { pi, commands };
}

test("context-fork creates a detached session and restores the selected prompt", async () => {
  const source = SessionManager.inMemory("/workspace");
  source.appendMessage({ role: "user", content: "keep this", timestamp: 1 });
  const selectedId = source.appendMessage({ role: "user", content: "restore this", timestamp: 2 });
  const { pi, commands } = fakePi();
  extension(pi);

  let target: SessionManager | undefined;
  let editorText: string | undefined;
  let parentSessionWasProvided = false;
  const context = {
    mode: "tui",
    hasUI: true,
    model: { provider: "openai-codex", id: "gpt-5.3-codex" },
    sessionManager: source,
    waitForIdle: async () => {},
    newSession: async (options?: Parameters<ExtensionCommandContext["newSession"]>[0]) => {
      parentSessionWasProvided = options !== undefined && "parentSession" in options;
      target = SessionManager.inMemory("/workspace");
      await options?.setup?.(target);
      await options?.withSession?.({
        ui: {
          setEditorText(value: string) {
            editorText = value;
          },
          notify() {},
        },
      } as never);
      return { cancelled: false };
    },
    ui: { notify() {} },
  } as unknown as ExtensionCommandContext;

  await commands.get("context-fork")?.handler(selectedId, context);

  assert.ok(target);
  assert.equal(parentSessionWasProvided, false);
  assert.equal(target.getHeader()?.parentSession, undefined);
  assert.deepEqual(target.buildSessionContext().messages.map((message) => message.role), ["user"]);
  assert.equal(editorText, "restore this");
});
