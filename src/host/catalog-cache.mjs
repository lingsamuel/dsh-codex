import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

export function catalogCachePath(directory, endpoint) {
  const source = [process.platform, hostname(), process.env.WSL_DISTRO_NAME, endpoint]
  const key = createHash('sha256').update(JSON.stringify(source)).digest('hex')
  return join(directory, `catalog-${key}.json`)
}

export async function readCatalogCache(path) {
  try {
    const cached = JSON.parse(await readFile(path, 'utf8'))
    if (Array.isArray(cached.projects) && Array.isArray(cached.threads)
      && cached.workspacePaths && typeof cached.workspacePaths === 'object') {
      return { ...cached, complete: true }
    }
  } catch {
    // 缓存缺失或损坏时，正常走 Codex 清单读取。
  }
  return null
}

/** 保存原生列表字段和 Codex 提供的预览，实时状态和各轮完整消息按需读取。 */
export async function saveCatalogCache(path, { projects, threads, workspacePaths }, signal) {
  const projection = {
    projects: projects.map(({ id, name, roots, createdAt, updatedAt, recencyAt }) => ({
      id, name, roots, createdAt, updatedAt, recencyAt,
    })),
    threads: threads.map(({ id, name, preview, cwd, projectId, createdAt, updatedAt }) => ({
      id, name, preview, cwd, projectId, createdAt, updatedAt,
    })),
    workspacePaths,
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, JSON.stringify(projection), { mode: 0o600 })
    signal?.throwIfAborted()
    await rename(temporary, path)
  } catch {
    // 缓存写入失败不会使可用的 Codex 列表读取失败。
    await rm(temporary, { force: true }).catch(() => {})
  }
}
