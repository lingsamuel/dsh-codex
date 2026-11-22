import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { CodexRpcError } from './app-server.mjs'

const exec = promisify(execFile)
const branchPrefixes = ['refs/heads/', 'refs/remotes/']
const draftIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function worktreeConflict(reason, message) {
  return new CodexRpcError({ code: -32600, message, data: { reason } })
}

function invalid(message) {
  return new CodexRpcError({ code: -32602, message })
}

function git(cwd, args, signal, timeout = 4_000) {
  return exec('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    signal, timeout, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
  }).then(({ stdout }) => stdout)
}

function registeredWorktrees(output) {
  const entries = []
  let tree
  // NUL 分隔的原生格式不会对换行、空格或非 ASCII 路径进行转义。
  for (const field of output.split('\0')) {
    if (field.startsWith('worktree ')) {
      tree = { path: field.slice('worktree '.length), branch: null }
      entries.push(tree)
    } else if (field.startsWith('branch ')) tree.branch = field.slice('branch '.length)
    else if (field === 'bare') tree.bare = true
    else if (field === 'prunable' || field.startsWith('prunable ')) tree.prunable = true
  }
  return entries
}

async function repository(cwd, signal) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalid('请选择绝对路径的工作目录。')
  let top
  try {
    const result = await git(cwd, ['rev-parse', '--show-toplevel'], signal)
    top = await realpath(result.slice(0, -1))
  } catch (error) {
    if (error.stderr?.includes('not a git repository') || error.code === 'ENOENT') return null
    throw invalid('无法读取此目录的 Git 工作树。')
  }
  const [worktrees, refs] = await Promise.all([
    git(top, ['worktree', 'list', '--porcelain', '-z'], signal),
    git(top, ['for-each-ref', '--format=%(refname)%00%(symref)', ...branchPrefixes], signal),
  ])
  const entries = registeredWorktrees(worktrees)
  const local = entries[0] && !entries[0].bare && !entries[0].prunable ? entries[0] : null
  const branches = refs.split('\n').filter(Boolean).flatMap(row => {
    const [ref, symbolicTarget] = row.split('\0')
    return symbolicTarget ? [] : [{ ref, label: ref.replace(/^refs\/(?:heads|remotes)\//, '') }]
  })
  const currentBranch = entries.find(entry => entry.path === top)?.branch
  const baseRef = branches.some(({ ref }) => ref === currentBranch) ? currentBranch : branches[0]?.ref ?? null
  const subdirectory = relative(top, await realpath(cwd))
  return { top, subdirectory, local, worktrees: entries.filter(tree => tree !== local && !tree.bare && !tree.prunable), branches, baseRef }
}

async function correspondingDirectory(root, subdirectory) {
  const cwd = await realpath(join(root, subdirectory)).catch(() => null)
  if (!cwd) return null
  const remainder = relative(root, cwd)
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) return null
  return (await stat(cwd).catch(() => null))?.isDirectory() ? cwd : null
}

async function projectDirectories(repo) {
  const entries = [repo.local, ...repo.worktrees]
  const [local, ...worktrees] = await Promise.all(entries.map(async entry => {
    if (!entry) return null
    const path = await correspondingDirectory(entry.path, repo.subdirectory)
    return path ? { ...entry, path } : null
  }))
  return { local, worktrees: worktrees.filter(Boolean) }
}

/** 读取 Git 登记的工作树和引用，供新会话及切换入口使用。 */
export async function readWorktreeOptions(cwd, signal) {
  const repo = await repository(cwd, signal)
  if (!repo) return null
  return { ...await projectDirectories(repo), branches: repo.branches, baseRef: repo.baseRef }
}

/** 检查提交意图后才进行 Git 操作。已有工作树必须仍属于当前仓库。 */
export function validateWorktreeSelection(selection) {
  const { kind, id, path, baseRef } = selection ?? {}
  if ((kind !== 'new' && kind !== 'existing') || typeof id !== 'string' || !draftIdPattern.test(id)) {
    throw invalid('工作树选择无效，请重新选择。')
  }
  if (kind === 'existing' && (typeof path !== 'string' || !isAbsolute(path))) throw invalid('缺少可用的工作树目录。')
  if (kind === 'new' && (typeof baseRef !== 'string' || !branchPrefixes.some(prefix => baseRef.startsWith(prefix)))) {
    throw invalid('请选择 Git 基准分支。')
  }
  return kind === 'new' ? { kind, id, baseRef } : { kind, id, path }
}

async function checkoutFilters(cwd, signal) {
  const configured = await git(cwd, ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'], signal).catch(error => {
    if (error.code === 1 && !error.stderr) return ''
    throw error
  })
  // Git 的临时配置与 DSH WorktreeService 一致，检出期间不运行仓库定义的过滤器。
  const drivers = new Set(configured.split('\0').flatMap(key => {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/.exec(key)
    return match ? [match[1]] : []
  }))
  return [...drivers].flatMap(driver => ['clean=', 'smudge=', 'process=', 'required=false']
    .flatMap(value => ['-c', `filter.${driver}.${value}`]))
}

export async function resolveWorktreeCwd(cwd, selection, signal) {
  const repo = await repository(cwd, signal)
  if (!repo) throw invalid('当前目录没有可用的 Git 工作树。')
  const { top, subdirectory, local, worktrees, branches } = repo
  if (selection.kind === 'existing') {
    const target = (await projectDirectories(repo)).worktrees.find(tree => tree.path === selection.path)
    if (!target) throw invalid('所选工作树已不可用。')
    return target.path
  }
  // 以同一提交标识派生目录。原生会话启动失败后，重试可复用已完成的 Git 检出。
  const primary = local?.path ?? top
  const path = join(dirname(primary), `${basename(primary)}-worktree-${selection.id}`)
  if (!worktrees.some(tree => tree.path === path)) {
    if (!branches.some(({ ref }) => ref === selection.baseRef)) throw invalid('基准分支已不可用，请重新选择。')
    // 项目可以登记在检出的子目录。基准树须能提供同一个目录，才创建检出。
    if (subdirectory) {
      const type = await git(top, ['cat-file', '-t', `${selection.baseRef}:${subdirectory}`], signal).catch(() => '')
      if (type !== 'tree\n') throw invalid('所选基准分支缺少此项目的子目录。')
    }
    try {
      const filters = await checkoutFilters(top, signal)
      await git(top, [...filters, 'worktree', 'add', '--detach', '--', path, selection.baseRef], signal, 15_000)
    } catch (error) {
      throw invalid(`无法创建 Git 工作树。${error.stderr?.trim() ? ` ${error.stderr.trim()}` : ''}`)
    }
  }
  const target = await correspondingDirectory(path, subdirectory)
  if (!target) throw invalid('所选工作树缺少此项目的子目录。')
  return target
}

/** 按当前会话所在仓库的 Git 登记重新核对目标路径。 */
export async function requireWorktreeDestination(source, destination, signal) {
  const repo = await repository(source, signal)
  const path = await realpath(destination).catch(() => null)
  const { local, worktrees } = repo ? await projectDirectories(repo) : { local: null, worktrees: [] }
  if (!path || ![local, ...worktrees].some(tree => tree?.path === path)) {
    throw invalid('请选择当前仓库登记的本地目录或工作树。')
  }
  return path
}
