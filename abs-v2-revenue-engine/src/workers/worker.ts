import os from 'node:os';
import { Worker } from 'bullmq';
import { redis } from '../lib/queue';
import { drainOutbox, executeTask } from '../services/executor';
const workerId = `${os.hostname()}-${process.pid}`;
const worker = new Worker('abs-task-execution', async job => {
  if (job.name !== 'execute' || typeof job.data?.taskId !== 'string') throw new Error('Invalid task queue message');
  return executeTask(job.data.taskId, workerId);
}, { connection:redis, concurrency:2, lockDuration:120000 });
worker.on('completed', job => console.log('task_completed', job.id));
worker.on('failed', (job, err) => console.error('task_failed', job?.id, err.message));
async function shutdown() { clearInterval(outboxTimer); await worker.close(); await redis.quit(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
const outboxTimer = setInterval(() => { drainOutbox().catch(err => console.error('outbox_publish_failed', err instanceof Error ? err.message : err)); }, 1000);
console.log(`ABS worker ${workerId} online`);
