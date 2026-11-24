import { createHash } from 'node:crypto'
import { z } from 'zod'
import { codexSchedulePath } from '../shared/schedule-for-codex.js'
import { createScheduleDelivery } from './schedule-delivery.mjs'

const text = z.string()
const id = text.min(1)
const target = z.object({ kind: z.literal('session'), sessionId: id })
const timing = z.looseObject({ kind: text })
const rule = z.object({ title: text, prompt: text, timing, target })
const planEdit = z.discriminatedUnion('action', [
  z.object({ id, action: z.literal('delete'), expectedUpdatedAt: text.nullish() }),
  z.object({ id, action: z.literal('update'), expectedUpdatedAt: text.nullish(),
    patch: rule.partial().extend({ active: z.boolean().optional() }) }),
])
const actions = {
  catalog: [z.undefined(), schedule => schedule.catalog()],
  create: [rule, (schedule, params, signal) => schedule.remoteCreate(params, signal)],
  edit: [planEdit, (schedule, params, signal) => schedule.remoteEdit(params, signal)],
  run: [z.object({ id }), (schedule, params, signal) => schedule.run(params, signal)],
  history: [z.object({ id, before: id.optional(), limit: z.int().min(1).max(100) }), (schedule, params) => schedule.remoteHistory(params)],
  deleteInactive: [z.undefined(), schedule => schedule.deleteInactive()],
  deliveryLimits: [z.undefined(), schedule => schedule.deliveryLimits()],
}

function scheduleEvents(changes, signal) {
  const encoder = new TextEncoder()
  let stop
  let flush
  let pending = false
  return new Response(new ReadableStream({
    start(controller) {
      if (signal.aborted) {
        controller.close()
        return
      }
      const send = value => {
        if (controller.desiredSize > 0) controller.enqueue(encoder.encode(value))
      }
      flush = () => {
        if (!pending || controller.desiredSize <= 0) return
        pending = false
        send('data: changed\n\n')
      }
      const sendChange = () => {
        pending = true
        flush()
      }
      const heartbeat = setInterval(() => send(': heartbeat\n\n'), 20_000)
      heartbeat.unref()
      const close = () => {
        stop()
        controller.close()
      }
      stop = () => {
        clearInterval(heartbeat)
        changes.removeEventListener('changed', sendChange)
        signal.removeEventListener('abort', close)
      }
      changes.addEventListener('changed', sendChange)
      signal.addEventListener('abort', close, { once: true })
      sendChange()
    },
    pull() { flush?.() },
    cancel() { stop?.() },
  }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
}

/** 复用 DSH 已认证的同源传输。原生任务接口与任务资料都由官方插件持有。 */
export function createCodexScheduleRoute(schedule, changes, ownerSignal) {
  return {
    path: codexSchedulePath,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const signal = AbortSignal.any([request.signal, ownerSignal])
      if (request.method === 'GET') return scheduleEvents(changes, signal)
      const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } })
      const failed = (code, status, details = {}) => json({ ok: false, error: { code, details } }, status)
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        return failed('schedule/input-invalid', 415, { code: 'invalid_rule' })
      }
      const { method, params } = await request.json().catch(() => null) ?? {}
      if (typeof method !== 'string' || !Object.hasOwn(actions, method)) return failed('schedule/method-not-found', 404)
      const [schema, run] = actions[method]
      const input = schema.safeParse(params)
      if (!input.success) return failed('schedule/input-invalid', 400, { code: 'invalid_rule' })
      try {
        return json({ ok: true, value: await run(schedule, input.data, signal) })
      } catch (error) {
        return error?.code === 'schedule/input-invalid' ? failed(error.code, 400, error.details) : failed('schedule/unavailable', 503)
      }
    },
  }
}

/** 共存页面切换不卸载 Host 插件，计划只随 DSH Profile 的生命周期运行。 */
export function installCodexSchedule(ctx, register, submit, ownerSignal) {
  ctx.plugin({
    name: 'dsh-schedule-for-codex',
    inject: ['storageDomain'],
    async apply(scope) {
      const [{ createScheduleForCodex }, storage] = await Promise.all([
        import('../../dist/dsh-schedule-for-codex.mjs'),
        scope.loader.import('@deepseek-ai/dsh-storage-domain'),
      ])
      const changes = new EventTarget()
      // DSH 的存储根是 Home 级别。不同 Profile 各自持有任务域，避免两个 Host 投递同一个计划。
      const profile = scope.get('profileContext')?.name ?? 'default'
      const key = createHash('sha256').update(profile).digest('hex').slice(0, 16)
      const schedule = createScheduleForCodex(storage, scope, createScheduleDelivery(submit, ownerSignal),
        () => changes.dispatchEvent(new Event('changed')), `codex_schedule_${key}`)
      register(createCodexScheduleRoute(schedule, changes, ownerSignal), scope)
    },
  })
}
