import { z } from "zod";
import { changedFields, taskFields, taskTitle, type TaskFields } from "../shared/task.ts";

const query = z.string().trim().min(1).max(200);
export const argumentsByTool = {
  create: z.strictObject({ title: taskTitle, fields: taskFields.optional() }),
  list: z.strictObject({
    status: z.enum(["all", "open", "done"]).optional(),
    dueDate: z.iso.date().optional(),
  }),
  complete: z.strictObject({ query }),
  remove: z.strictObject({ query }),
  edit: z.strictObject({ query, fields: changedFields }),
  clarify: z.strictObject({ question: z.string().trim().min(1).max(250) }),
};
export const intentSchema = z.discriminatedUnion("action", [
  argumentsByTool.create.extend({ action: z.literal("create") }),
  argumentsByTool.list.extend({ action: z.literal("list") }),
  argumentsByTool.complete.extend({ action: z.literal("complete") }),
  argumentsByTool.remove.extend({ action: z.literal("remove") }),
  argumentsByTool.edit.extend({ action: z.literal("edit") }),
  argumentsByTool.clarify.extend({ action: z.literal("clarify") }),
]);
export type Intent = z.infer<typeof intentSchema>;

export function dateString(date: Date, offset = 0): string {
  const local = new Date(date);
  local.setDate(local.getDate() + offset);
  const month = String(local.getMonth() + 1).padStart(2, "0");
  const day = String(local.getDate()).padStart(2, "0");
  return [local.getFullYear(), month, day].join("-");
}

const dayPattern = "今天|今日|明天|后天|\\d{4}-\\d{1,2}-\\d{1,2}";
const dayWord = new RegExp(dayPattern, "u");
const leadingDate = new RegExp("^(" + dayPattern + ")(?:之前|前)?", "u");
const markedDate = new RegExp(
  "(?:截止(?:日期|时间)?|到期(?:日期)?)(?:[为是到在：:\\s]*)(" +
    dayPattern +
    ")|(" +
    dayPattern +
    ")(?:之前|前)?(?:到期|截止)",
  "u",
);
function resolveDate(word: string, now: Date) {
  if (/^\d/.test(word))
    return word
      .split("-")
      .map((part) => part.padStart(2, "0"))
      .join("-");
  return dateString(now, word === "明天" ? 1 : word === "后天" ? 2 : 0);
}

function tidy(text: string) {
  return text.replace(/^[\s,，、:：「『“"]+|[\s,，、。.!！:：」』”"]+$/gu, "").trim();
}
function fieldsIn(text: string, now: Date, useLeadingDate: boolean) {
  const fields: TaskFields = {};
  let rest = text.replace(
    /(?:优先级(?:别)?[\s为是：:]*(高|中|低)|(高|中|低)优先级)/u,
    (_, a, b) => {
      fields.priority = a || b;
      return "";
    },
  );
  rest = rest.replace(/工作量[\s为是：:]*(小|中|大)/u, (_, effort) => {
    fields.effort = effort;
    return "";
  });
  const date = markedDate.exec(rest) ?? (useLeadingDate ? leadingDate.exec(tidy(rest)) : null);
  if (date) {
    fields.dueDate = resolveDate(date[1] || date[2], now);
    rest = rest.replace(date[0], "");
  }
  return { fields, rest: tidy(rest) };
}

const help = (question: string): Intent => ({ action: "clarify", question });
export const examples = "可以说“帮我记一下洗衣服”“我有哪些任务？”或“衣服洗好了”。";
const requestPrefix = /^(?:小明[，,\s]*)?(?:(?:请|麻烦)你?)?(?:帮我|给我|帮忙|替我)?/u;
const add =
  /^(?:再)?(?:记一下|记一[条个项]|记下来|记下|记住|记个|添加|新增|新建|创建|加一[条项个]|加个|提醒我)(?:一[条个项]|个)?(?:待办(?:事项)?|任务|事项)?[\s：:]*/u;
const negative =
  /(?:还[没未]|尚未|并未|没(?:有)?(?:买|洗|取|写|交|做|弄|完成|好|删)|不(?:要|用|必|想)|别(?:再|把|删|标|完成|动)|先别)/u;
const broadTarget =
  /^(?:全部|所有|一切|整[个份张]清单|清单里(?:的)?(?:每一项|所有.*)|都|它们)(?:任务|待办|事项)?$/u;
const listRequest =
  /^(?:再)?(?:给我)?(?:看(?:一?下|看)?|列出|列一下|显示|查(?:看|一下)?|有什么|有哪些|有啥|有哪|还有|我(?:的|还)?有|我(?:的)?(?:清单|待办|任务)|待办清单|任务清单|清单$|今天|今日|明天|后天|\d{4}-)/u;

