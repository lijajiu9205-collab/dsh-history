// dsh-wenyan 宿主半身行为自检：伪造一个最小 ctx，验证
//   1. systemPrompt 段落按会话取值（开/关、默认、互相独立）；
//   2. /dsh-wenyan-4287/state 与 /toggle 路由按会话读写；
//   3. /wenyan 斜杠命令的三条分支；
//   4. 状态持久化与重启恢复。
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 隔离状态目录：别把测试的开关写进用户真实的 $DSH_HOME。
const sandboxHome = await mkdtemp(join(tmpdir(), "dsh-wenyan-selftest-"));
process.env.DSH_HOME = sandboxHome;

const HOST = pathToFileURL(process.argv[2]).href;
const plugin = await import(HOST);

const failures = [];
const ok = (cond, msg) => {
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
  if (!cond) failures.push(msg);
};

/**
 * 构造最小可用的 Cordis ctx 替身，并把捕获到的段落对象返回出来。
 *
 * 注：单名 inject 的回调收到的是一个带 get(name) 的上下文，
 * 多名 inject 同样是该上下文——与 dsh-mnemon 里
 * `ctx.inject(["systemPrompt"], (prompted) => prompted.get("systemPrompt").section(...))`
 * 的写法一致。
 *
 * @param {{ absent?: string[] }} [options] absent 列出的服务视作永不出场：
 *   对它的嵌套注入回调不执行（Cordis 会一直等服务出现）。用来模拟 headless
 *   里没有 webServer 的情形。
 */
function makeCtx(options) {
  const absent = new Set(options?.absent ?? []);
  const injected = [];
  const effects = [];
  const commands = [];
  const routes = [];
  let capturedSection = null;

  const registerEffect = (fn, label) => {
    let inner;
    try {
      inner = fn();
    } catch (e) {
      failures.push("effect[" + label + "] threw: " + e.message);
    }
    effects.push({ label, inner });
    return () => {};
  };

  const ctx = {
    _injected: injected,
    _effects: effects,
    _commands: commands,
    _routes: routes,
    get _section() {
      return capturedSection;
    },
    inject(names, fn) {
      const services = {};
      for (const n of names) services[n] = {};
      if (names.includes("systemPrompt")) {
        services.systemPrompt = {
          section: (s) => {
            capturedSection = s;
          }
        };
      }
      if (names.includes("webServer")) {
        services.webServer = { register: (spec) => routes.push(spec) };
      }
      if (names.includes("commands")) {
        services.commands = { register: (spec) => commands.push(spec) };
      }
      // 作用域对象：既是服务袋，又自带 effect（Cordis 的注入作用域）。
      const scoped = {
        ...services,
        get: (n) => services[n],
        effect: registerEffect
      };
      injected.push({ names, scoped });
      if (names.some((n) => absent.has(n))) {
        // 服务不在场：Cordis 记下这次注入请求，但回调要等服务出现才执行。
        return () => {};
      }
      try {
        fn(scoped);
      } catch (e) {
        failures.push("inject callback threw: " + e.message);
      }
      return () => {};
    },
    effect: registerEffect,
    get: () => undefined,
    on: () => () => {},
    webServer: { register: (spec) => routes.push(spec) },
    commands: { register: (spec) => commands.push(spec) }
  };
  return ctx;
}

const ctx = makeCtx();
await plugin.apply(ctx);
const section = ctx._section;

/** 取某会话应得的提示词段落文本。 */
const textFor = (sid) => section.text({ agent: { session: { id: sid } } });
/** 取无会话上下文的默认文本。 */
const textDefault = () => section.text({});

