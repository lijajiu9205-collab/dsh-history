// dsh-wenyan · 浏览器半身（client half）
//
// 在对话输入框上方的 dock 位放一个「文言文」开关。
// 每个对话的开关相互独立：sessionId 由插槽的 inject 回调按会话注入，
// 组件据此向宿主查询/写入该会话的开关值。
//
// 写法约束（照现有插件的先例）：
//   - 本文件是一个「普通副作用脚本」：顶层不能有 ESM import/export，
//     加载时调用 window.__ModuleLoader__.load(...)；
//   - React 由宿主模块表提供，故在 factory 里 require("react")；
//   - slot 组件必须返回 React 元素，宿主的渲染器才会认它，
//     因此这里用 React.createElement（无 JSX，也就无需构建步骤）。
//
// 开关本身只做一件事：把状态 POST 给宿主的 /dsh-wenyan-4287/toggle。
// 真正约束回答体例的文字在宿主半身的系统提示词里。

;(function () {
  "use strict";

  var ROUTE_PREFIX = "/dsh-wenyan-4287";
  var SLOT_KEY = "conversation.input.dock";
  var ENTRY_ID = "wenyan-toggle";
  var STYLE_ID = "dsh-wenyan-style-4287";
  var STORAGE_KEY = "dsh-wenyan:enabled";

  /** 某会话的本地缓存键；无会话上下文时退回全局键。 */
  function storageKey(sessionId) {
    return sessionId ? STORAGE_KEY + ":" + sessionId : STORAGE_KEY;
  }

  /**
   * 违禁内容提醒词表。
   *
   * 它只负责「提醒」：真正的闸门是宿主侧送进系统提示词的那段文字。
   * 词表刻意保守——命中即提示，不命中不代表允许。
   */
  var PROHIBITED = [
    /\b(fuck|fucked|shit|bitch|slut|whore|nigger|faggot|kike)\b/i,
    /(操你|肏你|傻逼|妈逼|他妈的|王八蛋|贱人|狗屎|去死吧|死全家|脑子有病)/,
    /(自慰|手淫|口交|肛交|强奸|轮奸|乱伦|恋童|色情片|成人片|卖淫|嫖娼)/,
    /(反华|台独|港独|疆独|藏独|颠覆|推翻政权|弑君|谋逆)/,
    /(批评|评价|评议|怎么看|观点|优劣).{0,10}(领导人|政党|政府|体制|政体|国家)/
  ];

  var CSS = `
.dsh-wenyan-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: none;
  font-family: var(--dsw-font-family, inherit);
  font-size: 12px;
}
.dsh-wenyan-hint {
  color: var(--dsw-alias-state-warning-primary, #c2410c);
  font-size: 11px;
  line-height: 1.35;
  max-width: 52ch;
  text-align: right;
}
.dsh-wenyan-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l, rgba(128, 128, 128, 0.28));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #8e8e8e);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.dsh-wenyan-switch:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-primary, #1a1a1a);
}
.dsh-wenyan-switch:disabled {
  opacity: 0.5;
  cursor: progress;
}
.dsh-wenyan-switch--on {
  border-color: var(--dsw-alias-state-business-primary, #4f46e5);
  color: var(--dsw-alias-state-business-primary, #4f46e5);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4f46e5) 8%, transparent);
  font-weight: 600;
}
.dsh-wenyan-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.55;
}
.dsh-wenyan-switch--on .dsh-wenyan-dot {
  opacity: 1;
}
`;

  function injectStyles() {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.dataset.plugin = "dsh-wenyan";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function readCachedEnabled(sessionId) {
    try {
      return localStorage.getItem(storageKey(sessionId)) === "1";
    } catch (e) {
      return false;
    }
  }

  function writeCachedEnabled(value, sessionId) {
    try {
      localStorage.setItem(storageKey(sessionId), value ? "1" : "0");
    } catch (e) {
      /* 隐私模式下写不进 localStorage：缓存只是装饰，忽略即可 */
    }
  }

  /** 读宿主当前状态；拿不到返回 null（保留本地缓存的外观）。 */
  async function fetchState(sessionId) {
    try {
      var url = ROUTE_PREFIX + "/state";
      if (sessionId) url += "?sessionId=" + encodeURIComponent(sessionId);
      var res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return null;
      var raw = await res.json().catch(function () {
        return null;
      });
      return raw && typeof raw.enabled === "boolean" ? raw.enabled : null;
    } catch (e) {
      return null;
    }
  }

  /** 把开关拨到指定值，回读宿主的确认结果。 */
  async function sendToggle(value, sessionId) {
    var body = { enabled: value };
    if (sessionId) body.sessionId = sessionId;
    var res = await fetch(ROUTE_PREFIX + "/toggle", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    var raw = await res.json().catch(function () {
      return {};
    });
    if (raw && raw.ok === false) throw new Error(String(raw.error ?? "toggle failed"));
    return Boolean(raw && raw.enabled === true);
  }

  function matchProhibited(text) {
    if (!text) return false;
    for (var i = 0; i < PROHIBITED.length; i++) {
      if (PROHIBITED[i].test(text)) return true;
    }
    return false;
  }

  /**
   * 取用户正在输入的文本：输入框可能是 textarea / input，也可能是 contenteditable。
   */
  function editableText(target) {
    if (!target || typeof target !== "object") return "";
    if (typeof target.value === "string") return target.value;
    if (typeof target.textContent === "string") return target.textContent;
    return "";
  }

  function isEditableTarget(target) {
    if (!target || typeof target !== "object") return false;
    var tag = String(target.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "INPUT") return true;
    return typeof target.getAttribute === "function" && target.getAttribute("contenteditable") === "true";
  }

  function makeFactory() {
    return function (require) {
      var module = { exports: {} };
      Object.defineProperty(module.exports, Symbol.toStringTag, { value: "Module" });

      var react;
      try {
        react = require("react");
      } catch (e) {
        console.warn("[dsh-wenyan] react 不可用，开关无法挂载：" + (e instanceof Error ? e.message : String(e)));
        module.exports = {
          name: "wenyan",
          inject: [],
          apply: function () {}
        };
        return module.exports;
      }
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useRef = react.useRef;
      var useCallback = react.useCallback;
      var createElement = react.createElement;

      var HINT_DEFAULT = "文言文模式不宜讨论此类内容，模型将婉拒作答。";

      /**
       * 提示条有两种：prohibit（违禁词提醒，文字删掉即撤回）与
       * error（切换失败的报错，只按时效撤回）。
       */

      /** 输入框上方的开关。props.sessionId 由插槽按会话注入。 */
      function WenyanToggle(props) {
        var sessionId =
          props && typeof props.sessionId === "string" && props.sessionId ? props.sessionId : "";

        var enabledState = useState(function () {
          return readCachedEnabled(sessionId);
        });
        var enabled = enabledState[0];
        var setEnabled = enabledState[1];
        var hintState = useState(null);
        var hint = hintState[0];
        var setHint = hintState[1];
        var busyState = useState(false);
        var busy = busyState[0];
        var setBusy = busyState[1];

        var hintTimer = useRef(null);
        var mounted = useRef(true);

        var clearHint = useCallback(function () {
          if (hintTimer.current !== null) {
            clearTimeout(hintTimer.current);
            hintTimer.current = null;
          }
          setHint(null);
        }, []);

        var showHint = useCallback(function (kind, text, ttl) {
          setHint({ kind: kind, text: text });
          if (hintTimer.current !== null) clearTimeout(hintTimer.current);
          hintTimer.current = setTimeout(function () {
            hintTimer.current = null;
            if (mounted.current) setHint(null);
          }, ttl);
        }, []);

        /** 只在当前提示是违禁提醒时撤回（不吞掉切换失败的报错）。 */
        var dropProhibitHint = useCallback(function () {
          setHint(function (current) {
            if (!current || current.kind !== "prohibit") return current;
            return null;
          });
        }, []);

        // 开机对齐宿主状态：宿主的提示词段落才是唯一真源（按会话查）。
        useEffect(
          function () {
            var cancelled = false;
            fetchState(sessionId).then(function (server) {
              if (cancelled || server === null) return;
              setEnabled(server);
              writeCachedEnabled(server, sessionId);
            });
            return function () {
              cancelled = true;
            };
          },
          [setEnabled, sessionId]
        );

        // 灵敏度：宿主状态才是真源。三路对齐——定时轮询、回到页面、跨标签 storage 事件。
        useEffect(
          function () {
            var disposed = false;
            var applyServer = function (server) {
              if (disposed || server === null) return;
              setEnabled(server);
              writeCachedEnabled(server, sessionId);
            };
            var refresh = function () {
              fetchState(sessionId).then(applyServer);
            };

            var override = typeof window !== "undefined" ? window.__DSH_WENYAN_POLL_MS__ : undefined;
            var pollMs = typeof override === "number" ? override : 8000;
            var timer = pollMs > 0 ? setInterval(refresh, pollMs) : null;

            var onFocus = function () {
              refresh();
            };
            var onVisibility = function () {
              if (!document.visibilityState || document.visibilityState !== "hidden") refresh();
            };
            var ownKey = storageKey(sessionId);
            var onStorage = function (event) {
              if (event.key !== ownKey) return;
              setEnabled(event.newValue === "1");
            };

            window.addEventListener("focus", onFocus);
            document.addEventListener("visibilitychange", onVisibility);
            window.addEventListener("storage", onStorage);

            return function () {
              disposed = true;
              if (timer !== null) clearInterval(timer);
              window.removeEventListener("focus", onFocus);
              document.removeEventListener("visibilitychange", onVisibility);
              window.removeEventListener("storage", onStorage);
            };
          },
          [setEnabled, sessionId]
        );

        // 输入内容命中违禁词时提示一句（只提示，不拦截、不上报）；
        // 文字里不再含违禁词则撤回提示。
        useEffect(
          function () {
            if (!enabled) return undefined;
            var onInput = function (event) {
              var target = event.target;
              if (!isEditableTarget(target)) return;
              if (matchProhibited(editableText(target))) {
                showHint("prohibit", HINT_DEFAULT, 5000);
              } else {
                dropProhibitHint();
              }
            };
            document.addEventListener("input", onInput, true);
            return function () {
              document.removeEventListener("input", onInput, true);
            };
          },
          [enabled, showHint, dropProhibitHint]
        );

        // 卸载时收掉悬着的计时器，避免给已卸载组件派 setState。
        useEffect(
          function () {
            mounted.current = true;
            return function () {
              mounted.current = false;
              if (hintTimer.current !== null) clearTimeout(hintTimer.current);
            };
          },
          []
        );

        // 关掉模式即撤回提示：提示只在文言模式下有意义。
        useEffect(
          function () {
            if (!enabled) clearHint();
          },
          [enabled, clearHint]
        );

        var onToggle = useCallback(
          function () {
            if (busy) return;
            // 点击语义 = 把「我看到的状态」取反后绝对下发：两个窗口各点一下也不会错位，
            // 服务端对同一目标值幂等。先即时翻转外观，失败再回滚。
            var target = !enabled;
            setEnabled(target);
            writeCachedEnabled(target, sessionId);
            setBusy(true);

            sendToggle(target, sessionId)
              .then(function (confirmed) {
                if (!mounted.current) return;
                setEnabled(confirmed);
                writeCachedEnabled(confirmed, sessionId);
              })
              .catch(function (error) {
                if (!mounted.current) return;
                // 失败回滚外观，别让按钮撒谎。
                setEnabled(enabled);
                writeCachedEnabled(enabled, sessionId);
                showHint("error", "切换失败：" + (error instanceof Error ? error.message : String(error)), 6000);
              })
              .then(function () {
                if (mounted.current) setBusy(false);
              });
          },
          [busy, enabled, sessionId, setBusy, setEnabled, showHint]
        );

        return createElement(
          "div",
          { className: "dsh-wenyan-row" },
          hint ? createElement("span", { className: "dsh-wenyan-hint", role: "status" }, hint.text) : null,
          createElement(
            "button",
            {
              type: "button",
              className: "dsh-wenyan-switch" + (enabled ? " dsh-wenyan-switch--on" : ""),
              "aria-pressed": enabled ? "true" : "false",
              disabled: busy,
              title: "开启后化身蓝色古风大肥鱼（惯吃白饭），应答上文下注：上文言，下白话译；辱骂、淫秽、涉政评议、侮辱人伦诸类不予作答。仅影响当前对话。",
              onClick: onToggle
            },
            createElement("span", { className: "dsh-wenyan-dot", "aria-hidden": "true" }),
            enabled ? "文言文 · 已开" : "文言文"
          )
        );
      }

      var name = "wenyan";
      var inject = ["slots"];

      function apply(ctx) {
        injectStyles();
        ctx.slots.inject(SLOT_KEY, function () {
          return ctx.slots.register(
            {
              name: SLOT_KEY,
              id: ENTRY_ID,
              order: 0,
              // 插槽按会话注入 sessionId 作为 props，开关据此读写当前对话的状态。
              inject: function (sessionId) {
                return { sessionId: sessionId };
              }
            },
            WenyanToggle
          );
        });
      }

      module.exports = { apply: apply, inject: inject, name: name };
      return module.exports;
    };
  }

  window.__ModuleLoader__.load({ id: "dsh-wenyan", factory: makeFactory() });
})();