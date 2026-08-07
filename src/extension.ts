import type {
  ExtensionAPI,
  ExtensionCommandContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  materializeContextCopy,
  planContextClone,
  planContextFork,
  type ContextCopyConfiguration,
  type ContextCopyPlan,
} from "./index.ts";

export default function contextCopyExtension(pi: ExtensionAPI): void {
  pi.registerCommand("context-fork", {
    description: "Copy context before a user prompt into a detached session",
    handler: async (args, ctx) => {
      await runContextCopy(pi, ctx, async () => {
        const selectedId = args.trim() || await selectUserPrompt(ctx);
        if (!selectedId) return undefined;
        return planContextFork(ctx.sessionManager.getEntries(), selectedId, configuration(pi, ctx));
      });
    },
  });

  pi.registerCommand("context-clone", {
    description: "Copy the current effective context into a detached session",
    handler: async (_args, ctx) => {
      await runContextCopy(pi, ctx, () => Promise.resolve(planContextClone(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
        configuration(pi, ctx),
      )));
    },
  });
}

async function runContextCopy(
  _pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  createPlan: () => Promise<ContextCopyPlan | undefined>,
): Promise<void> {
  try {
    await ctx.waitForIdle();
    const plan = await createPlan();
    if (!plan) return;

    const result = await ctx.newSession({
      setup: async (sessionManager) => {
        materializeContextCopy(plan, sessionManager);
      },
      withSession: async (replacementCtx) => {
        replacementCtx.ui.setEditorText(plan.draft);
        replacementCtx.ui.notify(
          plan.mode === "fork"
            ? "Detached context fork ready. Submit the restored prompt when ready."
            : "Detached context clone ready.",
          "info",
        );
      },
    });
    if (result.cancelled) ctx.ui.notify("Context copy cancelled", "info");
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
  }
}

function configuration(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextCopyConfiguration {
  return {
    sourceSessionId: ctx.sessionManager.getSessionId(),
    model: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : null,
    thinkingLevel: pi.getThinkingLevel(),
  };
}

async function selectUserPrompt(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Usage: /context-fork <user-entry-id>", "error");
    return undefined;
  }
  const prompts = ctx.sessionManager.getBranch().filter(isUserPrompt);
  if (prompts.length === 0) {
    ctx.ui.notify("This session has no user prompts to fork", "error");
    return undefined;
  }
  const options = prompts.map((entry, index) => promptOption(entry, index));
  const selected = await ctx.ui.select("Fork context before which prompt?", options);
  if (selected === undefined) return undefined;
  const selectedIndex = options.indexOf(selected);
  return selectedIndex < 0 ? undefined : prompts[selectedIndex]?.id;
}

type UserPromptEntry = Extract<SessionEntry, { type: "message" }> & {
  message: { role: "user"; content: unknown };
};

function isUserPrompt(entry: SessionEntry): entry is UserPromptEntry {
  return entry.type === "message" && entry.message.role === "user";
}

function promptOption(entry: UserPromptEntry, index: number): string {
  const text = userText(entry.message.content).replaceAll(/\s+/g, " ").trim();
  const excerpt = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return `${index + 1}. ${excerpt || "(non-text prompt)"} · ${entry.id.slice(0, 8)}`;
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: unknown) => {
    if (typeof part !== "object" || part === null) return [];
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  }).join("");
}
