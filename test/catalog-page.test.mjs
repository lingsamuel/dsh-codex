import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergePages } from '../src/shared/pages.js'

test('合并原生线程时同一 ID 只保留第一条，不合并同名会话', () => {
  const newest = { id: 'thread', name: 'same title', updatedAt: 30 }
  const duplicate = { ...newest, updatedAt: 20 }
  const unrelated = { ...newest, id: 'other' }
  assert.deepEqual(mergePages([], [newest, duplicate, unrelated]), [newest, unrelated])
  assert.deepEqual(mergePages([newest], [duplicate, unrelated]), [newest, unrelated])
})
