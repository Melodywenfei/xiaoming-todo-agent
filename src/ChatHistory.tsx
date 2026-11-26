import { useEffect, useRef } from "react";
import type { ChatMessage, TaskView } from "../shared/chat.ts";
import { describeFields } from "../shared/task.ts";

const examplePrompts = ["提醒我买牛奶", "看看我的待办", "今天有哪些任务到期？"];

function TaskRows({ view, onChoose }: { view: TaskView; onChoose?: (prompt: string) => void }) {
  return (
    <ol className="task-rows">
      {view.rows.map((task, i) => {
        const fields = describeFields(task);
        return (
          <li key={task.id} className={task.done ? "task-done" : ""}>
            <strong>{task.title}</strong>
            <span className="task-state">{task.done ? "已完成" : "待办"}</span>
            {fields.length > 0 && <small>{fields.join(" · ")}</small>}
            {onChoose && (
              <button
                onClick={() => onChoose("第 " + (i + 1) + " 项")}
                aria-label={"选择" + task.title}
              >
                选第 {i + 1} 项
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

interface ChatHistoryProps {
  messages: ChatMessage[];
  pending: boolean;
  onSelectPrompt: (prompt: string) => void;
}

export function ChatHistory({ messages, pending, onSelectPrompt }: ChatHistoryProps) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [messages, pending]);

  return (
    <div className="scroll" ref={viewport}>
      {messages.length === 0 ? (
        <section className="welcome">
          <img src="/logo.png" alt="" />
          <h1>小明智能体</h1>
          <p>今天有什么待办？</p>
          <div className="examples">
            {examplePrompts.map((prompt) => (
              <button key={prompt} onClick={() => onSelectPrompt(prompt)}>
                {prompt}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <div className="thread" role="log" aria-label="对话记录" aria-live="polite">
          {messages.map((message, index) => (
            <div key={index} className={`message ${message.role}`}>
              <small>{message.role === "user" ? "你" : "小明智能体"}</small>
              <div>
                {message.view && message.view.kind !== "receipt" && message.view.rows.length > 0 ? (
                  <>
                    {message.content.split("\n")[0]}
                    <TaskRows
                      view={message.view}
                      onChoose={
                        message.view.kind === "choice" && index === messages.length - 1 && !pending
                          ? onSelectPrompt
                          : undefined
                      }
                    />
                  </>
                ) : (
                  message.content
                )}
              </div>
            </div>
          ))}
          {pending && <p role="status">正在回复…</p>}
        </div>
      )}
    </div>
  );
}
