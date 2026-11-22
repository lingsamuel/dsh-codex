const chatNode = 'conversation.chat.node'
const tailContent = 'conversation.chat.turnTail'

/** 在原生 DSH 分支按钮中采用 Codex 的整轮分支边界。 */
export function installTurnFork(ctx) {
  ctx.inject(['sessions'], scope => {
    scope.effect(() => {
      let entry
      let restore
      function sync() {
        const next = scope.slots.entries(chatNode).find(candidate => candidate.options.key === 'turn-tail')
        if (next === entry) return
        restore?.()
        entry = next
        restore = undefined
        if (!next?.component) return

        const Native = next.component
        const inject = next.inject
        const injectBoundary = (sessionId, ...args) => ({
          ...inject?.(sessionId, ...args), turnAtEnd: scope.sessions.binding(sessionId)?.session.turnAtEnd,
        })
        function TurnTail({ turnAtEnd, node, renderSlot, ...props }) {
          const { data } = node
          const { closing, seq } = data
          if (!closing?.finalNode || !turnAtEnd?.(seq)) return <Native {...props} node={node} renderSlot={renderSlot} />

          // DSH 会比较最后的回复与它之后的记录。Codex 按整轮分支，包括回复之后的记录。
          const forkView = { ...node, data: { ...data, branchUnavailable: false,
            closing: { ...closing, finalNode: { ...closing.finalNode, seq } },
          } }
          function renderTailSlot(name, owner, ...args) {
            // 其他轮次尾部插件仍收到真实的回复位置。
            return renderSlot(name, name === tailContent ? { ...owner, seq: closing.finalNode.seq } : owner, ...args)
          }
          return <Native {...props} node={forkView} renderSlot={renderTailSlot} />
        }
        next.inject = injectBoundary
        next.component = TurnTail
        restore = () => {
          if (next.inject === injectBoundary) next.inject = inject
          if (next.component === TurnTail) next.component = Native
        }
      }

      const unsubscribe = scope.on('slots/changed', name => { if (name === chatNode) sync() })
      sync()
      return () => { unsubscribe(); restore?.() }
    })
  })
}
