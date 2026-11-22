import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconQuestionOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState } from 'react'
import { writeAsyncQuestionAnswer, writeQuestionAnswer } from '../api.js'
import { asyncQuestionAnswers, nativeQuestionAnswers } from './native-questions.js'

const composer = 'conversation.composer'
const utilities = 'conversation.session.header.utilities'
const overlay = 'shell.overlay'
const remoteKey = 'remote.userQuestions'
const locale = 'codex.question'
const labels = {
  zh: { open: '打开待回答的问题', close: '收起问题面板', loadingAndSubmitting: '正在加载会话并提交…',
    queued: '答复已交给 Codex。', alreadyAnswered: 'Codex 已有这条答复。' },
  en: { open: 'Open pending question', close: 'Close question panel', loadingAndSubmitting: 'Loading session and submitting…',
    queued: 'Answer submitted to Codex.', alreadyAnswered: 'Codex already has this answer.' },
}

function questionRequests(scope, sessionId) {
  return scope.sessions.binding(sessionId)?.session.projections.faceOf('codexQuestions').getSnapshot() ?? []
}

function QuestionReopen({ sessionId, useProjection, reveal, t }) {
  const callId = useProjection('userQuestions', questions => questions?.active[0]?.callId)
  if (!callId) return null
  return <Button size="sm" variant="toolbar" aria-label={t('open')} title={t('open')}
    icon={<IconQuestionOutlineRegular size={16} />} onClick={() => reveal(sessionId, callId)} />
}

function QuestionReceipt({ useQuestionReceipt, dismiss, t }) {
  const receipt = useQuestionReceipt(value => value)
  return receipt && <Toast key={receipt.id} tone="success" text={t(receipt.label)} onDone={() => dismiss(receipt)} />
}

/** 保密请求复用原生表单，整组草稿随面板卸载释放。 */
function SecretQuestionComposer({ Native, questions, ...props }) {
  const key = props.matched.key
  const [progress, setProgress] = useState()
  // 原生表单每次编辑都会调用草稿写入操作。在渲染前换成组件内存，防止任何一次输入落盘。
  const actions = useMemo(() => ({
    replace(_key, next) { setProgress(next) },
    clear() { setProgress(undefined) },
    prune(keep) { if (!keep.includes(key)) setProgress(undefined) },
  }), [key])
  const useStore = select => select({ progressByRequest: { [key]: progress } })
  const masked = questions[progress?.index ?? 0]?.isSecret
  return <div style={{ display: 'contents' }} spellCheck={false} data-codex-mask-question={masked || undefined}>
    <style>{'[data-codex-mask-question] textarea { -webkit-text-security: disc; }'}</style>
    <Native {...props} actions={actions} useStore={useStore} />
  </div>
}

/** 挂载 DSH 问答面板使用的应答能力。实时答复使用原请求，异步答复沿用 Codex 用户输入。 */
export function installCodexQuestions(ctx) {
  ctx.effect(() => ctx.locale.register(locale, labels))
  const translate = ctx.locale.bind(locale)
  const receipt = createSnapshotStore(null)
  let receiptId = 0
  ctx.inject([remoteKey, 'sessions'], scope => {
    scope.effect(() => {
      const remote = scope.get(remoteKey)
      const original = Object.getOwnPropertyDescriptor(remote, 'answer')
      async function answer(threadId, callId, submitted) {
        const request = questionRequests(scope, threadId).find(row => row.itemId === callId)
        if (!request) return { ok: true, value: false }
        if (request.kind === 'async') {
          const answers = asyncQuestionAnswers(request.questions, submitted)
          if (!answers.length) return { ok: true, value: false }
          const { submitted: accepted } = await writeAsyncQuestionAnswer({ threadId, turnId: request.turnId, itemId: request.itemId, answers })
          receipt.set({ id: ++receiptId, label: accepted ? 'queued' : 'alreadyAnswered' })
        } else {
          await writeQuestionAnswer({ threadId, requestId: request.requestId, answers: nativeQuestionAnswers(request.questions, submitted) })
        }
        return { ok: true, value: true }
      }
      // api-remotes 已挂载同名命名空间，保留它的注册和其它方法。
      Object.defineProperty(remote, 'answer', { configurable: true, enumerable: true, value: answer })
      return () => {
        if (Object.getOwnPropertyDescriptor(remote, 'answer')?.value === answer) Object.defineProperty(remote, 'answer', original)
      }
    })

    // 本机 Codex 的问题按请求寿命保留。DSH 的 continued 只表示经远程接口应答。
    scope.effect(() => {
      let registration
      let restore
      function sync() {
        const entry = scope.slots.entries(composer).find(candidate => candidate.locale === 'question')
        if (entry === registration) return
        restore?.()
        registration = entry
        restore = undefined
        if (!entry?.component) return
        const Native = entry.component
        function CodexQuestionComposer({ matched, t, ...props }) {
          const request = questionRequests(scope, matched.sessionId).find(row => row.itemId === matched.callId)
          const translateQuestion = (key, ...args) => {
            if (request && key === 'nav.close') return translate('close')
            if (key === 'submitting' && request?.kind === 'async'
              && scope.sessions.binding(matched.sessionId)?.session.getSnapshot().live.status?.type === 'notLoaded') {
              return translate('loadingAndSubmitting')
            }
            return t(request?.isBlocking && key === 'wait.continued' ? 'wait.held' : key, ...args)
          }
          if (request?.questions.some(question => question.isSecret)) {
            return <SecretQuestionComposer key={matched.key} Native={Native} questions={request.questions}
              {...props} matched={matched} t={translateQuestion} />
          }
          return <Native {...props} matched={matched} t={translateQuestion} />
        }
        entry.component = CodexQuestionComposer
        restore = () => { if (entry.component === CodexQuestionComposer) entry.component = Native }
      }
      const unsubscribe = scope.on('slots/changed', name => { if (name === composer) sync() })
      sync()
      return () => { unsubscribe(); restore?.() }
    })
  })
  ctx.slots.inject(overlay, () => ctx.slots.register({ name: overlay, id: 'codex-question-receipt', locale,
    inject: () => ({ hooks: { questionReceipt: receipt }, dismiss: shown => {
      if (receipt.getSnapshot() === shown) receipt.set(null)
    } }),
  }, QuestionReceipt))
  ctx.inject(['userQuestionPanels'], scope => {
    scope.slots.inject(utilities, () => scope.slots.register({ name: utilities, id: 'codex-open-question', locale,
      inject: () => ({ reveal: (sessionId, callId) => scope.userQuestionPanels.reveal(sessionId, callId) }),
    }, QuestionReopen))
  })
}
