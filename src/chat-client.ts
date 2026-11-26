import { chatAnswer, type ChatAnswer, type ChatMessage } from "../shared/chat.ts";

export async function requestReply(messages: ChatMessage[]): Promise<ChatAnswer> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: messages.map((message, i) =>
        i === messages.length - 2 ? message : { role: message.role, content: message.content },
      ),
    }),
  });
  const body: unknown = await response.json();
  const answer = chatAnswer.safeParse(body);
  if (response.ok && answer.success) return answer.data;
  if (typeof body === "object" && body !== null) {
    if ("error" in body && typeof body.error === "string") throw new Error(body.error);
  }
  throw new Error("服务暂时不可用。");
}
