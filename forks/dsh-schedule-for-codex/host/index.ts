/** Host-wide durable reminders and shared human/model management. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ScheduleRuntime, type ScheduleRuntimeLimits, type CodexDelivery } from './runtime.ts'
import { scheduleDomain, scheduleTaskSchema, type ScheduleTask } from './storage.ts'
import { deliveryHistoryPage } from './delivery-history.ts'
import { createScheduleRecord, updateScheduleRecord } from './update.ts'
import {
  ScheduleInputError, MIN_EVERY_INTERVAL_SECONDS,
} from './domain.ts'
import type {
  ScheduleId, ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteInactiveResult, ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult, ScheduleEditRequest, ScheduleEditResult, ScheduleListRequest,
  ScheduleListResult, SchedulePatch, ScheduleRecord, ScheduleRunRequest, ScheduleRunResult,
  ScheduleTarget, ScheduleTargetRequest, ScheduleViewRequest, ScheduleViewResult,
} from './types.ts'
export type * from './client.ts'
export { scheduleDomain } from './storage.ts'
export type { ScheduleTask } from './storage.ts'
export type { RecurringOccurrence } from './domain.ts'
export { formatScheduleLocalTime } from './domain.ts'
export {
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  REQUIRED_TITLE_MESSAGE,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleRecord,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  weeklyTime,
} from './domain.ts'


/** Configuration for the Host Schedule domain. */
export interface Config {
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
  /**
   * Shortest spacing, in seconds, from the occurrence of one delivery to the next delivery of one task whose target
   * creates a Session at every delivery; omission defaults to 60. Timed and manual deliveries both wait for it.
   */
  newSessionIntervalSeconds?: number
}

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/** Spacing between Session-creating deliveries of one task applied when the deployment states none. */
const DEFAULT_NEW_SESSION_INTERVAL_SECONDS = 60

/** Page size of a task list request that states none. */
export const DEFAULT_LIST_LIMIT = 100

/** Largest page size of one task list request. */
export const MAX_LIST_LIMIT = 500

/** Keep actionable schedules first and pagination stable across equal timestamps. */
function compareEntries(left: ScheduleCatalogEntry, right: ScheduleCatalogEntry): number {
  const status = Number(left.status !== 'active') - Number(right.status !== 'active')
  if (status !== 0) return status
  if (left.status === 'active' && right.status === 'active') {
    return left.scheduledAt.localeCompare(right.scheduledAt) || left.id.localeCompare(right.id)
  }
  const leftRecent = left.lastDelivery?.deliveredAt ?? left.updatedAt ?? left.createdAt ?? left.scheduledAt
  const rightRecent = right.lastDelivery?.deliveredAt ?? right.updatedAt ?? right.createdAt ?? right.scheduledAt
  return rightRecent.localeCompare(leftRecent) || left.id.localeCompare(right.id)
}

/**
 * Resolve the page bounds of a task list request.
 * @param request - Activity filter and optional page bounds.
 * @returns Page size and number of sorted tasks to skip.
 * @throws ScheduleInputError when `limit` is outside 1 through 500 or `offset` is not a non-negative integer.
 */
function resolveListPage(request: ScheduleListRequest): { readonly limit: number; readonly offset: number } {
  const limit = request.limit ?? DEFAULT_LIST_LIMIT
  const offset = request.offset ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
    throw new ScheduleInputError('invalid_rule', `limit must be 1-${MAX_LIST_LIMIT} and offset must be a non-negative integer.`)
  }
  return { limit, offset }
}

/** Preserve stable Schedule validation codes across the Remote transport. */
function throwRemoteScheduleInput(error: unknown): never {
  if (error instanceof ScheduleInputError) {
    throw new RemoteError('schedule/input-invalid', error.message, { code: error.code })
  }
  throw error
}

/**
 * Add the acting Session and the existing or reserved target Session to the involved Sessions.
 * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
 * @param target - Destination after the change.
 * @param previous - Sessions involved before the change.
 * @returns Involved Sessions in first-involvement order.
 */
