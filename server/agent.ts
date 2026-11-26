import type { ChatAnswer, ChatMessage, PendingAction, TaskView } from "../shared/chat.ts";
import { describeFields, taskFields, type VisibleTask } from "../shared/task.ts";
import { examples, intentSchema, parseChinese, type Intent } from "./intent.ts";
import { planWithDeepSeek, type ModelPlanner } from "./model.ts";
import type { Task, TaskStore } from "./task-store.ts";

function visible(task: Task): VisibleTask {
  const { id, title, done } = task;
  // 旧清单可能带有其他程序写入的字段，仅展示当前版本能解释的值。
  const view: VisibleTask = { id, title, done };
  const { dueDate, priority, effort } = taskFields.shape;
  const date = dueDate.safeParse(task.dueDate);
  const importance = priority.safeParse(task.priority);
  const work = effort.safeParse(task.effort);
  if (date.success && date.data) view.dueDate = date.data;
  if (importance.success && importance.data) view.priority = importance.data;
  if (work.success && work.data) view.effort = work.data;
  return view;
}

function summary(view: TaskView, heading: string): ChatAnswer {
  const lines = view.rows.map((task, i) => {
    const labels = [task.done ? "已完成" : "待办", ...describeFields(task)];
    return i + 1 + ". " + task.title.replace(/\s+/gu, " ") + "（" + labels.join(" · ") + "）";
  });
  return { reply: [heading, ...lines].join("\n"), view };
}

function receipt(task: Task, reply: string): ChatAnswer {
  return { reply, view: { kind: "receipt", rows: [visible(task)] } };
}

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s「」“”『』"'《》。，、.!！?？]/gu, "");
}
function matches<T extends { title: string }>(tasks: T[], query: string): T[] {
  const needle = normalize(query);
  if (!needle) return [];
  const exact = tasks.filter((task) => normalize(task.title) === needle);
  if (exact.length || [...needle].length < 2) return exact;
  return tasks.filter((task) => normalize(task.title).includes(needle));
}

function ordinal(text: string): number | undefined {
  const value = normalize(text);
  if (value === "最后一项" || value === "最后一条" || value === "最后一个") return -1;
  const match = /^(?:第|选(?:择)?第?)?(\d+|[一二两三四五六七八九十]+)(?:项|条|个)?$/u.exec(value);
  if (!match) return undefined;
  if (/^\d+$/u.test(match[1])) return Number(match[1]);
  const digits = "零一二三四五六七八九";
  const chinese = match[1].replace("两", "二");
  if (chinese.length === 1 && chinese !== "十") return digits.indexOf(chinese);
  const tens = /^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u.exec(chinese);
  return tens
    ? (tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0)
    : undefined;
}

const verbs = { complete: "完成", remove: "删除", edit: "修改" };
function choose(rows: VisibleTask[], pending: PendingAction): ChatAnswer {
  return summary(
    { kind: "choice", rows, pending },
    "要" + verbs[pending.action] + "哪一项？回复编号或完整任务名，也可以说“取消”。",
  );
}

function applyTarget(store: TaskStore, task: Task, intent: PendingAction): ChatAnswer {
  if (intent.action === "remove") {
    return {
      reply: store.remove(task.id)
        ? "已删除「" + task.title + "」。"
        : "这项任务已被移除，请再看一次清单。",
    };
  }
  if (intent.action === "complete" && task.done)
    return receipt(task, "「" + task.title + "」已经是已完成状态。");
  const updated = store.update(
    task.id,
    intent.action === "complete" ? { done: true } : intent.fields,
  );
  if (!updated) return { reply: "这项任务已经不在清单里了，请再看一次清单。" };
  const message =
    intent.action === "complete"
      ? "已完成「" + task.title + "」。"
      : "已更新「" + task.title + "」：" + describeFields(intent.fields).join("，") + "。";
  return receipt(updated, message);
}

function applyShown(
  store: TaskStore,
  current: Task[],
  shown: VisibleTask | undefined,
  intent: PendingAction,
) {
  const task = current.find((item) => item.id === shown?.id);
  if (!task || task.title !== shown?.title)
    return { reply: "这项任务已更改或移除。请重新查看清单后再选。" };
  return applyTarget(store, task, intent);
}

