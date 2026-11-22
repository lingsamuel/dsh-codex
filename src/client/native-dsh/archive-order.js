import { cloneElement, createElement, isValidElement, useRef } from 'react'

const lists = new WeakMap()
const rows = new WeakMap()

function adaptChildren(node, adapt) {
  if (Array.isArray(node)) {
    const children = node.map(child => adaptChildren(child, adapt))
    return children.some((child, index) => child !== node[index]) ? children : node
  }
  if (!isValidElement(node)) return node
  const replacement = adapt(node)
  if (replacement !== node) return replacement
  const children = adaptChildren(node.props.children, adapt)
  return children === node.props.children ? node : cloneElement(node, {}, children)
}

function adaptRow(element, pins, archiveDrag) {
  const { type: Native, props } = element
  if (typeof Native !== 'function' || !props.node || (!props.node.archived && pins.size === 0)
    || typeof props.drag?.start !== 'function' || typeof props.useSessionAccess !== 'function') return element
  if (!rows.has(Native)) {
    rows.set(Native, function ArchiveOrderRow(props) {
      const { drag, node, useSessionAccess, archivePin, archiveDrag } = props
      const card = Native(props)
      const reorderable = useSessionAccess(node.id, 'workspace/insertSessionBefore')
      const anchor = card?.props?.anchor
      if (!isValidElement(anchor)) return card
      const native = anchor.props
      const archivedDraggable = node.archived && !node.blank && reorderable && !native.draggable
      function allowTarget(event) {
        const current = archiveDrag.current
        if (!current || !drag.active) return true
        current.blocked = current.pinned !== archivePin
        if (!current.blocked) return true
        event.dataTransfer.dropEffect = 'none'
        event.stopPropagation()
        return false
      }
      return cloneElement(card, { anchor: cloneElement(anchor, {
        draggable: native.draggable || archivedDraggable,
        onDragStart(event) {
          if (reorderable && (native.draggable || archivedDraggable)) {
            archiveDrag.current = { pinned: archivePin, blocked: false }
          }
          if (!archivedDraggable) return native.onDragStart?.(event)
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', node.id)
          drag.start()
        },
        onDragOver(event) {
          if (allowTarget(event)) native.onDragOver?.(event)
        },
        onDrop(event) {
          if (allowTarget(event)) native.onDrop?.(event)
        },
        onDragEnd(event) {
          if (archivedDraggable) drag.end()
          else native.onDragEnd?.(event)
          archiveDrag.current = null
        },
      }) })
    })
  }
  return createElement(rows.get(Native), { ...props, key: element.key, archivePin: pins.has(props.node.id), archiveDrag })
}

function moveArchivePinsFirst(ids, pins) {
  const promoted = ids.filter(id => pins.has(id))
  return promoted.length ? [...promoted, ...ids.filter(id => !pins.has(id))] : ids
}

/** 复用 DSH 会话树的拖动状态、落点校验和视图顺序持久化。 */
export function renderArchiveOrder(tree) {
  return adaptChildren(tree, element => {
    const { type: Native, props } = element
    if (typeof Native !== 'function' || !props.rowState?.archivedSessionIds?.length
      || typeof props.setSessionOrder !== 'function' || typeof props.renderSlot !== 'function') return element
    if (!lists.has(Native)) {
      lists.set(Native, function ArchivedSessionList(props) {
        const archiveDrag = useRef(null)
        const archived = new Set(props.rowState.archivedSessionIds)
        const pins = new Set(props.rowState.pinnedSessionIds.filter(id => archived.has(id)))
        // DSH 会把未归档置顶放在最前。将归档置顶放在剩余组开头，保留原归档标记。
        const promote = ids => moveArchivePinsFirst(ids, pins)
        const list = pins.size === 0 ? props : {
          ...props,
          // DSH 的 dragEnd 可能提交上一次有效落点。跨组拒绝后也要停住原生写入。
          setSessionOrder(account, order) {
            if (!archiveDrag.current?.blocked) props.setSessionOrder(account, order)
          },
          ...(props.sessionIds && { sessionIds: promote(props.sessionIds) }),
          ...(props.ungroupedSessionIds && { ungroupedSessionIds: promote(props.ungroupedSessionIds) }),
          ...(props.workspaces && { workspaces: props.workspaces.map(workspace => ({
            ...workspace, sessionIds: promote(workspace.sessionIds),
          })) }),
        }
        return adaptChildren(Native(list), element => adaptRow(element, pins, archiveDrag))
      })
    }
    return createElement(lists.get(Native), { ...props, key: element.key })
  })
}
