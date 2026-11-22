import { directoryTitle } from './api.js'

export function threadTitle(thread) {
  return thread.name || thread.preview || thread.id
}

/** 生成供两套工作区视图消费的同一目录投影，保留原生线程对象。 */
export function groupThreads(threads, projects, workspacePaths = {}) {
  const groups = new Map(projects.map(project => {
    const roots = project.roots.map(root => workspacePaths[root.path] ?? root.path)
    return [`project:${project.id}`, {
      name: project.name,
      location: roots.join(' · '),
      roots,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      threads: [],
    }]
  }))

  for (const thread of threads) {
    const project = groups.get(`project:${thread.projectId}`)
    if (project) {
      project.threads.push(thread)
      continue
    }
    const directory = workspacePaths[thread.cwd] ?? thread.cwd
    const key = `directory:${directory ?? ''}`
    if (!groups.has(key)) {
      const name = directory ? directoryTitle(directory) : '未指定工作目录'
      groups.set(key, { name, location: directory || name, roots: directory ? [directory] : [], threads: [] })
    }
    groups.get(key).threads.push(thread)
  }
  return [...groups.entries()]
}
