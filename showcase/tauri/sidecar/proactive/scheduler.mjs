// Proactive Assistance & Task Scheduler (V2.6)
// Manages recurring and scheduled background tasks and assistant triggers safely within the sidecar.
import { randomBytes } from 'node:crypto';

export class TaskScheduler {
  constructor({ logger = console.log } = {}) {
    this.logger = logger;
    this.tasks = new Map();
    this.timers = new Map();
  }

  scheduleTask({ id = null, description, intervalSeconds = null, runOnceAt = null, action, args = {} }) {
    if (!description) throw new Error('Task description is required.');
    if (!intervalSeconds && !runOnceAt) {
      throw new Error('Either intervalSeconds or runOnceAt must be specified.');
    }
    if (typeof action !== 'function') {
      throw new Error('Task action must be an executable function.');
    }

    const taskId = id || `task_${randomBytes(4).toString('hex')}`;
    if (this.tasks.has(taskId)) {
      this.cancelTask(taskId);
    }

    const now = Date.now();
    let nextRun = null;

    if (runOnceAt) {
      const targetTime = typeof runOnceAt === 'number' ? runOnceAt : new Date(runOnceAt).getTime();
      if (isNaN(targetTime)) throw new Error('Invalid runOnceAt timestamp.');
      nextRun = targetTime;
    } else {
      nextRun = now + intervalSeconds * 1000;
    }

    const taskRecord = {
      id: taskId,
      description,
      intervalSeconds: intervalSeconds || null,
      runOnceAt: runOnceAt ? nextRun : null,
      action,
      args,
      createdAt: now,
      lastRun: null,
      nextRun,
      runsCount: 0,
      lastError: null,
      status: 'active',
    };

    this.tasks.set(taskId, taskRecord);
    this._armTimer(taskRecord);
    return { ok: true, taskId, nextRun: new Date(nextRun).toISOString() };
  }

  _armTimer(task) {
    if (task.status !== 'active') return;
    const delay = Math.max(0, task.nextRun - Date.now());

    const timer = setTimeout(async () => {
      this.timers.delete(task.id);
      await this.runTaskNow(task.id);

      // Re-arm if interval-based
      if (task.status === 'active' && task.intervalSeconds) {
        task.nextRun = Date.now() + task.intervalSeconds * 1000;
        this._armTimer(task);
      } else if (!task.intervalSeconds) {
        task.status = 'completed';
      }
    }, delay);

    // Don't keep Node process alive solely for background timer
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(task.id, timer);
  }

  async runTaskNow(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No task found with id: ${taskId}`);

    task.lastRun = Date.now();
    task.runsCount++;
    try {
      const res = await task.action(task.args);
      task.lastError = null;
      return { ok: true, taskId, result: res };
    } catch (err) {
      task.lastError = err?.message || String(err);
      this.logger(`[Scheduler] Task ${taskId} failed: ${task.lastError}`);
      return { ok: false, taskId, error: task.lastError };
    }
  }

  listTasks() {
    return Array.from(this.tasks.values()).map((t) => ({
      id: t.id,
      description: t.description,
      intervalSeconds: t.intervalSeconds,
      status: t.status,
      runsCount: t.runsCount,
      lastRun: t.lastRun ? new Date(t.lastRun).toISOString() : null,
      nextRun: t.nextRun && t.status === 'active' ? new Date(t.nextRun).toISOString() : null,
      lastError: t.lastError,
    }));
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: 'Task not found' };

    const timer = this.timers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(taskId);
    }
    task.status = 'cancelled';
    this.tasks.delete(taskId);
    return { ok: true, taskId, cancelled: true };
  }

  clearAll() {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.tasks.clear();
  }
}

let defaultScheduler = null;
export function getTaskScheduler() {
  if (!defaultScheduler) {
    defaultScheduler = new TaskScheduler();
  }
  return defaultScheduler;
}
