import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import { threadReferencesIn } from '../../shared/thread-references.js'
import { openCodexThread } from './catalog.js'

const id = 'codex-thread-reference'
const slot = 'conversation.user.text.node'

function ThreadReference({ node, raw, interactive, open }) {
  const { threadId, title } = node.data
  return <ReferenceChip appearance="session" label={title} title={raw}
    onActivate={interactive ? () => open(threadId) : undefined} />
}

/** 历史保留可复制的原生引用，在 DSH 中沿用会话样式和原生导航。 */
export function installThreadReferences(ctx, catalog, signal) {
  ctx.inject(['uiConversation', 'uiWorkspace', 'contextMenus'], scope => {
    scope.uiConversation.userText.register({
      id, order: 20,
      match(text, from) {
        const ref = threadReferencesIn(text).find(value => value.start >= from)
        if (ref) return { id, start: ref.start, end: ref.end, data: { threadId: ref.threadId, title: ref.title } }
      },
    })
    scope.slots.inject(slot, () => scope.slots.register({
      name: slot, key: id, priority: 100,
      inject: () => ({
        open(threadId) {
          void openCodexThread(catalog, scope.uiWorkspace, threadId, signal)
            .catch(error => { if (!signal.aborted) scope.contextMenus.notify(error.message, false) })
        },
      }),
    }, ThreadReference))
  })
}