// ---- 1. systemPrompt 段落 ----
ok(plugin.name === "wenyan", "plugin name export is 'wenyan'");
ok(Array.isArray(plugin.inject) && plugin.inject.length === 0, "host hard-injects nothing (optional services mount lazily)");
ok(ctx._injected.some((e) => e.names.includes("systemPrompt")), "host requested the systemPrompt service");
ok(ctx._injected.some((e) => e.names.includes("webServer")), "host requests webServer lazily (nested)");
ok(ctx._injected.some((e) => e.names.includes("commands")), "host requests commands lazily (nested)");
ok(!!section, "a systemPrompt section was registered");
ok(section && section.name === "wenyan:style", "section name is wenyan:style");
ok(typeof section.text === "function", "section text is lazy (a function)");
ok(typeof section.order === "number", "section has a numeric order");
ok(section.order > 10200, "section sorts after the built-in persona suffix (last, strongest recency)");
ok(section.interpolate === false, "section opts out of {{var}} interpolation (code examples stay literal)");

// 默认态：任何会话都关闭；两个会话互相独立。
ok(textFor("s-a").startsWith("【模式：现代汉语】"), "a fresh conversation starts off");
ok(textFor("s-b").startsWith("【模式：现代汉语】"), "a second fresh conversation also starts off");
ok(textDefault().startsWith("【模式：现代汉语】"), "without a conversation the default is off");

// ---- 2. HTTP 路由 ----
const route = ctx._routes.find((r) => r.kind === "prefix");
ok(!!route, "host registered a prefix route");
ok(route && route.path === "/dsh-wenyan-4287", "route prefix is /dsh-wenyan-4287");

const server = createServer((req, res) => void route.handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port + "/dsh-wenyan-4287";

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json().catch(() => null) };
};
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

{
  const r = await get("/state");
  ok(r.status === 200, "GET /state returns 200");
  ok(typeof r.body?.enabled === "boolean", "GET /state reports a boolean enabled");
}
{
  // 按会话开启 s-a：s-a 开，s-b 仍关，全局默认不动。
  const r = await post("/toggle", { enabled: true, sessionId: "s-a" });
  ok(r.status === 200 && r.body.ok === true, "POST /toggle with a sessionId acknowledges");
  ok(r.body.enabled === true, "POST /toggle flips that conversation on");
  ok(textFor("s-a").startsWith("【文言体例"), "s-a now gets the wenyan spec");
  ok(/身蓝而腹大/.test(textFor("s-a")), "the on-mode prompt bounds the blue fat fish");
  ok(/惯吃白饭/.test(textFor("s-a")), "the on-mode prompt makes the fish a rice freeloader");
  ok(/自称必曰「本鱼」/.test(textFor("s-a")), "the on-mode prompt teaches 本鱼 self-reference");
  ok(textFor("s-b").startsWith("【模式：现代汉语】"), "s-b stays off (conversations are independent)");
  ok(textDefault().startsWith("【模式：现代汉语】"), "the global default stays off");
  ok((await get("/state?sessionId=s-a")).body.enabled === true, "GET /state?sessionId reads s-a back as on");
  ok((await get("/state?sessionId=s-b")).body.enabled === false, "GET /state?sessionId reads s-b back as off");

  // 关掉 s-a：回到反向指令，人格随之隐去。
  const off = await post("/toggle", { enabled: false, sessionId: "s-a" });
  ok(off.body.enabled === false, "POST /toggle turns s-a back off");
  ok(textFor("s-a").startsWith("【模式：现代汉语】"), "s-a falls back to the standing off-directive");
  ok(/人格随开关隐去/.test(textFor("s-a")), "the off-directive retires the 大肥鱼 persona");
  ok(!/身蓝而腹大/.test(textFor("s-a")), "the off-directive no longer describes the fish");
}
{
  // 全局默认拨到开：显式关过的 s-a 不受影响，新会话继承默认。
  const r = await post("/toggle", { enabled: true });
  ok(r.body.enabled === true, "POST /toggle without sessionId moves the global default");
  ok(textDefault().startsWith("【文言体例"), "the default now reads as on");
  ok(textFor("s-a").startsWith("【模式：现代汉语】"), "an explicit off override survives the default flip");
  ok(textFor("s-new").startsWith("【文言体例"), "a never-seen conversation inherits the default");
  // 复位，避免影响后续断言。
  await post("/toggle", { enabled: false });
  ok(textDefault().startsWith("【模式：现代汉语】"), "the default can be moved back off");
}
{
  ok((await fetch(base + "/nowhere")).status === 404, "unknown path returns 404");
  ok((await fetch(base + "/state", { method: "DELETE" })).status === 405, "wrong method returns 405");
}

