import { codexConversationPrefix, nativeConversationPrefix, selectCodexBoot } from '../shared/dual-web-entry.js'
import { webModeFor, webModePath } from '../shared/web-mode.js'
import { createModeLoading, getModeBrandPieces, modeHandoffKey, modeHandoffStyles, showModeHandoff } from '../shared/web-mode-handoff.js'
import { webModeStatus } from './web-mode.mjs'

function scriptValue(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

/** 整个页面采用同一会话来源，默认入口解析后固定在本页地址。 */
export function installDualWebEntry(ctx, state) {
  ctx.inject(['webServer', 'clientModules'], scope => scope.on('webserver/index-inject', (table, peer) => {
    const codexBoot = scriptValue(selectCodexBoot(scope.clientModules.graphFor(peer.principal)))
    const status = scriptValue(webModeStatus(scope, state))
    const modes = scriptValue({
      dsh: webModeFor(state.preferences, 'dsh'),
      codex: webModeFor(state.preferences, 'codex'),
    })
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
        const modes = ${modes};
        const requested = new URL(location.href).searchParams.get('mode');
        if (status.mode !== 'recovery' && Object.hasOwn(modes, requested)) status.mode = modes[requested];
        globalThis.__DSH_CHATGPT_WEB_MODE__ = status;
        ;(${showModeHandoff.toString()})(${scriptValue(modeHandoffKey)}, status.mode,
          ${getModeBrandPieces.toString()}, ${createModeLoading.toString()});
      })();
    ` })
    table.push({ kind: 'script', placement: 'body', text: `
      (() => {
        window.addEventListener('pageswap', event => {
          if (!document.documentElement.hasAttribute('data-codex-mode-leaving')) event.viewTransition?.skipTransition();
        });
        const status = globalThis.__DSH_CHATGPT_WEB_MODE__;
        const url = new URL(location.href);
        if (status.mode === 'recovery') {
          location.replace(new URL(${JSON.stringify(webModePath.slice(1) + '?recovery')}, document.baseURI));
          return;
        }
        if (url.searchParams.get('mode') !== status.mode) {
          url.searchParams.set('mode', status.mode);
          history.replaceState(history.state, '', url);
        }
        if (status.mode !== 'codex') return;
        globalThis.__DSH_BOOT__ = ${codexBoot};
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