function involved(actorSessionId: SessionId | undefined, target: ScheduleTarget, previous: readonly SessionId[]): SessionId[] {
  const ids = new Set(previous)
  if (actorSessionId !== undefined) ids.add(actorSessionId)
  if (target.kind !== 'new') ids.add(target.sessionId)
  return [...ids]
}

/** Change time strictly after the stored one, so `expectedUpdatedAt` detects every later change across clock rollback. */
function revisedAt(task: ScheduleTask, now: number): string {
  return new Date(Math.max(now, (task.updatedAt === undefined ? now : Date.parse(task.updatedAt) + 1))).toISOString()
}

/** Apply one atomic edit through the same timing evaluator as creation. */
function revisedTask(
  current: ScheduleTask, patch: SchedulePatch, target: ScheduleTarget | undefined,
  actorSessionId: SessionId | undefined, now: number,
): ScheduleTask {
  const nextTarget = target ?? current.target
  const record = updateScheduleRecord(current.record, patch, now, patch.active === true)
  const changedRule = !isDeepStrictEqual({ ...record, title: current.record.title, prompt: current.record.prompt }, current.record)
  const updatedAt = revisedAt(current, now)
  const retargeted = target !== undefined && !isDeepStrictEqual(target, current.target)
  let status = current.status
  if (patch.active === false) status = 'paused'
  else if (patch.active === true || changedRule && current.status === 'ended') status = 'active'
  const { pendingDelivery, ...kept } = current
  return scheduleTaskSchema.parse({
    ...kept, record, target: nextTarget,
    involvedSessionIds: involved(actorSessionId, nextTarget, current.involvedSessionIds), status, updatedAt,
    ...(pendingDelivery === undefined || changedRule || retargeted ? {} : { pendingDelivery }),
  })
}

/** 独立的 Codex 任务域沿用官方管理和持久化逻辑。 */
export class ScheduleService {
  static Config: z<Config> = z.object({
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
    newSessionIntervalSeconds: z.number().step(1).min(MIN_EVERY_INTERVAL_SECONDS).max(604_800)
      .default(DEFAULT_NEW_SESSION_INTERVAL_SECONDS),
  })

