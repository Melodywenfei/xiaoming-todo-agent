import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatAnswer, ChatMessage } from "../shared/chat.ts";
import { createAgent } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";
import { planWithDeepSeek } from "./model.ts";

const clock = () => new Date(2026, 11, 31, 23, 50);
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "xiaoming-chat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "tasks.json");
  const tasks = createJsonTaskStore(file);
  const reply = createAgent(tasks, { clock, modelPlanner: async () => undefined });
  const messages: ChatMessage[] = [];
  async function say(content: string) {
    messages.push({ role: "user", content });
    const answer = await reply(messages);
    messages.push({ role: "assistant", content: answer.reply, view: answer.view });
    return answer;
  }
  return { file, tasks, say };
}

async function listen(file: string) {
  const tasks = createJsonTaskStore(file);
  const reply = createAgent(tasks, { clock, modelPlanner: async () => undefined });
  const server = createApp({ tasks, reply }).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const history: ChatMessage[] = [];
  async function chat(content: string) {
    history.push({ role: "user", content });
    const res = await fetch(base + "/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history }),
    });
    assert.equal(res.status, 200);
    const answer = (await res.json()) as ChatAnswer;
    history.push({ role: "assistant", content: answer.reply, view: answer.view });
    return answer;
  }
  return { base, chat, close: () => server[Symbol.asyncDispose]() };
}

test("官方六轮验收通过真实聊天 API，刷新与服务重开后状态一致", async (t) => {
  const { file } = await fixture(t);
  const app = await listen(file);
  try {
    await app.chat("帮我记一下买牛奶");
    await app.chat("再记一条取快递");
    assert.deepEqual(
      (await app.chat("我有哪些任务？")).view?.rows.map((r) => [r.title, r.done]),
      [
        ["买牛奶", false],
        ["取快递", false],
      ],
    );
    await app.chat("牛奶买好了");
    assert.deepEqual(
      (await (await fetch(app.base + "/api/tasks")).json()).map(
        (t: { title: string; done: boolean }) => [t.title, t.done],
      ),
      [
        ["买牛奶", true],
        ["取快递", false],
      ],
    );
    await app.chat("取快递这条删掉吧");
    const last = await app.chat("再给我看看清单");
    assert.equal(last.view?.rows.length, 1);
    assert.match(last.reply, /买牛奶（已完成）/u);
  } finally {
    await app.close();
  }
  const reopened = await listen(file);
  try {
    const list = await reopened.chat("查看清单");
    assert.deepEqual(
      list.view?.rows.map((r) => [r.title, r.done]),
      [["买牛奶", true]],
    );
  } finally {
    await reopened.close();
  }
});

test("相同任务重复添加与重复完成，否定和疑问不会误改同名物品", async (t) => {
  const { say, tasks } = await fixture(t);
  await say("帮我记一下洗衣服");
  await say("帮我记一下洗衣服");
  await say("帮我记一下晾衣服");
  await say("衣服还没洗好");
  await say("衣服洗好了吗？");
  assert.deepEqual(
    tasks.list().map((t) => t.done),
    [false, false],
  );
  await say("我已经把衣服洗好了");
  assert.match((await say("衣服洗好了")).reply, /已经/u);
  assert.deepEqual(
    tasks.list().map((t) => t.done),
    [true, false],
  );
  await say("删除不存在的任务");
  assert.equal(tasks.list().length, 2);
});

test("按候选项的稳定 ID 选任务，编号越界、取消、列表变化均不误删", async (t) => {
  const { say, tasks } = await fixture(t);
  const a = tasks.create("交财务报告");
  const b = tasks.create("交统计报告");
  const c = tasks.create("交实习报告");
  const options = await say("把报告删掉");
  assert.equal(options.view?.kind, "choice");
  assert.equal((await say("第九项")).view?.rows.length, 3);
  await say("取消");
  assert.equal(tasks.list().length, 3);
  await say("把报告删掉");
  tasks.remove(a.id);
  await say("第二项");
  assert.equal(
    tasks.list().some((task) => task.id === b.id),
    false,
  );
  assert.equal(tasks.list()[0].id, c.id);
  const d = tasks.create("交项目报告");
  await say("删除报告");
  tasks.remove(d.id);
  assert.match((await say("第二项")).reply, /更改或移除/u);
  assert.equal(tasks.list()[0].id, c.id);
});

