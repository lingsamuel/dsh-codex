import assert from 'node:assert/strict'
import test from 'node:test'
import { nativeQuestionSubmission, projectNativeQuestions } from '../src/client/native-dsh/native-questions.js'

test('普通和保密 Codex 请求都进入 DSH 原生问答卡', () => {
  const options = [{ label: 'Staging', description: 'Use the staging environment' }]
  const result = projectNativeQuestions([
    { itemId: 'public', questions: [{ id: 'env', header: 'Deploy', question: 'Where?', options }] },
    { itemId: 'private', questions: [
      { id: 'host', question: 'Hostname?' }, { id: 'password', question: 'Password?', isSecret: true },
    ] },
    { itemId: 'empty', questions: [] },
  ])
  assert.deepEqual(result, {
    active: [
      { callId: 'public', state: 'continued', questions: [{ id: 'env', header: 'Deploy', question: 'Where?', options }] },
      { callId: 'private', state: 'continued', questions: [
        { id: 'host', question: 'Hostname?' }, { id: 'password', question: 'Password?' },
      ] },
    ],
    settled: [],
  })
})

test('DSH 的已选项、自定义选项、自由输入和跳过转换为 Codex 原生答案', () => {
  const options = [{ label: 'Staging' }]
  const questions = [{ id: 'environment', options }, { id: 'other', options, isOther: true },
    { id: 'note', options: null }, { id: 'skipped', options }]
  assert.deepEqual(nativeQuestionSubmission(questions, { answers: [
    { id: 'environment', selected: ['Staging'] },
    { id: 'other', selected: [], custom: 'A test cluster' },
    { id: 'note', selected: [], custom: 'Use a backup' },
    { id: 'skipped', selected: [] },
  ] }, '保密答复').answers, {
    environment: { answers: ['Staging'] },
    other: { answers: ['None of the above', 'user_note: A test cluster'] },
    note: { answers: ['user_note: Use a backup'] },
    skipped: { answers: [] },
  })
})
