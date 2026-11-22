import { createRequire } from 'node:module'

export async function createLocalAttachmentStore(dshHome) {
  const requireDsh = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const [{ Context }, { LocalAttachmentStore }] = await Promise.all([
    import(requireDsh.resolve('@deepseek-ai/cordis')),
    import(requireDsh.resolve('@deepseek-ai/dsh-attachment-local')),
  ])
  return new LocalAttachmentStore(new Context(), { dshHome })
}
