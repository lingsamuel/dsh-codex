import pkg from '../../package.json' with { type: 'json' }
import { codexClientReloadEvent, codexConversationPrefix, conflictingClientPackages, installCodexGraphSync,
  nativeConversationPrefix, selectCodexBoot } from '../shared/dual-web-entry.js'
import { webModeFor } from '../shared/web-mode.js'
import { createModeLoading, getModeBrandPieces, modeHandoffKey, modeHandoffStyles, showModeHandoff } from '../shared/web-mode-handoff.js'
import { webModeStatus } from './web-mode.mjs'

function scriptValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/** 整个页面采用同一会话来源，默认入口解析后固定在本页地址。 */
export function installDualWebEntry(ctx, state) {
  ctx.inject(['webServer', 'clientModules'], scope => scope.on('webserver/index-inject', (table, peer) => {
    const codexBoot = scriptValue(selectCodexBoot(scope.clientModules.graphFor(peer.principal)))
    const status = scriptValue(webModeStatus(state))
    // 交接画面要先于 DSH 的 head 同步启动脚本，避免脚本尚未到达时露出空白页。
    table.unshift({ kind: 'style', text: `
      ${modeHandoffStyles}
      @media (prefers-reduced-motion: no-preference) {
        @view-transition { navigation: auto; }
        ::view-transition-old(root), ::view-transition-new(root) { animation-duration: 220ms; }
      }
    ` }, { kind: 'script', placement: 'head', text: `
      (() => {
        const status = ${status};
        if (status.coexist && !status.exclusive) {
          const requested = new URL(location.href).searchParams.get('mode');
          status.mode = (${webModeFor.toString()})(status, requested);
        }
        globalThis.__DSH_CODEX_WEB_MODE__ = status;
        ;(${showModeHandoff.toString()})(${scriptValue(modeHandoffKey)}, status.mode,
          ${getModeBrandPieces.toString()}, ${createModeLoading.toString()});
      })();
    ` })
    table.push({ kind: 'script', placement: 'body', text: `
      (() => {
        window.addEventListener('pageswap', event => {
          if (!document.documentElement.hasAttribute('data-codex-mode-leaving')) event.viewTransition?.skipTransition();
        });
        const status = globalThis.__DSH_CODEX_WEB_MODE__;
        const url = new URL(location.href);
        if (status.exclusive || url.searchParams.get('mode') !== status.mode) {
          url.searchParams.set('mode', status.mode);
          if (url.href !== location.href) history.replaceState(history.state, '', url);
        }
        if (status.mode !== 'codex') return;
        const boot = globalThis.__DSH_BOOT__ = ${codexBoot};
        const excluded = new Set(${scriptValue([...conflictingClientPackages])});
        ;(${installCodexGraphSync.toString()})(globalThis.__ModuleLoader__, boot, ${scriptValue(pkg.name)},
          graph => (${selectCodexBoot.toString()})(graph, excluded), () => {
            status.reloadRequired = true;
            window.dispatchEvent(new Event(${scriptValue(codexClientReloadEvent)}));
          });
        try {
          const local = window.localStorage;
          for (const method of ['getItem', 'setItem', 'removeItem']) {
            const original = Storage.prototype[method];
            Storage.prototype[method] = function (key, ...args) {
              if (this === local && typeof key === 'string') {
                const prefix = ${scriptValue(nativeConversationPrefix)};
                if (key.startsWith(prefix)) key = ${scriptValue(codexConversationPrefix)} + key.slice(prefix.length);
                else if (key === 'dsh.sessions.current') key = 'dsh.codex.sessions.current';
              }
              return original.call(this, key, ...args);
            };
          }
        } catch {}
      })();
    ` })
  }))
}