export function parseChinese(input: string, now: Date): Intent | undefined {
  const sentence = input.normalize("NFKC").trim().replace(requestPrefix, "");
  const text = sentence.replace(/[吧呀啦哦。.!！\s]+$/gu, "");
  if (/^(?:你好|您好|嗨|哈[啰喽]|帮助|使用说明|你能做什么)[？?]?$/u.test(text)) {
    return help("我是小明，可以帮你管理待办。" + examples);
  }
  if (/^(?:取消(?:操作|删除|修改)?|算了|不用了|(?:先|都)?不[改删]了?|先这样)$/u.test(text))
    return help("好的，这次没有更改清单。");
  if (
    /(?:然后|顺便|并且|同时|再帮我|[，,]\s*再)(?:把|帮我)?(?:删|记|加|标|完成|修改|添加)/u.test(
      text,
    )
  ) {
    return help("这句话里有多个操作。想先处理哪一件？");
  }

  // 先辨认明确的新增指令，标题本身可以包含「删除」「未完成」等词。
  if (add.test(text) && !/[?？]$/u.test(text)) {
    const { fields, rest } = fieldsIn(text.replace(add, ""), now, true);
    if (!taskTitle.safeParse(rest).success)
      return help("要记什么事？请给我一个 1 到 200 字的任务名。");
    if (!taskFields.safeParse(fields).success)
      return help("这个截止日期无效，请给我一个真实的日期。");
    return { action: "create", title: rest, fields };
  }

  if (listRequest.test(text) && /清单|任务|待办|到期|截止|哪些|完成的/u.test(text)) {
    const date = dayWord.exec(text);
    if (/到期|截止/u.test(text) && !date) return undefined;
    const dueDate = date ? resolveDate(date[0], now) : undefined;
    if (dueDate && !z.iso.date().safeParse(dueDate).success)
      return help("要查哪一天？请给我有效日期。");
    const open = /未完成|没(?:有)?完成|还没|剩下|还要|还需|没做|待处理/u.test(text);
    const done = /已(?:经)?完成|做完的/u.test(text);
    const includeDone = /(?:包括|包含|含)(?:已(?:经)?完成|做完)/u.test(text);
    const all = /所有|全部/u.test(text);
    return {
      action: "list",
      status:
        includeDone || (open && done)
          ? "all"
          : open
            ? "open"
            : done
              ? "done"
              : dueDate && !all
                ? "open"
                : "all",
      dueDate,
    };
  }
  if (negative.test(text)) return help("清单保持原样。" + examples);
  if (/^(?:如果|假如|假设|是否)|(?:好|完|完成)了?(?:吗|么|没)[?？]?$/u.test(text)) {
    return help("可以说“查看清单”确认任务状态，或说“把某项标记为完成”。");
  }
  if (/^(?:能否)|(?:吗|么|[?？])$/u.test(text)) return undefined;
  if (
    /清空|(?:全部|所有|一键|批量).*(?:删除|删掉|完成)|(?:删掉?|删除|完成)(?:全部|所有)/u.test(text)
  ) {
    return help("想处理哪一项？可以先说“查看清单”，再告诉我任务名或编号。");
  }

  const change =
    /^(?:把|将)?(.+?)(?:的)?(?:改成|改为|改到|设为|调整为|设置为|改一下)[\s:：]*(.+)$/u.exec(text);
  if (change) {
    // 「把周报的优先级改成高」与「把周报改成高优先级」得到同一组字段。
    const trailingField = /(?:的)?(优先级|工作量|截止日期|截止时间|截止日|截止)$/u.exec(change[1]);
    const target = trailingField ? change[1].slice(0, trailingField.index) : change[1];
    const label = trailingField?.[1] || "";
    const values = (label.startsWith("截止") ? "截止" : label) + change[2];
    const { fields, rest } = fieldsIn(values, now, true);
    if (changedFields.safeParse(fields).success && !rest)
      return { action: "edit", query: tidy(target), fields };
    return undefined;
  }

  const subject = text.replace(/^(?:(?:我)?(?:已经|刚刚|刚才|刚))?(?:我)?(?:把|将)?/u, "");
  const remove =
    /^(?:删除|删掉?|移除|去掉)\s*(.+)$|^(.+?)(?:这[一]?[条项]|那[条项])?(?:给我)?(?:删除|删掉|删了|移除|去掉)$/u.exec(
      subject,
    );
  if (remove) {
    const target = tidy(remove[1] || remove[2]).replace(/^(?:任务|待办)[：:\s]+/u, "");
    return broadTarget.test(target)
      ? help("请指定要删除的任务名。")
      : { action: "remove", query: target };
  }
  const finish =
    /^(?:完成了?|标记完成)\s*(.+)$|^(.+?)(?:这[一]?[条项])?(?:已经|已)?(?:标记?为(?:已)?完成|标记完成|做完了?|完成了|搞定了?|弄好了?)$/u.exec(
      subject,
    );
  if (finish) return { action: "complete", query: tidy(finish[1] || finish[2]) };
  const result =
    /^(.+?)(买|洗|取|写|交|寄|发|做|看|读|修|还|付|拿)(?:好了?|完了?|到了?|过了|了)$/u.exec(
      subject,
    );
  if (result) return { action: "complete", query: result[2] + tidy(result[1]) };
  const finishedTitle = /^(.+?)(?:好了|完了)$/u.exec(subject);
  if (finishedTitle) return { action: "complete", query: tidy(finishedTitle[1]) };
  return undefined;
}
