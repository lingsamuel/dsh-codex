import assert from 'node:assert/strict'
import test from 'node:test'
import { projectFileLinks } from '../src/client/native-chat/file-links.js'

test('只转换 Markdown 文件目标并保留链接文字、代码与外部链接', () => {
  const source = [
    '[绝对行号](/home/user/a.ts:42:3 "说明")',
    '[相对行号](src/a%20b.js:8)',
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
    .replace('file:///home/user/a%20b.js#L10-L12', '/home/user/a%20b.js#L10-L12')
    .replace('file:///home/user/main.js#17', '/home/user/main.js#L17')
    .replace('/home/user/a.ts:9', '/home/user/a.ts#L9'))
})
