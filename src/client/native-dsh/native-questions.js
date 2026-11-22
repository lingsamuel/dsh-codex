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
