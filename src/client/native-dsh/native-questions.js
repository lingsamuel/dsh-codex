import { answeredAsyncQuestions, asyncQuestionItemId } from '../../shared/question-replies.js'

const empty = { active: [], settled: [] }
const otherLabel = 'None of the above'

export function isBrowserQuestion(request) {
  return request.questions.length > 0 && request.questions.every(question => !question.isSecret)
}

/** 仅把 Codex 此刻仍可回答的请求交给 DSH 的原生问答卡。 */
export function projectNativeQuestions(requests) {
  const active = requests.filter(isBrowserQuestion).map(({ itemId, questions }) => ({
    callId: itemId,
    // RC2 的远程应答通道从 continued 投影创建卡片。等待文案使用原生请求的实际状态。
    state: 'continued',
    questions: questions.map(({ id, header, question, options }) => ({
      id, ...(header && { header }), question, ...(options?.length && { options }),
    })),
  }))
  return active.length ? { active, settled: [] } : empty
}

/** 异步问题随原生消息落盘。即使后面还有工具或正文，仍属于同一轮的待回答问题。 */
export function projectAsyncQuestions(turn, queued) {
  const items = turn?.items
  if (!items?.some(item => item.type === 'agentMessage' && item.questions?.length)) return []
  const inputs = [...items.filter(item => item.type === 'userMessage').map(item => item.content),
    ...queued.map(submission => submission.input)]
  const answered = answeredAsyncQuestions(inputs)
  const requests = []
  for (const item of items) {
    if (item.type !== 'agentMessage' || !item.questions?.length || answered.has(item.id)) continue
    // 较旧的桌面客户端使用条目 ID。较新的答复分别包含每道题目的 ID。
    const questions = item.questions.flatMap(({ title, options }, index) => {
      const id = asyncQuestionItemId(item.id, index)
      return answered.has(id) ? [] : [{ id, index, question: title, options: options?.map(label => ({ label })) }]
    })
    if (questions.length) requests.push({ kind: 'async', itemId: item.id, turnId: turn.id, questions })
  }
  return requests
}

/** 异步答复沿用 Codex 的单段文本。它不是实时请求里的多选和 user_note 载荷。 */
export function asyncQuestionAnswers(questions, submitted) {
  const inputs = new Map(submitted.answers.map(answer => [answer.id, answer]))
  return questions.flatMap(({ id, index }) => {
    const input = inputs.get(id)
    const answer = input?.custom?.trim() || input?.selected?.[0]?.trim()
    return answer ? [{ index, answer }] : []
  })
}

/** 将 DSH 的选项和自由输入转成 Codex CLI 使用的原生答案载荷。 */
export function nativeQuestionAnswers(questions, submitted) {
  const byId = new Map(submitted.answers.map(answer => [answer.id, answer]))
  return Object.fromEntries(questions.map(question => {
    const { selected = [], custom } = byId.get(question.id) ?? {}
    const notes = custom?.trim()
    // Codex 把自由描述作为 user_note，带选项的 Other 还会提交对应的选择标签。
    const answers = notes ? [...selected, ...(question.isOther && question.options?.length && !selected.length ? [otherLabel] : []),
      `user_note: ${notes}`] : selected
    return [question.id, { answers }]
  }))
}
