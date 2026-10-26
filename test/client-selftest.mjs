// dsh-wenyan 浏览器半身仿真自检。
//
// 不依赖浏览器：造一个 vm 沙箱，喂进 window.__ModuleLoader__、document、
// localStorage、fetch 替身，再用一个迷你 React hooks 运行时把开关组件
// 真的渲染出来，验证：
//   1. 模块经 __ModuleLoader__ 注册，exports 形状正确（apply/inject/name）；
//   2. apply 把组件注册进 conversation.input.dock，并按会话注入 sessionId；
//   3. 组件挂载即向 /state 对齐该会话的状态；
//   4. 点击按钮 POST /toggle（带 sessionId）并按回读结果换外观；
//   5. 两个会话的状态互相独立；
//   6. 违禁词输入弹出提示；关闭模式后提示撤回；
//   7. 样式只注入一次。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(base, "lib/client.js"), "utf8");

const failures = [];
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) failures.push(msg);
};

// ---------------------------------------------------------------- 迷你 React
function makeReact() {
  const current = {
    index: 0,
    slots: [],
    effectSlots: [],
    pendingEffects: [],
    dirty: false,
    onDirty: null
  };
  const React = {};

  React.createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
  });

  const depsChanged = (prev, next) => {
    if (!prev || !next) return true;
    if (prev.length !== next.length) return true;
    return next.some((v, i) => !Object.is(v, prev[i]));
  };

  React.useState = (initial) => {
    const i = current.index++;
    if (!current.slots[i]) {
      const slot = { value: typeof initial === "function" ? initial() : initial };
      slot.set = (next) => {
        const v = typeof next === "function" ? next(slot.value) : next;
        if (Object.is(v, slot.value)) return;
        slot.value = v;
        if (current.onDirty) current.onDirty();
      };
      current.slots[i] = slot;
    }
    const slot = current.slots[i];
    return [slot.value, slot.set];
  };

  React.useRef = (initial) => {
    const i = current.index++;
    if (!current.slots[i]) current.slots[i] = { current: initial };
    return current.slots[i];
  };

  React.useCallback = (fn, deps) => {
    const i = current.index++;
    const slot = current.slots[i];
    if (!slot || depsChanged(slot.deps, deps)) {
      current.slots[i] = { fn, deps };
      return fn;
    }
    return slot.fn;
  };

  React.useEffect = (fn, deps) => {
    const i = current.index++;
    current.pendingEffects.push({ index: i, fn, deps });
  };

  function commitEffects() {
    for (const eff of current.pendingEffects) {
      if (!current.effectSlots[eff.index]) {
        current.effectSlots[eff.index] = { cleanup: null, deps: null, ran: false };
      }
      const slot = current.effectSlots[eff.index];
      const run = !slot.ran || eff.deps === undefined || depsChanged(slot.deps, eff.deps);
      if (run) {
        if (typeof slot.cleanup === "function") {
          try {
            slot.cleanup();
          } catch (e) {
            failures.push("effect cleanup threw: " + e.message);
          }
        }
        const ret = eff.fn();
        slot.cleanup = typeof ret === "function" ? ret : null;
        slot.deps = eff.deps ?? null;
        slot.ran = true;
      }
    }
    current.pendingEffects = [];
  }

  const runtime = {
    render(Component, props) {
      current.index = 0;
      current.pendingEffects = [];
      const element = Component(props ?? {});
      commitEffects();
      return element;
    },
    /** 模拟组件卸载后重新挂载：清空 hook 槽位与 effect 记录。 */
    remount(Component, props) {
      current.index = 0;
      current.slots = [];
      current.effectSlots = [];
      current.pendingEffects = [];
      const element = Component(props ?? {});
      commitEffects();
      return element;
    },
    markClean() {
      current.dirty = false;
    },
    isDirty() {
      return current.dirty;
    },
    attach() {
      current.onDirty = () => {
        current.dirty = true;
      };
    }
  };
  return { React, runtime };
}

const { React, runtime } = makeReact();

// ------------------------------------------------------------------ DOM 替身
const styleTags = [];
const listeners = [];
const fakeDocument = {
  visibilityState: "visible",
  getElementById: () => null,
  createElement: (tag) => ({ tag, id: "", dataset: {}, textContent: "", className: "" }),
  head: { appendChild: (el) => styleTags.push(el) },
  addEventListener: (type, fn) => listeners.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) listeners.splice(i, 1);
  },
  dispatch: (type, target) => {
    for (const l of [...listeners]) if (l.type === type) l.fn({ target });
  }
};

const storage = new Map();
const fakeLocalStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k)
};

// ------------------------------------------------------------- 宿主路由替身
// 按会话记开关：键为 sessionId，空串表示全局默认。
const serverState = new Map();
let globalServer = false;
const enabledFor = (sid) => (serverState.has(sid) ? serverState.get(sid) : globalServer);
const httpLog = [];
const json = (data) => ({ ok: true, status: 200, json: async () => data });

