/** Host timer over standalone tasks; target Session activation is a delivery operation. */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import {
  isRecurringScheduleRecord, MIN_EVERY_INTERVAL_SECONDS, renderReminderFraming,
  resolveRecurringOccurrence,
} from './domain.ts'
import { appendDelivery } from './delivery-history.ts'
import type { ScheduleTask } from './storage.ts'
import type { DeliveryRetentionBounds, ScheduleDeliveryReceipt, ScheduleId } from './types.ts'

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Fixed per-task delivery floor interval, timed or manual, of a target other than `new`; it matches the shortest recurrence spacing. */
export const MIN_DELIVERY_INTERVAL_MS = MIN_EVERY_INTERVAL_SECONDS * 1_000

/** Resolved deployment limits of one runtime. */
export interface ScheduleRuntimeLimits {
  /** Retention window and record cap applied on each delivery commit. */
  readonly retention: DeliveryRetentionBounds
  /** Delivery floor interval of one task whose every delivery creates a Session. */
  readonly newSessionIntervalMs: number
}

const RETRY_DELAY_MS = 30_000

type PendingDelivery = NonNullable<ScheduleTask['pendingDelivery']>

/** Codex 原生队列负责投递确认；save 在出站写入前持久化消息标识。 */
export interface CodexDelivery {
  validate(threadId: string, signal?: AbortSignal): Promise<unknown>
  outstanding(threadId: string, messageId: string): Promise<boolean>
  send(threadId: string, text: string, pending: PendingDelivery, recover: boolean,
    save: (pending?: PendingDelivery) => Promise<void>, signal?: AbortSignal): Promise<string>
}

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private stopping = false
  private requested = false

  /**
   * @param ctx - Host services used to resume and enqueue.
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist one task value and publish its change; delivery commits status, target, and receipt together.
   * @param limits - Resolved retention and new-Session admission limits.
   * @param delivery - Codex thread validation, queue delivery, and receipt recovery.
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly limits: ScheduleRuntimeLimits,
    private readonly delivery: CodexDelivery,
  ) {}

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    const run = (async () => {
      while (this.requested && !this.stopping) {
        this.requested = false
        await this.transact(async () => { await this.drive() })
      }
    })()
    this.running = run
    void run.catch((error: unknown) => {
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      /* v8 ignore next -- a request can arrive in the microtask gap between the drive loop and this finalizer. */
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
  }

  /**
   * Queue one manual execution without consuming or moving its scheduled occurrence.
   * @param id - Canonical task identity resolved again inside the shared transaction.
   * @param signal - Cancellation checked after entering the transaction and before delivery.
   * @returns Admission and task state after durable Session inbox acknowledgement, or undefined when deleted first.
   */
  async runNow(id: ScheduleId, signal?: AbortSignal): Promise<
    { readonly task: ScheduleTask; readonly admitted: boolean } | undefined
  > {
    return this.transact(async () => {
      signal?.throwIfAborted()
      const task = this.tasks().find(candidate => candidate.record.id === id)
      if (task === undefined) return
      try {
        if (await this.waiting(task, Date.now())) return { task, admitted: false }
        const delivered = await this.dispatch(task, true, signal)
        return { task: delivered, admitted: true }
      } finally {
        this.requestDrive()
      }
    })
  }

  /**
   * End of this task's current minimum delivery interval.
   * @param task - Current durable task state.
   * @returns Epoch milliseconds while the interval remains in the future.
   */
  deliveryFloorEnd(task: ScheduleTask): number | undefined {
    const end = this.nextAdmissionAt(task)
    return end > Date.now() ? end : undefined
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private nextAt(task: ScheduleTask): number {
    return task.pendingDelivery === undefined
      ? Math.max(Date.parse(task.record.scheduledAt), this.nextAdmissionAt(task))
      : Date.parse(task.pendingDelivery.scheduledAt)
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<ScheduleId>()
    const scanNow = Date.now()
    for (const task of this.tasks()) {
      if (this.stopping) return
      if (task.status !== 'active' || this.nextAt(task) > scanNow) continue
      try {
        if (await this.waiting(task, Date.now())) failed.add(task.record.id)
        else if (this.nextAt(task) <= Date.now()) await this.dispatch(task, false)
      } catch (error: unknown) {
        failed.add(task.record.id)
        this.ctx.logger.warn('codex-schedule: 投递未确认 ' + task.record.id + ' ' + String(error))
      }
    }
    if (this.stopping) return
    const now = Date.now()
    const next = this.tasks().filter(task => task.status === 'active')
      .reduce<number | undefined>((at, task) => {
        const target = Math.max(this.nextAt(task), failed.has(task.record.id) ? now + RETRY_DELAY_MS : 0)
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - now, MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }

  private async waiting(task: ScheduleTask, now: number): Promise<boolean> {
    if (task.pendingDelivery !== undefined) return false
    if (this.nextAdmissionAt(task) > now) return true
    const receipt = task.lastDelivery
    return receipt !== undefined && await this.delivery.outstanding(receipt.targetSessionId, receipt.messageId)
  }

  /** 保存出站标识后再写入 Codex。重启后恢复同一次投递及其原始发生时点。 */
  private async dispatch(task: ScheduleTask, manual: boolean, signal?: AbortSignal): Promise<ScheduleTask> {
    if (this.stopping) throw new Error('Schedule runtime is stopping')
    if (task.target.kind !== 'session') throw new Error('Codex schedule requires an existing thread')
    const now = Date.now()
    const occurrenceAt = manual ? new Date(now).toISOString() : isRecurringScheduleRecord(task.record)
      ? resolveRecurringOccurrence(task.record, now).occurrenceAt : task.record.scheduledAt
    const pending = task.pendingDelivery ?? {
      targetSessionId: task.target.sessionId,
      messageId: brandString<ScheduleDeliveryReceipt['messageId']>(randomUUID()),
      scheduledAt: occurrenceAt,
      prompt: task.record.prompt,
      manual,
    }
    const occurrence = isRecurringScheduleRecord(task.record) && !pending.manual
      ? resolveRecurringOccurrence(task.record, Date.parse(pending.scheduledAt))
      : { occurrenceAt: pending.scheduledAt }
    const text = renderReminderFraming({ ...task.record, scheduledAt: pending.scheduledAt, prompt: pending.prompt })
    const deliveredAt = await this.delivery.send(pending.targetSessionId, text, pending, task.pendingDelivery !== undefined,
      pendingDelivery => this.commit({ ...task, pendingDelivery }), signal)
    const receipt = {
      messageId: pending.messageId, scheduledAt: pending.scheduledAt, targetSessionId: pending.targetSessionId, deliveredAt,
    }
    const delivered = this.delivered(task, receipt, pending.prompt)
    const next = pending.manual ? delivered : {
      ...delivered, record: { ...delivered.record, scheduledAt: occurrence.nextScheduledAt ?? occurrence.occurrenceAt },
      status: occurrence.nextScheduledAt === undefined ? 'ended' as const : task.status,
    }
    await this.commit(next)
    return next
  }

  /** Earliest wall-clock instant at which this task may admit another delivery. */
  private nextAdmissionAt(task: ScheduleTask): number {
    const receipt = task.lastDelivery
    if (receipt === undefined) return Number.NEGATIVE_INFINITY
    const interval = task.target.kind === 'new' ? this.limits.newSessionIntervalMs : MIN_DELIVERY_INTERVAL_MS
    const occurrence = Date.parse(receipt.scheduledAt)
    // An occurrence whose successor already keeps the interval anchors the floor, so acknowledgment latency neither
    // accumulates across occurrences nor carries a deferral forward.
    const anchor = Date.parse(task.record.scheduledAt) - occurrence >= interval ? occurrence : Date.parse(receipt.deliveredAt)
    return anchor + interval
  }

  /** Apply one receipt to the target, involved Sessions, and history while keeping the scheduled occurrence. */
  private delivered(task: ScheduleTask, receipt: ScheduleDeliveryReceipt, prompt: string): ScheduleTask {
    return {
      ...task,
      target: task.target.kind === 'new_once' ? { kind: 'session', sessionId: receipt.targetSessionId } : task.target,
      // Each delivery of a `new` target creates a Session; recording them all would grow the task without bound.
      involvedSessionIds: task.target.kind === 'new'
        ? task.involvedSessionIds
        : [...new Set([...task.involvedSessionIds, receipt.targetSessionId])],
      updatedAt: new Date(Math.max(
        Date.parse(receipt.deliveredAt),
        task.updatedAt === undefined ? Date.parse(receipt.deliveredAt) : Date.parse(task.updatedAt) + 1,
      )).toISOString(),
      pendingDelivery: undefined,
      ...appendDelivery({ ...task, record: { ...task.record, prompt } }, receipt, this.limits.retention),
    }
  }
}
