# 本地开发

## 启动服务

安装 Node.js 24.12 或更高版本，在仓库根目录执行 `npm ci` 和 `npm run dev`，然后打开 <http://127.0.0.1:3000>。修改服务端文件时开发服务会重启。修改界面后在另一终端执行 `npm run build` 并刷新页面。端口被占用时可用 `PORT=3001 npm run dev` 启动（macOS 或 Linux）。

## 启用 DeepSeek

用 `cp .env.example .env` 生成本地配置，将自己的 `DEEPSEEK_API_KEY` 填入 `.env`，再重启服务。`DEEPSEEK_MODEL` 可覆盖模板的默认模型。密钥由服务器读取，`.env` 在 Git 忽略清单中。

常见明确指令由本地解析器处理。对其他表述，设置密钥后，服务器将本轮消息及最多四条近期对话文本交给 DeepSeek 选择一个任务工具。调用可能产生模型费用。服务端校验工具参数、核对当前任务并执行操作，回复以实际存储结果为准。模型超时或返回无效参数时，小明会请用户换个说法。

## 验证接口

服务启动后，可分别用聊天接口创建任务并用 REST 接口核对状态。

```sh
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"帮我记一下洗衣服"}]}'
curl -sS http://127.0.0.1:3000/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"衣服洗好了"}]}'
curl -sS http://127.0.0.1:3000/api/tasks
```

最后一条命令返回的“洗衣服”应为 `"done": true`。默认数据文件是项目内的 `data/tasks.json`。查看、创建和更新任务均可通过同一个[任务 API](server/openapi.yaml)进行。

聊天接口始终返回 `reply` 文本。在展示清单或候选项时，附带的 `view` 记录用户看到的任务及顺序。自定义客户端要支持“第二项”这样的后续选择，应将上一轮的 `reply` 放入助手消息的 `content`，并原样回传该条消息的 `view`。内置网页已处理这一步。任务使用持久化 ID 定位，清单被其他窗口改动时不会按新顺序猜测编号。

## 代码入口

| 文件                                         | 用途                                                       |
| -------------------------------------------- | ---------------------------------------------------------- |
| `server/agent.ts`                            | 根据操作读取或更新同一份任务存储，处理重复、澄清和清单展示 |
| `server/intent.ts`、`server/model.ts`        | 常用中文指令、工具参数校验、DeepSeek 工具调用              |
| `server/task-store.ts`、`server/tasks.ts`    | 本地 JSON 存储与 REST 接口                                 |
| `src/ChatHistory.tsx`                        | 对话中的任务状态、属性和候选项按钮                         |
| `server/agent.test.ts`、`server/app.test.ts` | 聊天验收、存储及 HTTP 契约测试                             |

在项目根目录运行 `npm test`。可用 `npm run build` 后接 `npm start` 验证构建产物。
