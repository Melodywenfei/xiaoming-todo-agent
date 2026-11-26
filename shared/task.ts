import { z } from "zod";

export const taskTitle = z.string().trim().min(1).max(200);
export const taskFields = z.strictObject({
  dueDate: z.iso.date().optional(),
  priority: z.enum(["高", "中", "低"]).optional(),
  effort: z.enum(["小", "中", "大"]).optional(),
});
export const changedFields = taskFields.refine((fields) => Object.keys(fields).length > 0);
export type TaskFields = z.infer<typeof taskFields>;

export const visibleTask = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  ...taskFields.shape,
});
export type VisibleTask = z.infer<typeof visibleTask>;

export function describeFields(task: TaskFields): string[] {
  const labels: string[] = [];
  if (task.dueDate) labels.push("截止 " + task.dueDate);
  if (task.priority) labels.push(task.priority + "优先级");
  if (task.effort) labels.push("工作量" + task.effort);
  return labels;
}
