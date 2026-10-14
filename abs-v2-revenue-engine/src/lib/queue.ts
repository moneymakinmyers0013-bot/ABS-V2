import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from './config';
export const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
export const taskQueue = new Queue('abs-task-execution', { connection: redis });
