import OpenAI from "openai";
import { z } from "zod";
import type { ChatMessage } from "../shared/chat.ts";
import { argumentsByTool, dateString, intentSchema, type Intent } from "./intent.ts";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("请在 .env 中设置 DEEPSEEK_API_KEY 后重启服务。");
  return new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" });
}

const descriptions: Record<keyof typeof argumentsByTool, string> = {
  create: "新建一项待办。标题用简洁的动宾短语，只有用户明确给出的属性才填写。",
  list: "查看清单，可筛选完成状态或确切的到期日期。今天到期默认只看未完成。",
  complete: "将一项明确已经做完的任务标记完成。query 是用户指的任务名、关键词或展示过的编号。",
  remove: "删除用户明确要求删除的一项任务。保留原话对任务的指代，不得自行缩小模糊指代。",
  edit: "修改指定任务的截止日期、优先级或工作量。只填写本轮要求修改的字段。",
  clarify: "信息不足、涉及多个动作、只是假设或在闲聊时，请提一个简洁的中文问题。",
};
const tools = Object.entries(argumentsByTool).map(([name, schema]) => ({
  type: "function" as const,
  function: {
    name,
    description: descriptions[name as keyof typeof descriptions],
    parameters: z.toJSONSchema(schema, { target: "draft-7" }),
  },
}));

export type ModelPlanner = (messages: ChatMessage[], now: Date) => Promise<Intent | undefined>;

export const planWithDeepSeek: ModelPlanner = async (messages, now) => {
  if (!process.env.DEEPSEEK_API_KEY) return undefined;
  const current = messages.at(-1)!.content;
  const history = messages.slice(-5, -1).map(({ role, content }) => ({
    role,
    content: content.slice(0, 800),
  }));
  const response = await getModelClient().chat.completions.create(
    {
      model,
      messages: [
        {
          role: "system",
          content:
            "你是中文待办助手小明的意图解析器。今天是 " +
            dateString(now) +
            "。只为最新一句调用一个工具，历史仅用于解释指代。不要重复历史操作，不要编造任务名或日期。" +
            "否定、假设、含糊的批量操作请用 clarify。疑问句不能当成完成声明。工具执行结果由服务端向用户报告。",
        },
        ...history,
        { role: "user", content: current },
      ],
      tools,
      tool_choice: "auto",
    },
    { timeout: 10000, maxRetries: 0 },
  );
  const calls = response.choices[0]?.message.tool_calls;
  if (calls?.length !== 1 || calls[0].type !== "function") return undefined;
  const call = calls[0].function;
  try {
    const args: unknown = JSON.parse(call.arguments);
    if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
    const parsed = intentSchema.safeParse({ ...args, action: call.name });
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};
