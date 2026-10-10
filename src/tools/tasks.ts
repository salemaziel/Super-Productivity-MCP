import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResolvedDirs } from '../ipc/directories.js';
import { sendCommand } from '../ipc/command-sender.js';
import type { TaskFilters } from '../ipc/types.js';
import { deriveSchedule, findOverlaps, localDateStr, plannedTimeOf, type ScheduleBlock } from './schedule.js';
import { enrichTask, loadRefs, type Refs } from '../enrich.js';
import { errorResult, okResult } from './result.js';
import { minuteFloor } from './time.js';

// Re-export for consumers that previously imported these from tasks.js.
export { localDateStr, plannedTimeOf } from './schedule.js';
import { parseDuration } from './duration.js';

interface TaskRecord {
  id: string;
  title: string;
  isDone: boolean;
  projectId: string | null;
  parentId?: string | null;
  tagIds: string[];
  notes?: string;
  dueDay?: string | null;
  dueWithTime?: number | null;
  timeSpentOnDay?: Record<string, number>;
  timeEstimate: number;
  timeSpent: number;
  doneOn?: number | null;
  repeatCfgId?: string | null;
  subTaskIds?: string[];
  [key: string]: unknown;
}



/**
 * Shape a task for API responses: expose the canonical planned time as `plannedTime`.
 */
export function shapeForResponse(t: TaskRecord): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...t };
  copy.plannedTime = plannedTimeOf(t);
  return copy;
}

/** Re-fetch tasks by id after a write so callers get the effective stored values (no silent writes). */
export async function fetchTasksByIds(
  dirs: ResolvedDirs,
  ids: string[],
): Promise<Record<string, Record<string, unknown> | null>> {
  const byId: Record<string, Record<string, unknown> | null> = {};
  if (!ids.length) return byId;
  for (const id of ids) byId[id] = null;
  const res = await sendCommand(dirs, 'getTasks', { filters: { includeDone: true, includeArchived: true } });
  if (!res.success) return byId;
  for (const t of (res.result as TaskRecord[]) ?? []) {
    if (t.id in byId) byId[t.id] = shapeForResponse(t);
  }
  return byId;
}

async function fetchTask(dirs: ResolvedDirs, taskId: string): Promise<Record<string, unknown> | null> {
  const tasks = await fetchTasksByIds(dirs, [taskId]);
  return tasks[taskId] ?? null;
}

/**
 * Write-side hygiene for the container model: SP core re-aggregates a parent's
 * timeEstimate as the sum of its children's estimates whenever a child is
 * updated (see bug-report sp-parent-estimate-auto-aggregated). After touching
 * tasks, re-zero timeEstimate on any CONTAINER parent (has subtasks) that is
 * not itself planned (no dueWithTime). The parent write itself sticks — only
 * child updates trigger SP's aggregation. Returns the ids of re-zeroed parents
 * so callers can include them in their echo.
 */
export async function rezeroUnplannedParents(
  dirs: ResolvedDirs,
  touchedTaskIds: string[],
): Promise<string[]> {
  const touched = new Set(touchedTaskIds);
  if (!touched.size) return [];
  const res = await sendCommand(dirs, 'getTasks', { filters: { includeDone: true, includeArchived: true } });
  if (!res.success) return [];
  const tasks = (res.result as TaskRecord[]) ?? [];
  const parentIds = new Set<string>();
  for (const t of tasks) {
    if (t.parentId && touched.has(t.id)) parentIds.add(t.parentId);
  }
  if (!parentIds.size) return [];
  const fixes = tasks
    .filter(t => parentIds.has(t.id) && !t.dueWithTime && (t.subTaskIds?.length ?? 0) > 0 && (t.timeEstimate ?? 0) > 0)
    .map(t => ({ taskId: t.id, data: { timeEstimate: 0 } }));
  if (!fixes.length) return [];
  const fixRes = await sendCommand(dirs, 'bulkUpdateTasks', { updates: fixes });
  return fixRes.success ? fixes.map(f => f.taskId) : [];
}

/** Apply triage filters to a task list. Exported for testability. */
export function applyTriageFilters(
  tasks: TaskRecord[],
  opts: { parentsOnly?: boolean; overdue?: boolean; unscheduled?: boolean; plannedForToday?: boolean },
): TaskRecord[] {
  let result = tasks;
  if (opts.parentsOnly) result = result.filter(t => !t.parentId);
  if (opts.overdue) {
    const today = localDateStr();
    result = result.filter(t => t.dueDay != null && (t.dueDay as string) < today);
  }
  if (opts.unscheduled) result = result.filter(t => !t.dueDay && !t.dueWithTime);
  if (opts.plannedForToday) {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfTomorrow = startOfToday + 86_400_000;
    result = result.filter(t => {
      const p = plannedTimeOf(t);
      return p != null && p >= startOfToday && p < startOfTomorrow;
    });
  }
  return result;
}

/** Tasks whose planned time (start) falls on the given local date. Exported for testability. */
export function filterScheduledOn(tasks: TaskRecord[], date: string): TaskRecord[] {
  const startOfDay = new Date(`${date}T00:00:00`).getTime();
  const startOfNextDay = startOfDay + 86_400_000;
  return tasks.filter(t => {
    const p = plannedTimeOf(t);
    return p != null && p >= startOfDay && p < startOfNextDay;
  });
}

