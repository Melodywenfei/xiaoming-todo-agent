import { z } from "zod";
import { changedFields, visibleTask } from "./task.ts";

export const pendingAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("complete") }),
  z.object({ action: z.literal("remove") }),
  z.object({ action: z.literal("edit"), fields: changedFields }),
]);
export type PendingAction = z.infer<typeof pendingAction>;

const rows = z.array(visibleTask);
const taskView = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("list"), rows }),
  z.object({ kind: z.literal("receipt"), rows }),
  z.object({ kind: z.literal("choice"), rows, pending: pendingAction }),
]);
export type TaskView = z.infer<typeof taskView>;
export const chatAnswer = z.object({ reply: z.string(), view: taskView.optional() });
export type ChatAnswer = z.infer<typeof chatAnswer>;

const messageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1),
  view: taskView.optional(),
});

export type ChatMessage = z.infer<typeof messageSchema>;

export const chatRequestSchema = z.object({
  messages: z
    .array(messageSchema)
    .min(1)
    .refine((messages) => messages.at(-1)?.role === "user"),
});