async function fakeFetch(url, opts = {}) {
  const method = opts.method ?? "GET";
  httpLog.push({ url, method, body: opts.body });
  const parsedUrl = new URL(url, "http://127.0.0.1");
  const sid = parsedUrl.searchParams.get("sessionId") || "";
  if (parsedUrl.pathname === "/dsh-wenyan-4287/state" && method === "GET") {
    return json({ enabled: enabledFor(sid) });
  }
  if (parsedUrl.pathname === "/dsh-wenyan-4287/toggle" && method === "POST") {
    let parsed = {};
    try {
      parsed = JSON.parse(opts.body || "{}");
    } catch (e) {
      /* 坏报文按翻转处理，与宿主一致 */
    }
    const bodySid = typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    const next = typeof parsed.enabled === "boolean" ? parsed.enabled : !enabledFor(bodySid);
    if (bodySid) serverState.set(bodySid, next);
    else globalServer = next;
    return json({ ok: true, enabled: next });
  }
  return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
}

// -------------------------------------------------------------------- 沙箱
const loaded = [];
const winListeners = [];
const fakeWindow = {
  __ModuleLoader__: { load: (info) => loaded.push(info) },
  // 测试里关掉轮询，免得 setInterval 吊住进程；同步逻辑另测。
  __DSH_WENYAN_POLL_MS__: 0,
  addEventListener: (type, fn) => winListeners.push({ type, fn }),
  removeEventListener: (type, fn) => {
    const i = winListeners.findIndex((l) => l.type === type && l.fn === fn);
    if (i >= 0) winListeners.splice(i, 1);
  },
  _dispatch: (type, event) => {
    for (const l of [...winListeners]) if (l.type === type) l.fn(event);
  }
};

const sandbox = {
  window: fakeWindow,
  document: fakeDocument,
  localStorage: fakeLocalStorage,
  fetch: fakeFetch,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  queueMicrotask,
  URL,
  TextEncoder,
  Buffer
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: "lib/client.js" });

// ---- 1. 模块注册 ----
ok(loaded.length === 1, "client registers exactly one module via __ModuleLoader__");
ok(loaded[0] && loaded[0].id === "dsh-wenyan", "module id is dsh-wenyan");
ok(loaded[0] && typeof loaded[0].factory === "function", "factory is a function");

const require = (name) => {
  if (name === "react") return React;
  throw new Error("unexpected require: " + name);
};
const mod = loaded[0].factory(require);

ok(mod && mod.name === "wenyan", "exports name is 'wenyan'");
ok(Array.isArray(mod.inject) && mod.inject.includes("slots"), "client injects the slots service");
ok(typeof mod.apply === "function", "client exports apply");

// ---- 2. apply 注册 slot ----
const registrations = [];
const ctx = {
  slots: {
    inject: (key, fn) => {
      registrations.push({ via: "inject", key });
      fn();
    },
    register: (options, component) => {
      registrations.push({ via: "register", options, component });
      return () => {};
    }
  }
};
mod.apply(ctx);

ok(registrations.some((r) => r.via === "inject" && r.key === "conversation.input.dock"), "injects the conversation.input.dock slot");
const reg = registrations.find((r) => r.via === "register");
ok(!!reg, "registers an entry in the slot");
ok(reg && reg.options.name === "conversation.input.dock", "entry bound to the dock slot");
ok(reg && reg.options.id === "wenyan-toggle", "entry id is wenyan-toggle");
ok(reg && typeof reg.options.inject === "function", "entry declares a per-conversation inject");
ok(reg && reg.options.inject("s-a").sessionId === "s-a", "inject passes the conversation id as a prop");
ok(reg && typeof reg.component === "function", "entry provides a component");
ok(styleTags.length === 1 && styleTags[0].id === "dsh-wenyan-style-4287", "styles injected once");

// ---- 3. 初次渲染：向宿主 /state 对齐 ----
const SS_A = "s-a";
const SS_B = "s-b";
runtime.attach();
const settle = async () => {
  for (let pass = 0; pass < 25; pass++) {
    runtime.markClean();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    if (!runtime.isDirty()) break;
    element = runtime.render(reg.component, { sessionId: SS_A });
  }
};
let element = runtime.render(reg.component, { sessionId: SS_A });
await settle();

ok(
  httpLog.some((h) => h.url.includes("/dsh-wenyan-4287/state") && h.url.includes("sessionId=" + SS_A)),
  "mount queries the host bridge state for this conversation"
);

const findButton = (el) => {
  if (!el || typeof el !== "object") return null;
  if (el.type === "button") return el;
  for (const c of el.children || []) {
    const hit = findButton(c);
    if (hit) return hit;
  }
  return null;
};
const findHint = (el) => {
  if (!el || typeof el !== "object") return null;
  if (String(el.props?.className || "").includes("dsh-wenyan-hint")) return el;
  for (const c of el.children || []) {
    const hit = findHint(c);
    if (hit) return hit;
  }
  return null;
};