/** Tasks completed (doneOn) on the given local date. Exported for testability. */
export function filterCompletedOn(tasks: TaskRecord[], date: string): TaskRecord[] {
  return tasks.filter(t => t.isDone && t.doneOn != null && localDateStr(new Date(t.doneOn)) === date);
}

/** Tasks that are members of at least one overlap cluster (needs planned time + estimate). */
export function filterOverlapping(tasks: TaskRecord[]): TaskRecord[] {
  const now = Date.now();
  const clusters = findOverlaps(
    tasks
      .filter(t => !t.isDone)
      .map(t => {
        const s = deriveSchedule(t, now);
        return { taskId: t.id, startMs: s.startMs, endMs: s.endMs };
      }),
  );
  const ids = new Set(clusters.flatMap(c => c.taskIds));
  return tasks.filter(t => ids.has(t.id));
}

export type SortBy = 'planned_time' | 'title' | 'due_day' | 'time_estimate';
export type SortDir = 'asc' | 'desc';

/** Stable sort of tasks by a schedule-aware key. Exported for testability. */
export function sortTasks(tasks: TaskRecord[], by: SortBy, dir: SortDir): TaskRecord[] {
  const mult = dir === 'desc' ? -1 : 1;
  const cmp = (a: TaskRecord, b: TaskRecord): number => {
    switch (by) {
      case 'planned_time': {
        const pa = plannedTimeOf(a) ?? Number.MAX_SAFE_INTEGER;
        const pb = plannedTimeOf(b) ?? Number.MAX_SAFE_INTEGER;
        return (pa - pb) * mult;
      }
      case 'due_day': {
        const da = a.dueDay ?? '9999-12-31';
        const db = b.dueDay ?? '9999-12-31';
        if (da === db) return 0;
        return (da < db ? -1 : 1) * mult;
      }
      case 'time_estimate':
        return ((a.timeEstimate ?? 0) - (b.timeEstimate ?? 0)) * mult;
      case 'title':
      default:
        return a.title.localeCompare(b.title) * mult;
    }
  };
  return [...tasks].sort(cmp);
}

const DERIVED_SCHEDULE_FIELDS = ['startMs', 'endMs', 'startTime', 'endTime', 'durationMs', 'status'];

/** Project a subset of fields, computing derived schedule fields on demand. Exported for testability. */
export function projectFields(t: TaskRecord, fields: string[], now: number, refs?: Refs): Record<string, unknown> {
  const needRefs = refs !== undefined && (fields.includes('projectTitle') || fields.includes('tags'));
  const enriched = needRefs ? enrichTask(t, refs) : null;
  const obj: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === 'plannedTime') {
      obj[f] = plannedTimeOf(t);
    } else if (DERIVED_SCHEDULE_FIELDS.includes(f)) {
      obj[f] = (deriveSchedule(t, now) as unknown as Record<string, unknown>)[f];
    } else if ((f === 'projectTitle' || f === 'tags') && enriched) {
      obj[f] = (enriched as unknown as Record<string, unknown>)[f];
    } else if (f in t) {
      obj[f] = (t as Record<string, unknown>)[f];
    }
  }
  return obj;
}

export interface TaskDetail {
  task: Record<string, unknown> & { schedule: ScheduleBlock };
  parent: { id: string; title: string } | null;
  subtasks: Array<{ id: string; title: string; isDone: boolean }>;
  timeSpentLast14Days: Record<string, number>;
}

/** Compose a fully-resolved single-task view. Exported for testability. */
export function composeTaskDetail(task: TaskRecord, allTasks: TaskRecord[], refs: Refs, now: number): TaskDetail {
  const shaped = shapeForResponse(enrichTask(task, refs));
  const parent = task.parentId
    ? (() => {
        const p = allTasks.find(t => t.id === task.parentId);
        return p ? { id: p.id, title: p.title } : null;
      })()
    : null;
  const subtasks = allTasks
    .filter(t => t.parentId === task.id)
    .map(t => ({ id: t.id, title: t.title, isDone: t.isDone }));
  const cutoff = localDateStr(new Date(now - 14 * 86_400_000));
  const timeSpentLast14Days: Record<string, number> = {};
  for (const [date, ms] of Object.entries(task.timeSpentOnDay ?? {})) {
    if (date >= cutoff) timeSpentLast14Days[date] = ms;
  }
  return { task: { ...shaped, schedule: deriveSchedule(task, now) }, parent, subtasks, timeSpentLast14Days };
}
// Every tool schema below is wrapped in `.strict()` so a call with an unrecognized
// parameter fails validation instead of silently stripping it — issue #101 found
// this could look like a successful call ("update_task" with a typo'd field name)
// that silently wrote nothing. Nested array-item schemas (bulk_update_tasks'
// `updates[]`, create_task's `subtasks[]`) get the same treatment for the same reason.

const createTaskShape = {
  title: z.string().describe('Task title. May include SP short syntax: #tag +project @due-date 30m'),
  notes: z.string().optional().describe('Task notes/description'),
  project_id: z.string().optional().describe('Project ID to assign task to'),
  parent_id: z.string().optional().describe('Parent task ID for creating subtasks'),
  tag_ids: z.array(z.string()).optional().describe('Tag IDs to assign'),
  deadline_day: z.string().optional().describe('Deadline date in ISO format (e.g. 2026-04-20). Independent from due_day/due_with_time.'),
};
export const createTaskSchema = z.object(createTaskShape).strict();

