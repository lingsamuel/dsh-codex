import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toDiffHunks } from '../src/client/file-change.js'

test('新增和删除记录保留原始文件正文，包括前导加减号', () => {
  assert.deepEqual(toDiffHunks({ path: 'a', kind: { type: 'add' }, diff: '+text\n' }), [
    { path: 'a', oldText: null, newText: '+text\n' },
  ])
  assert.deepEqual(toDiffHunks({ path: 'b', kind: { type: 'delete' }, diff: '-text' }), [
    { path: 'b', oldText: '-text', newText: '' },
  ])
})

test('更新后的 DiffBlock 保留各个原生 hunk 的上下文、空行和重命名', () => {
  const diff = [
    '@@ -1,3 +1,3 @@', ' context', '-before', '+after', ' ',
    '@@ -90 +90 @@', '-old', '+new', '\\ No newline at end of file',
    '', '', 'Moved to: new.txt',
  ].join('\n')
  assert.deepEqual(toDiffHunks({ path: 'old.txt', kind: { type: 'update', move_path: 'new.txt' }, diff }), [
    { path: 'old.txt → new.txt', oldText: 'context\nbefore\n\n', newText: 'context\nafter\n\n' },
    { path: 'old.txt → new.txt', oldText: 'old\n', newText: 'new' },
  ])
})

test('保留没有内容差异的重命名，并区分无法解析的原生补丁', () => {
  assert.deepEqual(toDiffHunks({ path: 'a', kind: { type: 'update', move_path: 'b' }, diff: '\n\nMoved to: b' }), [
    { path: 'a → b', oldText: '', newText: '' },
  ])
  assert.equal(toDiffHunks({ path: 'a', kind: { type: 'update' }, diff: 'Binary files differ' }), null)
})
