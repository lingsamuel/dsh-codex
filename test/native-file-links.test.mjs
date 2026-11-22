import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFileLinks } from '../src/client/native-chat/file-links.js'

test('只转换 Markdown 文件目标并保留链接文字、代码与外部链接', () => {
  const source = [
    '[绝对行号](/home/user/a.ts:42:3 "说明")',
    '[相对行号](src/a%20b.js:8)',
    '[无扩展名](Makefile:12)',
    '[电话号码](tel:12345)',
    '[冒号范围](/home/user/a.ts:8:3-12:4)',
    '[末尾有列号](/home/user/a.ts#L8-L12C4)',
    '[本地 URI](file:///home/user/a%20b.js#L10-L12)',
    '[裸文件 URI](file:///home/user/main.js#17)',
    '[外部链接](https://example.test/a.ts:42)',
    '[远程 file URL](file://server/share/a.ts:42)',
    '`[例子](/home/user/a.ts:42)`',
    '```md\n[示例](/home/user/a.ts:42)\n```',
    '[引用][doc]\n\n[doc]: /home/user/a.ts:9 "标题"',
  ].join('\n\n')
  assert.equal(projectFileLinks(source), source
    .replace('/home/user/a.ts:42:3', '/home/user/a.ts#L42')
    .replace('src/a%20b.js:8', 'src/a%20b.js#L8')
    .replace('Makefile:12', 'Makefile#L12')
    .replace('/home/user/a.ts:8:3-12:4', '/home/user/a.ts#L8-L12')
    .replace('/home/user/a.ts#L8-L12C4', '/home/user/a.ts#L8-L12')
    .replace('file:///home/user/a%20b.js#L10-L12', '/home/user/a%20b.js#L10-L12')
    .replace('file:///home/user/main.js#17', '/home/user/main.js#L17')
    .replace('/home/user/a.ts:9', '/home/user/a.ts#L9'))
})

test('原生轮次目录固定相对文件引用，同时保留跳转、外部地址与绝对文件路径', () => {
  const markdown = '[文件](src/name%20one.ts:3) [文档](README.md) [跳转](#detail) [外部](https://example.test/file) [绝对](/already/absolute.txt)'
  assert.equal(projectFileLinks(markdown, '/main checkout'), '[文件](/main%20checkout/src/name%20one.ts#L3) [文档](/main%20checkout/README.md) [跳转](#detail) [外部](https://example.test/file) [绝对](/already/absolute.txt)')
})