test("显示编号与筛选后顺序一致，也能用完整任务名消除歧义", async (t) => {
  const { say, tasks } = await fixture(t);
  const a = tasks.create("交统计报告");
  tasks.update(a.id, { done: true });
  const b = tasks.create("交财务报告");
  assert.deepEqual(
    (await say("查看清单")).view?.rows.map((t) => t.id),
    [b.id, a.id],
  );
  await say("把第二项删掉");
  assert.deepEqual(
    tasks.list().map((t) => t.id),
    [b.id],
  );
  tasks.create("交实习报告");
  await say("把报告标记为完成");
  await say("交实习报告");
  assert.deepEqual(
    tasks.list().map((t) => t.done),
    [false, true],
  );
});

test("到期查询、跨年日期、优先级和工作量通过聊天创建及修改", async (t) => {
  const { tasks, say } = await fixture(t);
  await say("帮我记一下今天交周报，优先级高，工作量中");
  await say("再记一条明天买饲料");
  await say("帮我记一下 2026-02-30 买牛奶");
  assert.equal(tasks.list().length, 2);
  assert.deepEqual(
    tasks.list().map((t) => t.dueDate),
    ["2026-12-31", "2027-01-01"],
  );
  assert.deepEqual(
    (await say("今天有哪些任务到期？")).view?.rows.map((t) => t.title),
    ["交周报"],
  );
  await say("把周报的优先级改成低");
  await say("把周报的工作量改成大");
  await say("把周报的截止日期改成明天");
  assert.deepEqual((await say("今天有哪些任务到期？")).view?.rows, []);
  const first = tasks.list()[0];
  assert.deepEqual([first.dueDate, first.priority, first.effort], ["2027-01-01", "低", "大"]);
  await say("周报交好了");
  assert.equal((await say("明天有哪些任务到期？")).view?.rows.length, 1);
});

test("REST 与聊天共享扩展字段，错误的日期或优先级不会覆盖原数据", async (t) => {
  const { file } = await fixture(t);
  const app = await listen(file);
  try {
    const response = await fetch(app.base + "/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "核对日报",
        dueDate: "2026-12-31",
        priority: "中",
        effort: "小",
      }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    for (const fields of [{ dueDate: "2026-02-30" }, { priority: "紧急" }]) {
      const update = await fetch(app.base + "/api/tasks/" + created.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
      });
      assert.equal(update.status, 400);
    }
    const listing = await app.chat("今天有哪些任务到期？");
    assert.deepEqual(listing.view?.rows[0], created);
    await app.chat("把核对日报标记为完成");
    assert.deepEqual((await app.chat("查看所有已完成的任务")).view?.rows, [
      { ...created, done: true },
    ]);
    assert.deepEqual((await app.chat("今天有哪些任务到期？")).view?.rows, []);
  } finally {
    await app.close();
  }
});

test("处理模型工具调用，损坏的参数、多次调用或网络失败均不修改清单", async (t) => {
  const { tasks } = await fixture(t);
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "offline-sdk-test";
  t.after(() => {
    if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = oldKey;
  });
  let calls = [
    {
      id: "test",
      type: "function",
      function: { name: "create", arguments: JSON.stringify({ title: "审阅预算" }) },
    },
  ];
  let offline = false;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, params: RequestInit) => {
      const body = JSON.parse(String(params.body));
      assert.ok(
        body.tools.some(
          (tool: { function: { name: string } }) => tool.function.name === "complete",
        ),
      );
      if (offline) throw new Error("offline");
      return Response.json({
        id: "test",
        choices: [
          {
            message: { role: "assistant", content: null, tool_calls: calls },
            finish_reason: "tool_calls",
          },
        ],
      });
    },
  );
  const reply = createAgent(tasks, { clock, modelPlanner: planWithDeepSeek });
  const messages: ChatMessage[] = [{ role: "user", content: "预算审阅这件事也替我安排上" }];
  assert.match((await reply(messages)).reply, /已记下/u);
  const contents = tasks.list();
  calls[0].function = { name: "remove", arguments: "{" };
  await reply(messages);
  calls[0].function = { name: "remove", arguments: JSON.stringify({ query: "审阅预算" }) };
  calls = [calls[0], calls[0]];
  await reply(messages);
  offline = true;
  await reply(messages);
  assert.deepEqual(tasks.list(), contents);
  assert.equal(fetchMock.mock.callCount(), 4);
});
