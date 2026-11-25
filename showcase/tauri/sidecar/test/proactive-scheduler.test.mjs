import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScheduler } from '../proactive/scheduler.mjs';

test('TaskScheduler: schedules, lists, executes, and cancels background tasks', async () => {
  const scheduler = new TaskScheduler({ logger: () => {} });
  let count = 0;

  const res = scheduler.scheduleTask({
    id: 'test_counter',
    description: 'Increment counter test',
    intervalSeconds: 10,
    action: async () => {
      count++;
      return count;
    },
  });

  assert.equal(res.ok, true);
  assert.equal(res.taskId, 'test_counter');

  // List tasks
  const list = scheduler.listTasks();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'test_counter');
  assert.equal(list[0].status, 'active');

  // Execute on-demand
  const runRes = await scheduler.runTaskNow('test_counter');
  assert.equal(runRes.ok, true);
  assert.equal(runRes.result, 1);
  assert.equal(count, 1);

  // Cancel task
  const cancelRes = scheduler.cancelTask('test_counter');
  assert.equal(cancelRes.ok, true);
  assert.equal(scheduler.listTasks().length, 0);

  // One-shot task
  let fired = false;
  scheduler.scheduleTask({
    id: 'one_shot',
    description: 'Run once',
    runOnceAt: Date.now() + 50,
    action: async () => {
      fired = true;
    },
  });

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fired, true);

  scheduler.clearAll();
});
