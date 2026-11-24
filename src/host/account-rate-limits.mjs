const windowKeys = ['primary', 'secondary']
const retryAfterResetMs = 60_000
const minReadIntervalMs = 30_000
const maxTimerMs = 2_147_483_647

function mergeWindows(previous, update) {
  return Object.fromEntries(windowKeys.flatMap(key => {
    const window = update?.[key]
    const current = previous?.[key]
    if (!Number.isFinite(window?.usedPercent)) return current ? [[key, current]] : []
    return [[key, {
      usedPercent: window.usedPercent,
      windowDurationMins: window.windowDurationMins ?? current?.windowDurationMins,
      resetsAt: window.resetsAt ?? current?.resetsAt,
    }]]
  }))
}

/** 用账户快照和普通 Codex 额度广播维护时间窗口，只发布浏览器需要的字段。 */
export function observeAccountRateLimits(request, send, signal) {
  let limits
  let reading
  let timer
  let lastReadAt = 0
  let turnRefreshAt = Infinity

  function publish() {
    const windows = Object.entries(limits ?? {}).map(([key, window]) => ({
      key, remaining: Math.max(0, Math.min(100, 100 - window.usedPercent)),
      minutes: window.windowDurationMins ?? null, resetsAt: window.resetsAt ?? null,
    }))
    send({ type: 'account-rate-limits', windows })
  }

  function scheduleRefresh() {
    clearTimeout(timer)
    const resetsAt = Math.min(...Object.values(limits ?? {}).map(window => window.resetsAt || Infinity))
    const now = Date.now()
    const untilReset = resetsAt * 1000 - now
    const delay = Math.min(untilReset < 0 ? retryAfterResetMs : untilReset + 1000, turnRefreshAt - now)
    if (!Number.isFinite(delay) || signal.aborted) return
    timer = setTimeout(refresh, Math.min(maxTimerMs, delay))
    timer.unref()
  }

  async function refresh() {
    if (reading || signal.aborted) return
    lastReadAt = Date.now()
    turnRefreshAt = Infinity
    const read = {}
    reading = read
    try {
      const { rateLimits, rateLimitsByLimitId } = await request('account/rateLimits/read', { excludeResetCreditDetails: true })
      if (reading !== read || signal.aborted) return
      const ordinary = rateLimitsByLimitId?.codex ?? (isCodexQuota(rateLimits) ? rateLimits : undefined)
      // 广播可能比读取结果更近。保留读期间收到的窗口更新。
      limits = mergeWindows(mergeWindows(undefined, ordinary), read.updates)
      publish()
    } catch {
      // 认证方式不提供订阅额度时入口保持隐藏，偶发读失败时保留已有窗口。
    } finally {
      if (reading === read) {
        reading = undefined
        scheduleRefresh()
      }
    }
  }

  signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  void refresh()
  return ({ method, params }) => {
    if (method === 'account/updated') {
      clearTimeout(timer)
      reading = limits = undefined
      publish()
      void refresh()
    } else if (method === 'account/rateLimits/updated' && limits && isCodexQuota(params?.rateLimits)) {
      if (reading) reading.updates = mergeWindows(reading.updates, params.rateLimits)
      limits = mergeWindows(limits, params.rateLimits)
      publish()
      scheduleRefresh()
    } else if (method === 'thread/status/changed' && params?.status?.type === 'idle' && Object.keys(limits ?? {}).length) {
      // 有些额度广播只发给轮次所属的连接。目录用全局空闲通知做合并后的读回。
      turnRefreshAt = Math.min(turnRefreshAt, Math.max(Date.now() + 1000, lastReadAt + minReadIntervalMs))
      scheduleRefresh()
    }
  }
}

function isCodexQuota(snapshot) {
  return snapshot && (snapshot.limitId == null || snapshot.limitId === 'codex')
}
