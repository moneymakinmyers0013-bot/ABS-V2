import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../lib/db';
import { taskQueue } from '../lib/queue';

function normalizeRows(rows: unknown[]): Record<string, unknown>[] {
  if (!rows.every(x => x && typeof x === 'object' && !Array.isArray(x))) throw new Error('Input rows must be an array of objects');
  return rows as Record<string, unknown>[];
}
function transform(taskType: string, input: any): unknown {
  const rows = normalizeRows(input.rows ?? []);
  switch (taskType) {
    case 'csv_cleanup':
    case 'data_normalization':
      return rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k.trim(), typeof v === 'string' ? v.trim().replace(/\s+/g,' ') : v])));
    case 'duplicate_removal': {
      const seen = new Set<string>();
      return rows.filter(row => { const key = JSON.stringify(row, Object.keys(row).sort()); if (seen.has(key)) return false; seen.add(key); return true; });
    }
    case 'data_transformation':
      if (!input.mapping || typeof input.mapping !== 'object') throw new Error('data_transformation requires mapping {outputKey: inputKey}');
      return rows.map(row => Object.fromEntries(Object.entries(input.mapping).map(([outKey,inKey]) => [outKey, row[String(inKey)]])));
    case 'categorization':
      if (!input.categoryField || !Array.isArray(input.categories)) throw new Error('categorization requires categoryField and categories');
      return rows.map(row => ({ ...row, category: input.categories.find((c: unknown) => typeof c === 'string' && String(row[input.categoryField]).toLowerCase().includes(c.toLowerCase())) ?? 'uncategorized' }));
    case 'structured_extraction':
    case 'metadata_generation':
    case 'document_formatting':
    case 'bulk_content_formatting':
    case 'document_conversion':
      throw new Error(`Task type ${taskType} has no production executor; refusing to create a false-positive deliverable`);
    default: throw new Error(`Unsupported task type: ${taskType}`);
  }
}
function validateOutput(taskType: string, input: any, output: unknown): { passed: boolean; checks: Record<string, unknown> } {
  let passed = true;
  const checks: Record<string, unknown> = { outputIsJson: true, taskType };
  if (!Array.isArray(output)) return { passed: false, checks: { ...checks, outputIsArray: false, reason: 'Expected row-array output' } };
  checks.outputIsArray = true;
  checks.inputRows = Array.isArray(input.rows) ? input.rows.length : 0;
  checks.outputRows = output.length;
  if (taskType !== 'duplicate_removal' && output.length !== checks.inputRows) passed = false;
  if (taskType === 'duplicate_removal' && output.length > Number(checks.inputRows)) passed = false;
  if (taskType === 'csv_cleanup' || taskType === 'data_normalization') {
    const normalized = output.every((row: any) => row && typeof row === 'object' && Object.entries(row).every(([key, value]) => key === key.trim() && (typeof value !== 'string' || (value === value.trim() && !/\s{2,}/.test(value)))));
    checks.normalizationRulesPassed = normalized;
    passed = passed && normalized;
  }
  if (taskType === 'duplicate_removal') {
    const keys = output.map((row: unknown) => JSON.stringify(row));
    const unique = new Set(keys).size === keys.length;
    checks.duplicateRowsRemoved = unique;
    passed = passed && unique;
  }
  checks.passed = passed;
  return { passed, checks };
}

