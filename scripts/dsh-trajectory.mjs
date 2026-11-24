import { patchedDshSource } from './patched-dsh-source.mjs'

export function dshTrajectorySource() {
  return patchedDshSource('@deepseek-ai/dsh-client-ui-trajectory', './dsh-trajectory.patch')
}
