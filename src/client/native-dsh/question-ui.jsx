import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Button, IconQuestionOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, useState, useSyncExternalStore } from 'react'
import { writeAsyncQuestionAnswer, writeQuestionAnswer } from '../api.js'
import { asyncQuestionSubmission, nativeQuestionSubmission } from './native-questions.js'

const composer = 'conversation.composer'
const utilities = 'conversation.session.header.utilities'
const overlay = 'shell.overlay'
const remoteKey = 'remote.userQuestions'
const locale = 'codex.question'
const labels = {
  zh: { open: '打开待回答的问题', close: '收起问题面板', loadingAndSubmitting: '正在加载会话并提交…',
    unarchiveAndSubmit: '取消归档并提交', skipAndSubmit: '跳过本题并取消归档提交',
    queued: '答复已交给 Codex。', alreadyAnswered: 'Codex 已有这条答复。', secretAnswer: '保密答复', skipped: '已跳过' },
  en: { open: 'Open pending question', close: 'Close question panel', loadingAndSubmitting: 'Loading session and submitting…',
    unarchiveAndSubmit: 'Unarchive and submit', skipAndSubmit: 'Skip this question, unarchive and submit',
    queued: 'Answer submitted to Codex.', alreadyAnswered: 'Codex already has this answer.', secretAnswer: 'Secret answer', skipped: 'Skipped' },
}
const subscribeMissing = () => () => {}

function questionRequest(session, callId) {
  return session?.projections.faceOf('codexQuestions').getSnapshot()?.find(row => row.itemId === callId)
}

/** 原生选项和文本框的 Enter 可以直接发送。归档期间保留选项激活和文本编辑行为。 */
function editArchivedAnswer(event) {
  if (event.key !== 'Enter') return
  const field = event.target.closest('textarea, [role="radio"], [role="checkbox"]')
  if (!field) return
  event.stopPropagation()
  if (field.localName === 'textarea') return
  event.preventDefault()
  field.click()
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
        const session = scope.sessions.binding(threadId)?.session
        const request = questionRequest(session, callId)
        if (!request) return { ok: true, value: false }
        const { turnId, itemId, questions } = request
        const asynchronous = request.kind === 'async'
        const { answers, replies } = asynchronous ? asyncQuestionSubmission(questions, submitted)
          : nativeQuestionSubmission(questions, submitted, translate('secretAnswer'))
        if (!replies.length) return { ok: true, value: false }
        const echo = session.beginQuestionReply(turnId, replies.map(({ question, answer }) =>
          `${question}\n${answer || translate('skipped')}`).join('\n\n'), !asynchronous)
        try {
          if (asynchronous) {
            const result = await writeAsyncQuestionAnswer({ threadId, turnId, itemId, answers, clientUserMessageId: echo.requestId,
              ...(session.getSnapshot().archived && { unarchive: true }) })
            if (!result.submitted) echo.abandon()
            else if (result.queuedForLater) echo.queuedForLater()
            receipt.set({ id: ++receiptId, label: result.submitted ? 'queued' : 'alreadyAnswered' })
          } else {
            await writeQuestionAnswer({ threadId, requestId: request.requestId, answers })
            await session.publishQuestionReply(turnId, itemId, echo.requestId, replies)
          }
        } catch (error) {
          if (!echo.observed()) {
            echo.abandon()
            throw error
          }
          echo.queuedForLater()
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
          const session = scope.sessions.binding(matched.sessionId)?.session
          const request = questionRequest(session, matched.callId)
          const archived = useSyncExternalStore(session?.subscribe ?? subscribeMissing,
            () => request?.kind === 'async' && session.getSnapshot().archived)
          const index = props.useStore(state => state.progressByRequest[matched.key]?.index ?? 0)
          const translateQuestion = (key, ...args) => {
            if (request && key === 'nav.close') return translate('close')
            if (archived && key === 'submit') return translate('unarchiveAndSubmit')
            // 原生最后一页的跳过也会提交，此时按钮需要说明同样的后果。
            if (archived && key === 'action.skip' && index === matched.questions.length - 1) return translate('skipAndSubmit')
            if (key === 'submitting' && request?.kind === 'async'
              && session.getSnapshot().live.status?.type === 'notLoaded') {
              return translate('loadingAndSubmitting')
            }
            return t(request?.isBlocking && key === 'wait.continued' ? 'wait.held' : key, ...args)
          }
          if (request?.questions.some(question => question.isSecret)) {
            return <SecretQuestionComposer key={matched.key} Native={Native} questions={request.questions}
              {...props} matched={matched} t={translateQuestion} />
          }
          return <div style={{ display: 'contents' }} onKeyDownCapture={archived ? editArchivedAnswer : undefined}>
            <Native {...props} matched={matched} t={translateQuestion} />
          </div>
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