function execute(intent: Intent, store: TaskStore, view?: TaskView): ChatAnswer {
  if (intent.action === "clarify") return { reply: intent.question };
  const tasks = store.list();
  if (intent.action === "create") {
    const fields = intent.fields || {};
    const duplicate = tasks.find(
      (task) =>
        !task.done &&
        normalize(task.title) === normalize(intent.title) &&
        task.dueDate === fields.dueDate &&
        task.priority === fields.priority &&
        task.effort === fields.effort,
    );
    if (duplicate) return receipt(duplicate, "清单里已有相同的待办「" + duplicate.title + "」。");
    const created = store.create(intent.title, fields);
    const details = describeFields(fields);
    return receipt(
      created,
      "已记下「" + created.title + "」" + (details.length ? "，" + details.join("，") : "") + "。",
    );
  }
  if (intent.action === "list") {
    const rows = tasks
      .filter(
        (task) =>
          (!intent.dueDate || task.dueDate === intent.dueDate) &&
          (intent.status === "open" ? !task.done : intent.status === "done" ? task.done : true),
      )
      .sort((a, b) => Number(a.done) - Number(b.done))
      .map(visible);
    const scope =
      (intent.dueDate ? intent.dueDate + " 到期的" : "") +
      (intent.status === "open" ? "待办任务" : intent.status === "done" ? "已完成任务" : "任务");
    if (!rows.length) return summary({ kind: "list", rows }, "目前没有" + scope + "。");
    const open = rows.filter((row) => !row.done).length;
    return summary(
      { kind: "list", rows },
      scope +
        "共 " +
        rows.length +
        " 项，待办 " +
        open +
        " 项，已完成 " +
        (rows.length - open) +
        " 项。",
    );
  }

  const pending: PendingAction =
    intent.action === "edit"
      ? { action: "edit", fields: intent.fields }
      : { action: intent.action };
  const number = ordinal(intent.query);
  const pronoun = /^(?:它|这条|这一条|这个|这件事|这项|刚才那条)$/u.test(normalize(intent.query));
  if (number !== undefined || pronoun) {
    if (!view?.rows.length) return { reply: "请先查看清单，或告诉我任务的完整名称。" };
    if (pronoun && view.rows.length > 1) return choose(view.rows, pending);
    const index = number === -1 ? view.rows.length - 1 : (number ?? 1) - 1;
    if (!view.rows[index]) return summary(view, "这个编号不在刚才的清单里，请重新选择。");
    return applyShown(store, tasks, view.rows[index], pending);
  }
  let found = matches(tasks, intent.query);
  if (intent.action === "complete" && found.some((task) => !task.done))
    found = found.filter((task) => !task.done);
  if (!found.length)
    return { reply: "清单里没有找到「" + intent.query + "」。可以说“查看清单”核对名称。" };
  if (found.length > 1) return choose(found.map(visible), pending);
  return applyTarget(store, found[0], pending);
}

interface AgentOptions {
  clock?: () => Date;
  modelPlanner?: ModelPlanner;
}
export function createAgent(
  store: TaskStore,
  { clock = () => new Date(), modelPlanner = planWithDeepSeek }: AgentOptions = {},
) {
  return async (messages: ChatMessage[]): Promise<ChatAnswer> => {
    const text = messages.at(-1)?.content.trim() || "";
    const previous = messages.at(-2);
    const view = previous?.role === "assistant" ? previous.view : undefined;
    const now = clock();
    const local = parseChinese(text, now);

    if (view?.kind === "choice" && !local) {
      const number = ordinal(text);
      if (number !== undefined) {
        const row =
          number === -1 ? view.rows.at(-1) : number > 0 ? view.rows[number - 1] : undefined;
        return row
          ? applyShown(store, store.list(), row, view.pending)
          : choose(view.rows, view.pending);
      }
      const candidates = matches(view.rows, text);
      if (candidates.length === 1)
        return applyShown(store, store.list(), candidates[0], view.pending);
      if (candidates.length > 1) return choose(candidates, view.pending);
    }
    let intent = local;
    if (!intent) {
      try {
        intent = await modelPlanner(messages, now);
      } catch {
        return { reply: "暂时未能理解这句话，清单没有更改。" + examples };
      }
    }
    if (!intent && view?.kind === "choice") return choose(view.rows, view.pending);
    const checked = intentSchema.safeParse(intent);
    return checked.success
      ? execute(checked.data, store, view)
      : { reply: "请再具体一点。" + examples };
  };
}