const getTasksShape = {
  project_id: z.string().optional().describe('Filter by project ID'),
  tag_id: z.string().optional().describe('Filter by tag ID'),
  include_done: z.boolean().optional().default(false).describe('Include completed tasks'),
  include_archived: z.boolean().optional().default(false).describe('Include archived tasks'),
  search_query: z.string().optional().describe('Case-insensitive title search'),
  parents_only: z.boolean().optional().default(false).describe('Exclude subtasks — return only top-level tasks'),
  overdue: z.boolean().optional().default(false).describe('Return only tasks with a due date strictly before today'),
  unscheduled: z.boolean().optional().default(false).describe('Return only tasks with no due date and no scheduled time'),
  planned_for_today: z.boolean().optional().default(false).describe('Return only tasks planned for today (via dueWithTime timestamp)'),
  recurring_only: z.boolean().optional().default(false).describe('Return only recurring tasks (those with a repeatCfgId)'),
  scheduled_on: z.string().optional().describe('Return only tasks whose planned time (start) falls on this date (YYYY-MM-DD)'),
  completed_on: z.string().optional().describe('Return only tasks completed (doneOn) on this date (YYYY-MM-DD)'),
  overlapping: z.boolean().optional().default(false).describe('Return only tasks involved in a time conflict (their scheduled window overlaps another task; requires planned time + positive estimate)'),
  sort_by: z.enum(['planned_time', 'title', 'due_day', 'time_estimate']).optional().describe('Sort result by this field'),
  sort_dir: z.enum(['asc', 'desc']).optional().default('asc').describe('Sort direction (default asc)'),
  include_schedule: z.boolean().optional().default(false).describe('Append a derived schedule block { startMs, endMs, startTime, endTime, durationMs, status } to each full task (start = plannedTime, size = timeEstimate). Ignored when fields is provided.'),
  fields: z.array(z.string()).optional().describe('Return only these fields per task (e.g. ["id", "title", "dueDay"]). Omit for full objects. "plannedTime" returns the effective planned timestamp (SP field dueWithTime). Derived schedule fields are also supported: "startMs", "endMs", "startTime", "endTime", "durationMs", "status".'),
};
export const getTasksSchema = z.object(getTasksShape).strict();

const getTaskShape = {
  task_id: z.string().describe('Task ID to fetch'),
};
export const getTaskSchema = z.object(getTaskShape).strict();

const updateTaskShape = {
  task_id: z.string().describe('Task ID to update'),
  title: z.string().optional().describe('New title (may include SP short syntax)'),
  notes: z.string().optional().describe('New notes'),
  is_done: z.boolean().optional().describe('Mark as done/undone'),
  due_day: z.string().optional().describe('Due date in ISO format (e.g. 2026-04-20), or empty string to clear'),
  deadline_day: z.string().optional().describe('Deadline date in ISO format (e.g. 2026-04-20), or empty string to clear. Independent from due_day/due_with_time.'),
  due_with_time: z.number().nullable().optional().describe('Unix ms timestamp to plan task at an exact time (maps to SP dueWithTime; e.g. Date.now() = "plan from now until next task"). Floored to the whole minute on write — 1 minute is the smallest scheduling unit. Pass null to unplan. Independent from due_day.'),
  time_estimate: z.number().optional().describe('Time estimate in milliseconds'),
  time_spent: z.number().optional().describe('Time spent in milliseconds'),
  time_spent_on_day: z
    .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'), z.number().int().nonnegative().describe('ms'))
    .optional()
    .describe('Merge these per-day values into the timeSpentOnDay bucket (corrections; dates not listed are untouched; total timeSpent is recomputed as the bucket sum unless time_spent is also given)'),
  tag_ids: z.array(z.string()).optional().describe('Bulk-replace all tags with this list (FR-003)'),
};
export const updateTaskSchema = z.object(updateTaskShape).strict();

const completeTaskShape = {
  task_id: z.string().describe('Task ID to complete'),
};
export const completeTaskSchema = z.object(completeTaskShape).strict();

const addTagToTaskShape = {
  task_id: z.string().describe('Task ID'),
  tag_id: z.string().describe('Tag ID to add'),
};
export const addTagToTaskSchema = z.object(addTagToTaskShape).strict();

const removeTagFromTaskShape = {
  task_id: z.string().describe('Task ID'),
  tag_id: z.string().describe('Tag ID to remove'),
};
export const removeTagFromTaskSchema = z.object(removeTagFromTaskShape).strict();

const getCurrentTaskShape = {};
export const getCurrentTaskSchema = z.object(getCurrentTaskShape).strict();

const startTaskShape = {
  task_id: z.string().describe('Task ID to start tracking'),
};
export const startTaskSchema = z.object(startTaskShape).strict();

const stopTaskShape = {};
export const stopTaskSchema = z.object(stopTaskShape).strict();

const addTimeTodayShape = {
  task_id: z.string().describe('Task ID to add time to'),
  ms: z.number().int().nonnegative().describe('Elapsed milliseconds to add'),
};
export const addTimeTodaySchema = z.object(addTimeTodayShape).strict();

const bulkCompleteTasksShape = {
  task_ids: z.array(z.string()).max(100).describe('Array of task IDs to complete'),
};
export const bulkCompleteTasksSchema = z.object(bulkCompleteTasksShape).strict();