export async function executeTask(taskId: string, workerId: string) {
  const task = await prisma.task.findUnique({ where:{ id:taskId }, include:{ quote:true } });
  if (!task) throw new Error('Task not found');
  if (task.status !== 'AUTHORIZED' && task.status !== 'ACCEPTED') throw new Error(`Task is not authorized to run (status=${task.status})`);
  const payment = await prisma.paymentTransaction.findFirst({ where:{ quoteId:task.quoteId, direction:'INBOUND', status:'CAPTURED_VERIFIED' } });
  if (!payment || payment.amountCents !== task.quote.amountCents || payment.currency !== task.quote.currency) throw new Error('Verified matching provider capture required before execution');
  const attemptNo = await prisma.executionAttempt.count({ where:{ taskId } }) + 1;
  const attempt = await prisma.executionAttempt.create({ data:{ taskId, attempt:attemptNo, status:'RUNNING', workerId, startedAt:new Date(), inputHash:crypto.createHash('sha256').update(JSON.stringify(task.input)).digest('hex') } });
  await prisma.task.update({ where:{ id:taskId }, data:{ status:'RUNNING' } });
  try {
    const output = transform(task.taskType, task.input);
    const outputText = JSON.stringify(output, null, 2);
    const outputHash = crypto.createHash('sha256').update(outputText).digest('hex');
    const dir = path.resolve(process.env.WORKSPACE_DIR ?? './workspace', taskId, 'output');
    await fs.mkdir(dir, { recursive:true });
    const filename = 'result.json'; const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, outputText, { flag:'wx' }).catch(async err => { if (err.code === 'EEXIST') await fs.writeFile(fullPath, outputText); else throw err; });
    const stat = await fs.stat(fullPath);
    const readBack = await fs.readFile(fullPath, 'utf8');
    const hashMatches = crypto.createHash('sha256').update(readBack).digest('hex') === outputHash;
    let parsedOutput: unknown;
    try { parsedOutput = JSON.parse(readBack); } catch { parsedOutput = null; }
    const outputChecks = validateOutput(task.taskType, task.input, parsedOutput);
    const validationPassed = hashMatches && outputChecks.passed;
    await prisma.$transaction(async tx => {
      await tx.taskArtifact.create({ data:{ taskId, kind:'OUTPUT', filename, mime:'application/json', sha256:outputHash, sizeBytes:stat.size, storagePath:fullPath } });
      await tx.taskValidation.create({ data:{ taskId, passed:validationPassed, checks:{ outputHashMatches:hashMatches, outputIsJson:parsedOutput !== null, bytes:stat.size, executor:'deterministic-v1', ...outputChecks.checks } } });
      await tx.executionAttempt.update({ where:{ id:attempt.id }, data:{ status:'SUCCEEDED', outputHash, finishedAt:new Date() } });
      await tx.task.update({ where:{ id:taskId }, data:validationPassed ? { status:'DELIVERABLE_SUBMITTED' } : { status:'FAILED', failureReason:'Independent output validation failed' } });
      await tx.auditEvent.create({ data:{ agent:workerId, action:validationPassed ? 'TASK_EXECUTED' : 'TASK_VALIDATION_FAILED', taskId, result:validationPassed ? 'SUCCESS' : 'FAILED', correlationId:attempt.id, evidence:{ outputHash, filename, validation:outputChecks.checks, hashMatches } } });
    });
    if (!validationPassed) throw new Error('Independent output validation failed; delivery blocked');
    return { taskId, outputHash, filename, sizeBytes:stat.size };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown execution error';
    await prisma.$transaction([
      prisma.executionAttempt.update({ where:{ id:attempt.id }, data:{ status:'TERMINAL_FAILED', error:message, finishedAt:new Date() } }),
      prisma.task.update({ where:{ id:taskId }, data:{ status:'FAILED', failureReason:message } }),
      prisma.auditEvent.create({ data:{ agent:workerId, action:'TASK_EXECUTION_FAILED', taskId, result:'FAILED', correlationId:attempt.id, evidence:{ error:message } } })
    ]);
    throw err;
  }
}
export async function enqueueTask(taskId: string) {
  // The outbox row is the durable intent. A worker publisher retries queue publication after crashes.
  await prisma.outboxEvent.upsert({ where:{ dedupeKey:`execute:${taskId}` }, create:{ topic:'task.execute', aggregateId:taskId, dedupeKey:`execute:${taskId}`, payload:{ taskId } }, update:{} });
}

export async function drainOutbox() {
  const events = await prisma.outboxEvent.findMany({ where:{ topic:'task.execute', publishedAt:null }, orderBy:{ createdAt:'asc' }, take:100 });
  for (const event of events) {
    const payload = event.payload as { taskId?: unknown };
    if (typeof payload.taskId !== 'string') {
      await prisma.outboxEvent.update({ where:{ id:event.id }, data:{ attempts:{ increment:1 }, lastError:'Invalid task.execute payload' } });
      continue;
    }
    try {
      await taskQueue.add('execute', { taskId:payload.taskId }, { jobId:`execute-${payload.taskId}`, attempts:3, backoff:{ type:'exponential', delay:2000 }, removeOnComplete:1000, removeOnFail:5000 });
      await prisma.outboxEvent.update({ where:{ id:event.id }, data:{ publishedAt:new Date(), attempts:{ increment:1 }, lastError:null } });
    } catch (err) {
      await prisma.outboxEvent.update({ where:{ id:event.id }, data:{ attempts:{ increment:1 }, lastError:err instanceof Error ? err.message.slice(0,1000) : 'Unknown queue publish error' } });
    }
  }
  return events.length;
}
