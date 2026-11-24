import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 复用 Profile 默认设置的串行写入与原子替换，读取时等待当前写入完成。 */
export function createDefaultPreference(path, field) {
  let preference = null
  let writes = Promise.resolve()
  async function read() {
    if (!path) return preference
    const saved = await readFile(path, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    return saved == null ? null : JSON.parse(saved)[field] ?? null
  }
  function writeValue(resolve) {
    const write = writes.then(async () => {
      const value = await resolve()
      if (path) {
        const temporary = `${path}.${randomUUID()}.tmp`
        try {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(temporary, JSON.stringify({ [field]: value }), { mode: 0o600 })
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      preference = value
      return value
    })
    writes = write.catch(() => {})
    return write
  }
  return {
    async get() {
      await writes
      return read()
    },
    async set(value) {
      await writeValue(() => value)
    },
    update(change) {
      return writeValue(async () => change(await read()))
    },
  }
}