// ---- 3. /wenyan 斜杠命令 ----
const cmd = ctx._commands.find((c) => c.name === "wenyan");
ok(!!cmd, "host registered a /wenyan command");
if (cmd) {
  ok(typeof cmd.handler === "function", "command has a handler");
  ok(cmd.handler({ rawInput: "" }).kind === "success", "/wenyan with no arg reports status");
  ok(cmd.handler({ rawInput: "ON", sessionId: "c-1" }).kind === "success", "/wenyan ON succeeds");
  ok(textFor("c-1").startsWith("【文言体例"), "/wenyan ON turns that conversation's prompt on");
  ok(textFor("c-2").startsWith("【模式：现代汉语】"), "another conversation is untouched by /wenyan ON");
  ok(cmd.handler({ rawInput: "off", sessionId: "c-1" }).kind === "success", "/wenyan off succeeds");

  // 关模式：每轮都带常驻反向指令，压住历史文言惯性。
  const offText = textFor("c-1");
  ok(offText.startsWith("【模式：现代汉语】"), "/wenyan off emits the standing off-directive");
  ok(/现代汉语/.test(offText), "off-directive tells the model to speak modern Chinese");
  ok(textFor("c-1").startsWith("【模式：现代汉语】"), "the off-directive persists on later turns");

  ok(cmd.handler({ rawInput: "maybe" }).kind === "error", "/wenyan with a bogus arg errors");
}

// ---- 4. 持久化与恢复 ----
{
  await post("/toggle", { enabled: true, sessionId: "persist-on" });
  await post("/toggle", { enabled: false, sessionId: "persist-off" });
  const raw = JSON.parse(await readFile(join(sandboxHome, "dsh-wenyan", "state.json"), "utf8"));
  ok(raw.sessions && raw.sessions["persist-on"] === true, "state.json records a per-session on");
  ok(raw.sessions && raw.sessions["persist-off"] === false, "state.json records a per-session off");
  ok(typeof raw.default === "boolean", "state.json records the global default");

  // 模拟宿主重启：新 ctx 重新 apply，应读回同样的会话状态。
  const ctx2 = makeCtx();
  await plugin.apply(ctx2);
  const s2 = ctx2._section;
  ok(
    s2.text({ agent: { session: { id: "persist-on" } } }).startsWith("【文言体例"),
    "a restarted host restores a conversation that was on"
  );
  ok(
    s2.text({ agent: { session: { id: "persist-off" } } }).startsWith("【模式：现代汉语】"),
    "a restarted host restores a conversation that was off"
  );
}

server.closeAllConnections?.();
await server.close();

// ---- 5. headless 场景：webServer 不在场 ----
{
  const ctxH = makeCtx({ absent: ["webServer"] });
  await plugin.apply(ctxH);
  ok(!!ctxH._section, "with no webServer the systemPrompt section still registers");
  ok(
    ctxH._section.text({ agent: { session: { id: "x" } } }).length > 0,
    "section text stays callable with a conversation context"
  );
  ok(ctxH._commands.some((c) => c.name === "wenyan"), "the /wenyan command still registers without webServer");
  ok(ctxH._routes.length === 0, "no HTTP bridge is mounted without webServer");
}

await rm(sandboxHome, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.log("FAILED CHECKS (" + failures.length + "):");
  for (const f of failures) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log("ALL HOST BEHAVIOR CHECKS PASSED");
}