const bulkUpdateTaskItemShape = {
  task_id: z.string().describe('Task ID to update'),
  title: z.string().optional().describe('New title'),
  notes: z.string().optional().describe('New notes'),
  due_day: z.string().optional().describe('Due date (YYYY-MM-DD) or empty string to clear'),
  deadline_day: z.string().optional().describe('Deadline date (YYYY-MM-DD) or empty string to clear'),
  due_with_time: z.number().nullable().optional().describe('Unix ms timestamp to plan the task at an exact time (maps to SP dueWithTime). Floored to the whole minute on write — 1 minute is the smallest scheduling unit. Pass null to unplan. Independent from due_day.'),
  is_done: z.boolean().optional().describe('Mark as done/undone'),
  tag_ids: z.array(z.string()).optional().describe('Replace all tags'),
  time_estimate: z.number().optional().describe('Time estimate in ms'),
  time_spent: z.number().optional().describe('Time spent in ms'),
  time_spent_on_day: z
    .record(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'), z.number().int().nonnegative().describe('ms'))
    .optional()
    .describe('Merge these per-day values into the timeSpentOnDay bucket (corrections; dates not listed are untouched; total timeSpent is recomputed as the bucket sum unless time_spent is also given)'),
};
export const bulkUpdateTaskItemSchema = z.object(bulkUpdateTaskItemShape).strict();
const bulkUpdateTasksShape = {
  updates: z.array(bulkUpdateTaskItemSchema).max(100).describe('Array of task updates'),
};
export const bulkUpdateTasksSchema = z.object(bulkUpdateTasksShape).strict();

const moveTaskToProjectShape = {
  task_id: z.string().describe('Task ID to move'),
  project_id: z.string().describe('Destination project ID'),
};
export const moveTaskToProjectSchema = z.object(moveTaskToProjectShape).strict();

const reorderTasksShape = {
  task_ids: z.array(z.string()).describe('Complete ordered list of task IDs'),
  context_id: z.string().describe('Project ID (if context_type is "project") or parent task ID (if "parent")'),
  context_type: z.enum(['project', 'parent']).describe('Whether context_id refers to a project or a parent task'),
};
export const reorderTasksSchema = z.object(reorderTasksShape).strict();

const deleteTaskShape = {
  task_id: z.string().describe('Task ID to delete'),
};
export const deleteTaskSchema = z.object(deleteTaskShape).strict();

const subtaskItemSchema = z.object({
  title: z.string().describe('Subtask title'),
  notes: z.string().optional().describe('Subtask notes'),
}).strict();
const createTaskWithSubtasksShape = {
  title: z.string().describe('Parent task title'),
  notes: z.string().optional().describe('Parent task notes'),
  project_id: z.string().optional().describe('Project ID for the parent task'),
  tag_ids: z.array(z.string()).optional().describe('Tag IDs for the parent task'),
  subtasks: z.array(subtaskItemSchema).describe('Subtask definitions'),
};
export const createTaskWithSubtasksSchema = z.object(createTaskWithSubtasksShape).strict();

const planTasksForTodayShape = {
  task_ids: z.array(z.string()).max(100).describe('Task IDs to plan/unplan'),
  plan_from_now: z.boolean().optional().default(false).describe('If true, plans tasks at the current time (floored to the whole minute — 1 minute is the smallest scheduling unit) instead of start-of-day (00:00). Recommended when an exact start time matters.'),
  unplan: z.boolean().optional().default(false).describe('If true, removes tasks from today instead of planning them'),
};
export const planTasksForTodaySchema = z.object(planTasksForTodayShape).strict();

const getWorklogShape = {
  start_date: z.string().describe('Start date (ISO format, e.g. 2026-04-14)'),
  end_date: z.string().describe('End date (ISO format, e.g. 2026-04-20)'),
};
export const getWorklogSchema = z.object(getWorklogShape).strict();

const worklogEntryShape = {
  date: z.string().describe('Day to log against (ISO format, e.g. 2026-08-31)'),
  duration: z.string().describe('Duration in SP short syntax: 2h, 45m, 1h30m, 90s'),
};
export const worklogEntrySchema = z.object(worklogEntryShape).strict();

const logTimeShape = {
  task_id: z.string().describe('Task ID to log time against'),
  duration: z.string().optional().describe('Duration in SP short syntax: 2h, 45m, 1h30m, 90s. Single-day form — mutually exclusive with entries.'),
  date: z.string().optional().describe('Day to log against (ISO format, e.g. 2026-08-31). Defaults to today. Only meaningful alongside duration.'),
  entries: z.array(worklogEntrySchema).max(100).optional().describe('Log several days in one call, e.g. backfilling a week. Each entry needs its own date. Mutually exclusive with duration.'),
  mode: z.enum(['add', 'set']).optional().default('add').describe('"add" increments each day\'s tracked time; "set" overwrites it — pass 0m with "set" to clear a day. Applies to every entry.'),
};
export const logTimeSchema = z.object(logTimeShape).strict();

const getTaskRepeatCfgsShape = {};
export const getTaskRepeatCfgsSchema = z.object(getTaskRepeatCfgsShape).strict();

export function registerTaskTools(server: McpServer, dirs: ResolvedDirs): void {
  // create_task
  server.registerTool(
    'create_task',
    {
      description: 'Create a new task in Super Productivity. Supports SP short syntax in the title: #tag, +project (prefix match, min 3 chars), @due-date (e.g. @tomorrow, @friday 3pm), and time estimates (30m, 1h, 1h/2h for spent/estimate). Tasks without a project go to the Inbox.',
      inputSchema: createTaskSchema,
    },
    async ({ title, notes, project_id, parent_id, tag_ids, deadline_day }) => {
      if (!title?.trim()) return errorResult('Title is required');

      const data: Record<string, unknown> = { title, notes: notes ?? '', tagIds: tag_ids ?? [] };
      if (project_id) data.projectId = project_id;
      if (parent_id) data.parentId = parent_id;
      if (deadline_day !== undefined) data.deadlineDay = deadline_day || null;

      // SP auto-assigns dueWithTime/dueDay to today when viewing Today context.
      // Passing null satisfies SP's `'dueDay' in additional` guard, preventing auto-scheduling
      // unless the title contains @date syntax (which SP will parse into a date itself).
      const hasDateSyntax = /@/.test(title);
      if (!hasDateSyntax) {
        data.dueWithTime = null;
        data.dueDay = null;
      }

      // T016: subtask SP syntax workaround
      const hasSyntax = parent_id && /[@#+]/.test(title);
      if (hasSyntax) {
        data.title = title.replace(/\s*[@#+]\S+/g, '').trim() || title;
      }

      const res = await sendCommand(dirs, 'addTask', { data });
      if (!res.success) return errorResult(res.error ?? 'Failed to create task');

      // Step 2 of workaround: update with original title to trigger syntax parsing
      if (hasSyntax && res.result) {
        await sendCommand(dirs, 'updateTask', { taskId: res.result as string, data: { title } });
      }

      const task = await fetchTask(dirs, res.result as string);
      return okResult({ taskId: res.result, task });
    },
  );

  // get_tasks
  server.registerTool(
    'get_tasks',
    {
      description: 'Get tasks from Super Productivity with optional filters. By default returns non-done, non-archived tasks.',
      inputSchema: getTasksSchema,
    },
    async ({ project_id, tag_id, include_done, include_archived, search_query, parents_only, overdue, unscheduled, planned_for_today, recurring_only, scheduled_on, completed_on, overlapping, sort_by, sort_dir, include_schedule, fields }) => {
      const filters: TaskFilters = {
        projectId: project_id,
        tagId: tag_id,
        includeDone: include_done,
        includeArchived: include_archived,
        searchQuery: search_query,
      };
      const res = await sendCommand(dirs, 'getTasks', { filters });
      if (!res.success) return errorResult(res.error ?? 'Failed to get tasks');

      // Server-side filtering
      let tasks = (res.result as TaskRecord[]) ?? [];
      if (!include_done && !completed_on) tasks = tasks.filter(t => !t.isDone);
      if (project_id) tasks = tasks.filter(t => t.projectId === project_id);
      if (tag_id) tasks = tasks.filter(t => t.tagIds?.includes(tag_id));
      if (search_query) {
        const q = search_query.toLowerCase();
        tasks = tasks.filter(t => t.title?.toLowerCase().includes(q) || (t.notes && t.notes.toLowerCase().includes(q)));
      }
      if (recurring_only) tasks = tasks.filter(t => t.repeatCfgId != null);

      // Triage filters (FR-004, FR-005, FR-006)
      tasks = applyTriageFilters(tasks, { parentsOnly: parents_only, overdue, unscheduled, plannedForToday: planned_for_today });

      // Schedule-aware filters (server-side, after triage)
      if (scheduled_on) tasks = filterScheduledOn(tasks, scheduled_on);
      if (completed_on) tasks = filterCompletedOn(tasks, completed_on);
      if (overlapping) tasks = filterOverlapping(tasks);
      if (sort_by) tasks = sortTasks(tasks, sort_by, sort_dir ?? 'asc');

      const now = Date.now();

      // Field selection (005-FR-001) — supports derived schedule fields and resolved names
      if (fields && fields.length > 0) {
        const refs = fields.some(f => f === 'projectTitle' || f === 'tags') ? await loadRefs(dirs) : undefined;
        return okResult(tasks.map(t => projectFields(t, fields, now, refs)));
      }

      // Full objects: expose canonical plannedTime, resolve project/tag names,
      // optionally append the derived schedule block
      const refs = await loadRefs(dirs);
      if (include_schedule) {
        return okResult(tasks.map(t => ({ ...shapeForResponse(enrichTask(t, refs)), schedule: deriveSchedule(t, now) })));
      }
      return okResult(tasks.map(t => shapeForResponse(enrichTask(t, refs))));
    },
  );

  // get_task — fully-resolved single-task deep-dive
  server.registerTool(
    'get_task',
    {
      description: 'Get a single task fully resolved: enriched with projectTitle + tags, derived schedule block, parent title, subtask list, and time spent over the last 14 days.',
      inputSchema: getTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'getTasks', { filters: { includeDone: true, includeArchived: true } });
      if (!res.success) return errorResult(res.error ?? 'Failed to get task');
      const all = (res.result as TaskRecord[]) ?? [];
      const task = all.find(t => t.id === task_id);
      if (!task) return errorResult(`Task not found: ${task_id}`);
      const refs = await loadRefs(dirs);
      return okResult(composeTaskDetail(task, all, refs, Date.now()));
    },
  );

  // update_task
  server.registerTool(
    'update_task',
    {
      description: 'Update an existing task. Supports SP short syntax in the title. For logging time against a specific day prefer log_time; time_spent / time_spent_on_day remain for direct corrections.',
      inputSchema: updateTaskSchema,
    },
    async ({ task_id, title, notes, is_done, due_day, deadline_day, due_with_time, time_estimate, time_spent, time_spent_on_day, tag_ids }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');

      const data: Record<string, unknown> = {};
      if (title !== undefined) data.title = title;
      if (notes !== undefined) data.notes = notes;
      if (is_done !== undefined) {
        data.isDone = is_done;
        data.doneOn = is_done ? Date.now() : null;
      }
      if (due_day !== undefined) data.dueDay = due_day || null;
      if (deadline_day !== undefined) data.deadlineDay = deadline_day || null;
      if (due_with_time !== undefined) data.dueWithTime = due_with_time === null ? null : minuteFloor(due_with_time);
      if (time_estimate !== undefined) data.timeEstimate = time_estimate;
      if (time_spent !== undefined) data.timeSpent = time_spent;
      if (time_spent_on_day !== undefined) data.time_spent_on_day = time_spent_on_day;
      // tag_ids replaces the entire tag list; use add_tag_to_task / remove_tag_from_task for incremental changes
      if (tag_ids !== undefined) data.tagIds = tag_ids;

      const res = await sendCommand(dirs, 'updateTask', { taskId: task_id, data });
      if (!res.success) return errorResult(res.error ?? 'Failed to update task');
      const task = await fetchTask(dirs, task_id);
      return okResult({ taskId: task_id, task });
    },
  );

  // complete_task
  server.registerTool(
    'complete_task',
    {
      description: 'Mark a task as complete in Super Productivity.',
      inputSchema: completeTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'setTaskDone', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to complete task');
      return okResult(res.result);
    },
  );

  // T004: add_tag_to_task (FR-001 — add single tag without replacing others)
  server.registerTool(
    'add_tag_to_task',
    {
      description: 'Add a single tag to a task without modifying its other existing tags. Idempotent: calling with an already-present tag succeeds silently.',
      inputSchema: addTagToTaskSchema,
    },
    async ({ task_id, tag_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!tag_id?.trim()) return errorResult('tag_id is required');
      const res = await sendCommand(dirs, 'addTagToTask', { taskId: task_id, tagId: tag_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to add tag');
      return okResult({ success: true });
    },
  );

  // T005: remove_tag_from_task (FR-002 — remove single tag; error if not present)
  server.registerTool(
    'remove_tag_from_task',
    {
      description: 'Remove a single tag from a task without modifying its other existing tags. Returns an error if the tag is not currently on the task.',
      inputSchema: removeTagFromTaskSchema,
    },
    async ({ task_id, tag_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!tag_id?.trim()) return errorResult('tag_id is required');
      const res = await sendCommand(dirs, 'removeTagFromTask', { taskId: task_id, tagId: tag_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to remove tag');
      return okResult({ success: true });
    },
  );

  // T014: get_current_task (FR-010 — return currently time-tracked task or null)
  server.registerTool(
    'get_current_task',
    {
      description: 'Get the currently time-tracked task in Super Productivity. Returns { task: null } when no task has an active timer.',
      inputSchema: getCurrentTaskSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'loadCurrentTask', {});
      if (!res.success) return errorResult(res.error ?? 'Failed to get current task');
      return okResult({ task: res.result ?? null });
    },
  );

  // start_task (003-FR-001 — start time tracker on a task)
  server.registerTool(
    'start_task',
    {
      description: 'Start the time tracker on a task. If another task is being tracked, it will be stopped automatically. Cannot start tracking a completed task.',
      inputSchema: startTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'startTask', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to start task');
      return okResult({ success: true });
    },
  );

  // stop_task (003-FR-002 — stop the currently running timer)
  server.registerTool(
    'stop_task',
    {
      description: 'Stop the currently running time tracker. Succeeds silently if no timer is running (idempotent).',
      inputSchema: stopTaskSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'stopTask', {});
      if (!res.success) return errorResult(res.error ?? 'Failed to stop task');
      return okResult({ success: true });
    },
  );

  // add_time_today (fallback/correction — plugin ≥1.7.2 drives SP's real timer natively)
  // Keep for retroactive accrual (work done before 1.7.2) and under-accrual from a
  // backgrounded window. The worklog sums timeSpentOnDay, so we must update that field
  // (and timeSpent) — NOT just timeSpent.
  server.registerTool(
    'add_time_today',
    {
      description:
        'Add elapsed milliseconds to a task for today. Fallback/correction tool: since plugin 1.7.2, start_task/stop_task drive SP\'s real timer and SP accrues timeSpentOnDay[today] natively; use this only for retroactive time or under-accrual from a backgrounded window. Updates both the per-day bucket (timeSpentOnDay[today], which the worklog reads) and the total timeSpent. Returns the updated task.',
      inputSchema: addTimeTodaySchema,
    },
    async ({ task_id, ms }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return errorResult('ms must be a non-negative number');
      const res = await sendCommand(dirs, 'addTimeToday', { taskId: task_id, ms });
      if (!res.success) return errorResult(res.error ?? 'Failed to add time');
      const task = await fetchTask(dirs, task_id);
      return okResult({ taskId: task_id, task, addedMs: ms });
    },
  );

  // bulk_complete_tasks (003-FR-008 — mark multiple tasks done in one round-trip)
  server.registerTool(
    'bulk_complete_tasks',
    {
      description: 'Mark multiple tasks as complete in a single operation. Uses partial-success semantics: each task reports its own success/error.',
      inputSchema: bulkCompleteTasksSchema,
    },
    async ({ task_ids }) => {
      const res = await sendCommand(dirs, 'bulkCompleteTasks', { taskIds: task_ids ?? [] });
      if (!res.success) return errorResult(res.error ?? 'Failed to bulk complete tasks');
      return okResult(res.result);
    },
  );

  // bulk_update_tasks (003-FR-009 — apply different updates to multiple tasks)
  server.registerTool(
    'bulk_update_tasks',
    {
      description: 'Update multiple tasks in a single operation. Each item specifies a task_id and the fields to update. Uses partial-success semantics. Supports the full update_task field set (title, notes, due_day, deadline_day, due_with_time, is_done, tag_ids, time_estimate, time_spent, time_spent_on_day); after the writes the affected tasks are re-fetched and echoed under `tasks` (id → effective task, incl. plannedTime) so the result is verifiable in one round-trip.',
      inputSchema: bulkUpdateTasksSchema,
    },
    async ({ updates }) => {
      const mapped = (updates ?? []).map(u => ({
        taskId: u.task_id,
        data: {
          ...(u.title !== undefined && { title: u.title }),
          ...(u.notes !== undefined && { notes: u.notes }),
          ...(u.due_day !== undefined && { dueDay: u.due_day || null }),
          ...(u.due_with_time !== undefined && { dueWithTime: u.due_with_time === null ? null : minuteFloor(u.due_with_time) }),
          ...(u.is_done !== undefined && { isDone: u.is_done, doneOn: u.is_done ? Date.now() : null }),
          ...(u.deadline_day !== undefined && { deadlineDay: u.deadline_day || null }),
          ...(u.tag_ids !== undefined && { tagIds: u.tag_ids }),
          ...(u.time_estimate !== undefined && { timeEstimate: u.time_estimate }),
          ...(u.time_spent !== undefined && { timeSpent: u.time_spent }),
          ...(u.time_spent_on_day !== undefined && { time_spent_on_day: u.time_spent_on_day }),
        },
      }));
      const res = await sendCommand(dirs, 'bulkUpdateTasks', { updates: mapped });
      if (!res.success) return errorResult(res.error ?? 'Failed to bulk update tasks');
      const touchedIds = (updates ?? []).map(u => u.task_id);
      const rezeroed = await rezeroUnplannedParents(dirs, touchedIds);
      const tasks = await fetchTasksByIds(dirs, [...touchedIds, ...rezeroed]);
      return okResult({ ...((res.result as Record<string, unknown> | null) ?? {}), tasks });
    },
  );

  // move_task_to_project (FR-008 — move top-level task; error on subtask)
  server.registerTool(
    'move_task_to_project',
    {
      description: 'Move a top-level task to a different project. Returns an error if called on a subtask.',
      inputSchema: moveTaskToProjectSchema,
    },
    async ({ task_id, project_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      if (!project_id?.trim()) return errorResult('project_id is required');
      const res = await sendCommand(dirs, 'moveTaskToProject', { taskId: task_id, projectId: project_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to move task');
      return okResult({ success: true });
    },
  );

  // reorder_tasks (FR-009 — reorder tasks within a project or parent)
  server.registerTool(
    'reorder_tasks',
    {
      description: 'Reorder tasks within a project or subtasks within a parent task. Provide a complete ordered list of task IDs — partial reordering is not supported.',
      inputSchema: reorderTasksSchema,
    },
    async ({ task_ids, context_id, context_type }) => {
      if (!task_ids?.length) return errorResult('task_ids must not be empty');
      if (!context_id?.trim()) return errorResult('context_id is required');
      const res = await sendCommand(dirs, 'reorderTasks', { taskIds: task_ids, contextId: context_id, contextType: context_type });
      if (!res.success) return errorResult(res.error ?? 'Failed to reorder tasks');
      return okResult({ success: true });
    },
  );

  // delete_task (005-FR-005)
  server.registerTool(
    'delete_task',
    {
      description: 'Permanently delete a task. Deleting a parent also removes all subtasks.',
      inputSchema: deleteTaskSchema,
    },
    async ({ task_id }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');
      const res = await sendCommand(dirs, 'deleteTask', { taskId: task_id });
      if (!res.success) return errorResult(res.error ?? 'Failed to delete task');
      return okResult({ success: true });
    },
  );

  // create_task_with_subtasks (005-FR-008)
  server.registerTool(
    'create_task_with_subtasks',
    {
      description: 'Create a parent task with subtasks in one operation. Returns parentId and subtaskIds.',
      inputSchema: createTaskWithSubtasksSchema,
    },
    async ({ title, notes, project_id, tag_ids, subtasks }) => {
      if (!title?.trim()) return errorResult('Title is required');
      const data: Record<string, unknown> = {
        title,
        notes: notes ?? '',
        projectId: project_id,
        tagIds: tag_ids ?? [],
        subtasks: subtasks ?? [],
      };
      const res = await sendCommand(dirs, 'createTaskWithSubtasks', { data });
      if (!res.success) return errorResult(res.error ?? 'Failed to create task with subtasks');
      return okResult(res.result);
    },
  );

  // plan_tasks_for_today (006-FR-004)
  server.registerTool(
    'plan_tasks_for_today',
    {
      description: 'Plan multiple tasks for today (adds to Today view) or unplan them. By default tasks are pinned to start-of-day (00:00); use plan_from_now for "from now until next task". Uses partial-success semantics.',
      inputSchema: planTasksForTodaySchema,
    },
    async ({ task_ids, plan_from_now, unplan }) => {
      if (!task_ids?.length) return okResult({ results: [] });
      const now = new Date();
      const dueWithTime = unplan
        ? null
        : plan_from_now
          ? minuteFloor(now.getTime())
          : new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const updates = task_ids.map(id => ({ taskId: id, data: { dueWithTime } }));
      const res = await sendCommand(dirs, 'bulkUpdateTasks', { updates });
      if (!res.success) return errorResult(res.error ?? 'Failed to plan tasks');
      const tasks = await fetchTasksByIds(dirs, task_ids);
      return okResult({ results: task_ids.map(id => ({ taskId: id, task: tasks[id] ?? null })) });
    },
  );

  // get_worklog (US5 — registered here since it uses task data)
  server.registerTool(
    'get_worklog',
    {
      description: 'Get a worklog summary for a date range: time spent per day, per project, per tag, tasks completed, and estimate vs actual accuracy.',
      inputSchema: getWorklogSchema,
    },
    async ({ start_date, end_date }) => {
      if (!start_date || !end_date) return errorResult('start_date and end_date are required');

      const res = await sendCommand(dirs, 'getTasks', {
        filters: { includeDone: true, includeArchived: true },
      });
      if (!res.success) return errorResult(res.error ?? 'Failed to get tasks');

      const tasks = (res.result as TaskRecord[]) ?? [];
      const daily: Record<string, number> = {};
      const byProject: Record<string, number> = {};
      const byTag: Record<string, number> = {};
      let completedCount = 0;
      let totalEstimate = 0;
      let totalActual = 0;

      for (const task of tasks) {
        // Aggregate timeSpentOnDay within range
        if (task.timeSpentOnDay) {
          for (const [date, ms] of Object.entries(task.timeSpentOnDay)) {
            if (date >= start_date && date <= end_date) {
              daily[date] = (daily[date] ?? 0) + ms;
              const proj = task.projectId ?? 'No Project';
              byProject[proj] = (byProject[proj] ?? 0) + ms;
              for (const tagId of task.tagIds ?? []) {
                byTag[tagId] = (byTag[tagId] ?? 0) + ms;
              }
            }
          }
        }
        // Count completions in range
        if (task.isDone && task.doneOn) {
          const d = new Date(task.doneOn);
          const doneDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          if (doneDate >= start_date && doneDate <= end_date) {
            completedCount++;
            if (task.timeEstimate > 0) {
              totalEstimate += task.timeEstimate;
              totalActual += task.timeSpent;
            }
          }
        }
      }

      return okResult({
        dateRange: { start: start_date, end: end_date },
        daily,
        byProject,
        byTag,
        tasksCompleted: completedCount,
        estimateAccuracy: totalEstimate > 0
          ? { estimateMs: totalEstimate, actualMs: totalActual, ratio: totalActual / totalEstimate }
          : null,
      });
    },
  );

  // log_time — writes the per-day map get_worklog reads
  server.registerTool(
    'log_time',
    {
      description: 'Log time spent on a task for a specific day. Adds to that day\'s tracked time by default, or overwrites it with mode "set" (pass 0m with "set" to clear a day). Time lands in the same per-day record SP\'s own timer writes, so it shows up in the worklog and rolls up to the parent task.',
      inputSchema: logTimeSchema,
    },
    async ({ task_id, duration, date, entries, mode }) => {
      if (!task_id?.trim()) return errorResult('task_id is required');

      if (entries !== undefined && duration !== undefined) {
        return errorResult('Pass either duration (one day) or entries (several days), not both');
      }
      if (entries === undefined && duration === undefined) {
        return errorResult('Pass duration to log one day, or entries to log several');
      }
      if (entries !== undefined && date !== undefined) {
        return errorResult('date is only meaningful alongside duration — put each day\'s date in its entries element instead');
      }

      // The single-day form is just a one-entry list — one validation path and one
      // wire shape, so the two forms cannot drift apart.
      const requested = entries ?? [{ date: date ?? localDateStr(), duration: duration as string }];
      if (requested.length === 0) return errorResult('entries must contain at least one day');

      // Validate everything before sending: a partially-applied multi-day write
      // would leave the worklog in a state the caller never asked for.
      const seen = new Set<string>();
      const normalised: { date: string; durationMs: number }[] = [];
      for (const entry of requested) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
          return errorResult(`Invalid date "${entry.date}" — expected ISO format YYYY-MM-DD`);
        }
        if (seen.has(entry.date)) {
          return errorResult(`Duplicate date "${entry.date}" in entries — one entry per day`);
        }
        seen.add(entry.date);

        const durationMs = parseDuration(entry.duration ?? '');
        if (durationMs === null) {
          return errorResult(`Invalid duration "${entry.duration}" for ${entry.date} — use SP short syntax, e.g. 2h, 45m, 1h30m or 90s`);
        }
        normalised.push({ date: entry.date, durationMs });
      }

      const res = await sendCommand(dirs, 'logTimeEntries', {
        taskId: task_id,
        data: { entries: normalised, mode: mode ?? 'add' },
      });
      if (!res.success) return errorResult(res.error ?? 'Failed to log time');
      return okResult(res.result);
    },
  );

  server.registerTool(
    'get_task_repeat_cfgs',
    {
      description: 'Get all recurring task configurations (taskRepeatCfg) from Super Productivity. Returns repeat schedules with their cycle, frequency, day settings, and associated task metadata.',
      inputSchema: getTaskRepeatCfgsSchema,
    },
    async () => {
      const res = await sendCommand(dirs, 'getTaskRepeatCfgs');
      if (!res.success) return errorResult(res.error ?? 'Failed to get repeat configs');
      return okResult({ repeatCfgs: res.result });
    },
  );
}
