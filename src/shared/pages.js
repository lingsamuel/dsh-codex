export function mergePages(previous, next) {
  const unique = new Map()
  for (const entry of [...previous, ...next]) {
    if (!unique.has(entry.id)) unique.set(entry.id, entry)
  }
  return [...unique.values()]
}
