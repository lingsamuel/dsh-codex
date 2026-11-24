import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { transformSync } from 'esbuild'

const source = new URL('../src/client/native-dsh/history-details.jsx', import.meta.url)

const load = async () => {
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
        return { shortCircuit: true, url: 'data:text/javascript,export const Button = "button"' }
      }
      return next(specifier, context)
    },
    load(url, context, next) {
      if (url !== source.href) return next(url, context)
      const { code } = transformSync(readFileSync(source, 'utf8'), { loader: 'jsx', jsx: 'automatic' })
      return { format: 'module', shortCircuit: true, source: code }
    },
  })
  try { return await import(source) } finally { hook.deregister() }
}

function elementWith(node, match) {
  if (Array.isArray(node)) return node.map(child => elementWith(child, match)).find(Boolean)
  if (typeof node?.type === 'function') return elementWith(node.type(node.props), match)
  if (node && match(node)) return node
  return node?.props && elementWith(node.props.children, match)
}

async function fixture() {
  const { installHistoryDetails } = await load()
  const registrations = new Map()
  const dictionaries = new Map()
  const flow = { inject: () => ({}), component: () => null }
  const turn = { start: { data: { codexTurnId: 'native-turn' } }, status: 'open' }
  const timeline = { turnOrder: [15], turns: new Map([[15, turn]]) }
  const details = { 'native-turn': { loading: false } }
  const requests = []
  const session = { loadHistoryDetails(turnId) {
    details[turnId] = { loading: true }
    return new Promise((resolve, reject) => requests.push({ turnId, resolve, reject }))
  } }
  const ctx = {
    effect: activate => activate(),
    inject: (_services, activate) => activate(ctx),
    on: () => () => {},
    sessions: { binding: () => ({ session }) },
    locale: { register: (key, copy) => dictionaries.set(key, copy), bind: key => label => dictionaries.get(key).zh[label] },
    slots: {
      inject: (_slot, activate) => activate(),
      entries: name => name === 'conversation.chat.flow' ? [flow] : [],
      register: (options, component) => registrations.set(options.name, { ...options, component }),
    },
  }
  installHistoryDetails(ctx)
  const props = {
    useProjection: (key, select) => select(key === 'historyDetails' ? details : undefined),
    useChat: select => select({ timeline }),
  }
  const tail = registrations.get('conversation.chat.turnTail')
  return { turn, details, requests,
    tail: () => tail.component({ ...props, turn, ...tail.inject('thread'), t: ctx.locale.bind(tail.locale) }),
    flow: () => flow.component({ ...props, ...flow.inject('thread') }),
  }
}

const button = node => elementWith(node, element => element.type === 'button')

test('摘要详情用原生轮次 ID 逐页读取，失败可重试，读完移除入口', async () => {
  const { tail, turn, details, requests } = await fixture()
  turn.status = 'closed'
  const first = button(tail())
  assert.equal(first.props.children, '加载本轮详情')
  const loading = first.props.onClick()
  assert.equal(requests[0].turnId, 'native-turn')
  assert.equal(button(tail()).props.disabled, true)
  assert.equal(elementWith(tail(), element => element.props?.role === 'status').props.children, '正在加载本轮详情…')
  details['native-turn'] = { loading: false, error: 'connection failed' }
  requests[0].reject(new Error('connection failed'))
  await loading
  assert.equal(elementWith(tail(), element => element.props?.role === 'status').props.children, '无法加载本轮详情。')
  const retry = button(tail()).props.onClick()
  assert.equal(requests[1].turnId, 'native-turn')
  details['native-turn'] = { loading: false }
  requests[1].resolve()
  await retry
  const next = button(tail()).props.onClick()
  assert.equal(requests[2].turnId, 'native-turn')
  delete details['native-turn']
  requests[2].resolve()
  await next
  assert.equal(button(tail()), undefined)
})

test('进行中的摘要在聊天流提供详情入口，轮次结束后由原生尾部接管', async () => {
  const { flow, tail, turn } = await fixture()
  assert.equal(button(flow()).props.children, '加载本轮详情')
  turn.status = 'closed'
  assert.equal(button(flow()), undefined)
  assert.equal(button(tail()).props.children, '加载本轮详情')
})