  /** Resolved retention and admission limits shared with the runtime that appends acknowledgments. */
  private readonly limits: ScheduleRuntimeLimits
  private readonly ready: Promise<Domain<typeof scheduleDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated delivery-history retention and new-Session admission configuration.
   */
  constructor(private readonly ctx: Context, config: Config, private readonly delivery: CodexDelivery,
    private readonly changed: () => void, domainName: string) {
    this.limits = {
      retention: {
        days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
        records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
      },
      newSessionIntervalMs: (config.newSessionIntervalSeconds ?? DEFAULT_NEW_SESSION_INTERVAL_SECONDS) * 1_000,
    }
    this.ready = ctx.storageDomain.open({ ...scheduleDomain, name: domainName }).then(async (domain) => {
      try {
        for (const [key, task] of domain.table('tasks').entries()) {
          if (key !== task.record.id) {
            throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
          }
        }
      } catch (error: unknown) {
        // The open failure is the actionable error; a rejecting close must not replace it.
        try {
          await domain.close()
        } catch (closeError: unknown) {
          ctx.logger.warn(`schedule: closing the domain after an open failure failed: ${String(closeError)}`)
        }
        throw error
      }
      return domain
    })
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.chain // The chain contains failures after returning them to their callers.
          await domain.close()
        })
      } catch (error) {
        this.stopping = true
        await domain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, scheduleTaskSchema.parse(task))
          this.emitChanged()
        },
        this.limits,
        this.delivery)
      this.runtime.requestDrive()
      return cleanup
    })
  }

  /** Read effective delivery limits without loading or activating a task.
   * @returns The configured minimum spacing between deliveries that each create a Session, in seconds.
   */
  deliveryLimits(): { readonly newSessionIntervalSeconds: number } {
    return { newSessionIntervalSeconds: this.limits.newSessionIntervalMs / 1_000 }
  }

  /**
   * Create one task with a Host-generated identity for a human Remote caller.
   * @param request - Title, prompt, recurrence, and delivery destination.
   * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
   * @returns The stored task. Cancellation does not roll back an in-flight write.
   */
  async remoteCreate(request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleCatalogEntry> {
    try {
      return await this.create(request, undefined, signal)
    } catch (error: unknown) {
      throwRemoteScheduleInput(error)
    }
  }

  /**
   * Create one task and record the acting Agent's Session as involved; the Remote form omits that Session.
   *
   * The record is built from the clock reading taken before the request joins the serialized queue. A `session`
   * target must exist and must not belong to a delegated child; a `new_once` target reserves its Session identity.
   * @param request - Title, prompt, recurrence, and delivery destination.
   * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
   * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
   * @returns The stored task. Cancellation does not roll back an in-flight write.
   */
  async create(
    request: ScheduleCreateRequest,
    actorSessionId?: SessionId,
    signal?: AbortSignal,
  ): Promise<ScheduleCatalogEntry> {
    const id = brandString<ScheduleId>(`codex-schedule-${randomUUID()}`)
    const now = Date.now()
    const record = createScheduleRecord(id, request.title, request.prompt, request.timing, now)
    const target = this.resolveTarget(request.target)
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      await this.validateTarget(target, signal)
      signal?.throwIfAborted()
      const createdAt = new Date(now).toISOString()
      const task = scheduleTaskSchema.parse({
        record, target, involvedSessionIds: involved(actorSessionId, target, []), status: 'active',
        createdAt, updatedAt: createdAt,
        deliveryHistory: { records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false },
      })
      await domain.table('tasks').put(id, task)
      this.emitChanged()
      this.runtime?.requestDrive()
      return this.entry(task)
    })
  }

  /**
   * Read one page of Host tasks without activating target Sessions.
   * @param request - Optional activity filter, page size, and offset.
   * @returns The requested page and total matching task count.
   */
  async list(request: ScheduleListRequest = {}): Promise<ScheduleListResult> {
    const { limit, offset } = resolveListPage(request)
    const items = (await this.entries())
      .filter(entry => request.active === undefined || (entry.status === 'active') === request.active)
    const page = items.slice(offset, offset + limit)
    return { items: page, shown: page.length, total: items.length, limit, offset }
  }

  /**
   * Remote form of the shared Host-wide list.
   * @param request - Optional activity filter, page size, and offset.
   * @returns The requested page and total matching task count.
   */
  async remoteList(request: ScheduleListRequest): Promise<ScheduleListResult> {
    try {
      return await this.list(request)
    } catch (error: unknown) {
      throwRemoteScheduleInput(error)
    }
  }

  /**
   * Read every Host task without a page bound or Session activation.
   * @returns All tasks, active first, with target and execution metadata.
   */
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    return this.entries()
  }

  /**
   * Read one task without activating its target Sessions.
   * @param request - Task identity.
   * @returns The task, or a non-mutating miss.
   */
  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    const task = (await this.getDomain()).table('tasks').get(request.id)
    return task === undefined ? { id: request.id, code: 'schedule_not_found' } : this.entry(task)
  }

  /**
   * Read one page of saved deliveries without activating or reading a target Session.
   * @param request - Task identity, explicit page size, and optional exclusive cursor.
   * @returns Newest-first saved deliveries, or a task/cursor lookup failure.
   */
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    return task === undefined
      ? { id: request.id, code: 'schedule_not_found' }
      : deliveryHistoryPage(task, request, this.limits.retention)
  }

  /**
   * Remote form of the target-based {@link ScheduleService.history}; an invalid limit rejects with
   * `schedule/input-invalid`.
   * @param request - Task identity, explicit limit, and optional exclusive message cursor.
   * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
   */
  async remoteHistory(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    try {
      return await this.history(request)
    } catch (error: unknown) {
      throwRemoteScheduleInput(error)
    }
  }

  /**
   * Deliver one task now without consuming or moving its scheduled occurrence; an archived destination Session rejects
   * with `schedule/target-archived`.
   * @param request - Task identity.
   * @param signal - Cancellation checked after entering the delivery transaction and before delivery.
   * @returns Task state after Session persistence acknowledged the delivery, `schedule_execution_pending` while
   * another execution of the task is queued, running, or inside its delivery floor, or a non-mutating miss.
   */
  async run(request: ScheduleRunRequest, signal?: AbortSignal): Promise<ScheduleRunResult> {
    await this.getDomain()
    /* v8 ignore next -- initialization installs the runtime before the domain becomes readable. */
    if (this.runtime === undefined) throw new Error('Schedule runtime is unavailable')
    const result = await this.runtime.runNow(request.id, signal)
    if (result === undefined) return { id: request.id, code: 'schedule_not_found' }
    return result.admitted ? this.entry(result.task) : { id: request.id, code: 'schedule_execution_pending' }
  }

  /**
   * Delete every ended Host task, leaving active tasks armed.
   *
   * Ended tasks never schedule another delivery, so the removal changes no pending
   * target and no timer is recomputed. Rows are enumerated and removed in one FIFO
   * slot, so a delivery ordered behind this call ends its task after the
   * enumeration rather than during it. The batch is one domain write: a normal
   * failure rejects with every listed row still stored, while a backend
   * `unknown-state` failure may have removed rows and quarantines the Host
   * domain, so later schedule operations reject until the domain is reopened.
   * A successful nonempty batch emits `schedule/changed` without Agent notices.
   * A rejected batch announces `schedule/changed` because it does not establish
   * which rows landed, and clients then re-read the catalog.
   * @returns Count of removed rows; zero when the Host held no ended task.
   */
  async deleteInactive(): Promise<ScheduleDeleteInactiveResult> {
    return this.serialize<ScheduleDeleteInactiveResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      const ended = [...tasks.entries()]
        .filter(([, task]) => task.status === 'ended')
        .map(([id]) => id)
      return { deleted: await this.removeRows(ended, 'schedule ended-task removal failed', false) }
    })
  }

  /**
   * Update or delete one task for a human Remote caller; an invalid patch rejects with `schedule/input-invalid`.
   * @param request - Task identity and one update or delete operation.
   * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
   * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
   */
  async remoteEdit(request: ScheduleEditRequest, signal?: AbortSignal): Promise<ScheduleEditResult> {
    try {
      return await this.edit(request, undefined, signal)
    } catch (error: unknown) {
      throwRemoteScheduleInput(error)
    }
  }

  /**
   * Update or delete one task and record the acting Agent's Session as involved; the Remote form omits that Session.
   *
   * An update applies every patch field in one write and recomputes the next occurrence when the rule changes or
   * the task resumes. A supplied `expectedUpdatedAt` that differs from the stored value returns `schedule_conflict`.
   * @param request - Task identity and one update or delete operation.
   * @param actorSessionId - Session of the acting Agent, or undefined for a human caller.
   * @param signal - Cancellation checked before the durable write begins, including after FIFO waits.
   * @returns The updated task, the deletion outcome, or a non-mutating miss or conflict.
   */
  async edit(
    request: ScheduleEditRequest,
    actorSessionId?: SessionId,
    signal?: AbortSignal,
  ): Promise<ScheduleEditResult> {
    if (request.action === 'update' && Object.keys(request.patch).length === 0) {
      throw new ScheduleInputError('invalid_rule', 'An update patch requires at least one field.')
    }
    const target = request.action === 'update' && request.patch.target !== undefined
      ? this.resolveTarget(request.patch.target)
      : undefined
    return this.serialize<ScheduleEditResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined) return { id: request.id, code: 'schedule_not_found' }
      if (request.expectedUpdatedAt !== undefined && request.expectedUpdatedAt !== (current.updatedAt ?? null)) {
        return { id: request.id, code: 'schedule_conflict' }
      }
      if (request.action === 'delete') {
        await tasks.delete(request.id)
        this.emitChanged()
        this.runtime?.requestDrive()
        return { id: request.id, deleted: true }
      }
      const effectiveTarget = target ?? current.target
      if (target !== undefined || request.patch.timing !== undefined || request.patch.active === true) {
        await this.validateTarget(effectiveTarget, signal)
        signal?.throwIfAborted()
      }
      const task = revisedTask(current, request.patch, target, actorSessionId, Date.now())
      await tasks.put(request.id, task)
      this.emitChanged()
      this.runtime?.requestDrive()
      return this.entry(task)
    })
  }

  /**
   * Dispatch one post-commit `schedule/changed` notification, containing
   * synchronous listener failures: every call site emits only after its durable
   * task write landed, so a throwing listener must not reject the caller or
   * skip the following `requestDrive()`.
   */
  private emitChanged(): void {
    try {
      this.changed()
    } catch (error: unknown) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant.
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof scheduleDomain>> {
    await this.initialized
    return this.ready
  }

  /** 只接受已有会话。计划创建只读校验，不加载或唤醒 Codex。 */
  private resolveTarget(request: ScheduleTargetRequest | undefined): ScheduleTarget {
    if (request?.kind !== 'session' || typeof request.sessionId !== 'string' || !request.sessionId.trim()) {
      throw new ScheduleInputError('invalid_rule', '请选择已有的 Codex 会话。')
    }
    return { kind: 'session', sessionId: request.sessionId }
  }

  private async validateTarget(target: ScheduleTarget, signal?: AbortSignal): Promise<void> {
    if (target.kind !== 'session') throw new ScheduleInputError('invalid_rule', '请选择已有的 Codex 会话。')
    try {
      await this.delivery.validate(target.sessionId, signal)
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && (error.code === -32600 || error.code === -32602)) {
        throw new ScheduleInputError('invalid_rule', error.message)
      }
      throw error
    }
  }

  /** Every stored task as a catalog entry, in {@link compareEntries} order. */
  private async entries(): Promise<ScheduleCatalogEntry[]> {
    return [...(await this.getDomain()).table('tasks').entries()].map(([, task]) => this.entry(task)).sort(compareEntries)
  }

  private entry(task: ScheduleTask): ScheduleCatalogEntry {
    const floorEnd = this.runtime?.deliveryFloorEnd(task)
    return {
      ...task.record,
      target: task.target,
      involvedSessionIds: [...task.involvedSessionIds],
      status: task.status,
      ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
      ...(task.updatedAt === undefined ? {} : { updatedAt: task.updatedAt }),
      ...(floorEnd === undefined ? {} : { deliveryFloorEndsAt: new Date(floorEnd).toISOString() }),
      ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
    }
  }

  /**
   * Remove rows as one durable batch inside the current queue slot.
   *
   * The batch is one domain write: on success every present row is removed and
   * announced. Any rejection announces `schedule/changed` because it does not
   * establish which rows landed; a normal failure leaves every row stored, and
   * an `unknown-state` failure may have removed some. A rejection reason that
   * carries no Error is wrapped with the operation label.
   * @param ids - rows to remove.
   * @param label - failure message prefix naming the operation that owned them.
   * @param rearm - whether the rows were armed, so the pending timer must be recomputed.
   * @returns the number of rows this call removed.
   */
  private async removeRows(ids: readonly ScheduleRecord['id'][], label: string, rearm: boolean): Promise<number> {
    if (ids.length === 0) return 0
    let removed: number
    try {
      removed = await (await this.getDomain()).table('tasks').deleteMany(ids)
    } catch (error: unknown) {
      // A rejection never establishes which rows landed, and the backend can
      // report `unknown-state` after removing some of them. Announce the change
      // so observers re-read instead of trusting their stale catalog.
      this.emitChanged()
      throw error instanceof Error ? error : new Error(`${label}: ${String(error)}`)
    }
    // Rows enumerated in this slot are present, so a non-empty batch always removed rows.
    this.emitChanged()
    if (rearm) this.runtime?.requestDrive()
    return removed
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // Preserve FIFO progress after the caller receives the failure.
    return pending
  }
}

export default ScheduleService