let button = findButton(element);
ok(!!button, "the switch button renders");
ok(button && button.props["aria-pressed"] === "false", "renders off when the host says off");
ok(!findHint(element), "no hint on a clean render");

// 服务端把本会话切到 on：重新挂载的组件应向宿主对齐。
serverState.set(SS_A, true);
element = runtime.remount(reg.component, { sessionId: SS_A });
await settle();
button = findButton(element);
ok(button && button.props["aria-pressed"] === "true", "component aligns to the host's on-state");
ok(String(button?.props.className || "").includes("dsh-wenyan-switch--on"), "on-state carries the active class");

// ---- 3b. 两个会话互相独立 ----
element = runtime.remount(reg.component, { sessionId: SS_B });
await settle();
button = findButton(element);
ok(button && button.props["aria-pressed"] === "false", "a different conversation renders its own off-state");

// ---- 4. 点击：POST /toggle（带 sessionId）并以回读结果更新 ----
httpLog.length = 0;
serverState.set(SS_A, false);
element = runtime.remount(reg.component, { sessionId: SS_A });
await settle();
button = findButton(element);
ok(button && button.props["aria-pressed"] === "false", "remount follows the host back to off");
button.props.onClick();
await settle();
ok(httpLog.some((h) => h.url.includes("/dsh-wenyan-4287/toggle") && h.method === "POST"), "click posts the toggle");
ok(
  httpLog.some((h) => h.body === JSON.stringify({ enabled: true, sessionId: SS_A })),
  "toggle payload carries enabled=true and this conversation id"
);
ok(enabledFor(SS_A) === true, "the fake host accepted the flip");
ok(enabledFor(SS_B) === false, "the other conversation is untouched");
button = findButton(element);
ok(button && button.props["aria-pressed"] === "true", "button flips after the host confirms");
ok(storage.get("dsh-wenyan:enabled:" + SS_A) === "1", "the flip is cached per conversation in localStorage");
ok(storage.get("dsh-wenyan:enabled:" + SS_B) !== "1", "the other conversation's cache stays off");

// ---- 4b. 灵敏度：三路同步 ----
ok(winListeners.some((l) => l.type === "focus"), "refreshes when the window regains focus");
ok(listeners.some((l) => l.type === "visibilitychange"), "refreshes when the page becomes visible");
ok(winListeners.some((l) => l.type === "storage"), "syncs across tabs via the storage event");

fakeWindow._dispatch("storage", { key: "dsh-wenyan:enabled:" + SS_A, newValue: "0" });
await settle();
element = runtime.render(reg.component, { sessionId: SS_A });
button = findButton(element);
ok(button && button.props["aria-pressed"] === "false", "a storage event turns this conversation off in this tab");

fakeWindow._dispatch("storage", { key: "dsh-wenyan:enabled:" + SS_A, newValue: "1" });
await settle();
element = runtime.render(reg.component, { sessionId: SS_A });
button = findButton(element);
ok(button && button.props["aria-pressed"] === "true", "a storage event turns it on in this tab");

// ---- 5. 违禁词提示 ----
listeners.length = 0;
element = runtime.remount(reg.component, { sessionId: SS_A });
await settle();
button = findButton(element);
ok(button && button.props["aria-pressed"] === "true", "the cached state restores the mode on remount");
ok(
  listeners.some((l) => l.type === "input"),
  "the input watcher is attached while the mode is on"
);
fakeDocument.dispatch("input", { tagName: "TEXTAREA", value: "你这傻逼在胡说八道" });
await settle();
element = runtime.render(reg.component, { sessionId: SS_A });
let hint = findHint(element);
ok(!!hint, "prohibited input raises the refusal hint");
ok(hint && String(hint.children.join("")).includes("婉拒"), "the hint tells the user the model will refuse");

// 正常技术问题不误报。
fakeDocument.dispatch("input", { tagName: "TEXTAREA", value: "如何用 TypeScript 定义一个泛型 Map？" });
await settle();
element = runtime.render(reg.component, { sessionId: SS_A });
ok(!findHint(element), "an ordinary technical question does not trigger the hint");

// 关闭模式后监听撤下、提示清空。
serverState.set(SS_A, false);
button = findButton(element);
button.props.onClick();
await settle();
ok(!listeners.some((l) => l.type === "input"), "turning the mode off detaches the input watcher");
element = runtime.render(reg.component, { sessionId: SS_A });
ok(!findHint(element), "turning the mode off clears the hint");
button = findButton(element);
ok(button && button.props["aria-pressed"] === "false", "second click flips it back off");

// ---- 6. 顶层无 ESM 语法 ----
ok(!/^(import|export)\s/m.test(source), "client has no top-level ESM import/export");
ok(!/localStorage\.getItem\(STORAGE_KEY\)/.test(source) || /var STORAGE_KEY/.test(source), "STORAGE_KEY is defined before use");

console.log("");
if (failures.length) {
  console.log("FAILED CHECKS (" + failures.length + "):");
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log("ALL CLIENT BEHAVIOR CHECKS PASSED");
}