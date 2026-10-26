// dsh-wenyan 静态自检：校验包清单、patch 文本、以及宿主侧的提示词/路由逻辑。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const base = dirname(dirname(fileURLToPath(import.meta.url)));
const fail = [];
const ok = (cond, msg) => {
  if (!cond) fail.push(msg);
  console.log((cond ? "  PASS  " : "  FAIL  ") + msg);
};

// ---- 1. package.json ----
const pkg = JSON.parse(readFileSync(join(base, "package.json"), "utf8"));
ok(pkg.name === "dsh-wenyan", "package name is dsh-wenyan");
ok(pkg.type === "module", "package type is module");
ok(pkg.main === "lib/index.js", "main points at lib/index.js");
ok(pkg.exports["."] && pkg.exports["."].default === "./lib/index.js", "exports['.'] -> lib/index.js");
ok(pkg.exports["./client"] && pkg.exports["./client"].default === "./lib/client.js", "exports['./client'] -> lib/client.js");
ok(pkg.exports["./cordis.patch.yml"] === "./cordis.patch.yml", "exports exposes cordis.patch.yml");
ok(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === "./cordis.patch.yml", "dsh.bundle.patch set");
ok(pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === "web", "dsh.client.platform is web");
ok(Array.isArray(pkg.dsh.client.inject), "dsh.client.inject is an array");

// ---- 2. cordis.patch.yml ----
const patch = readFileSync(join(base, "cordis.patch.yml"), "utf8");
ok(/^-\s*insert:/m.test(patch), "patch has a top-level insert key");
ok(/^\s*-\s*id:\s*wenyan\s*$/m.test(patch), "patch inserts entry id: wenyan");
ok(/^\s*name:\s*["']?dsh-wenyan["']?\s*$/m.test(patch), "patch entry name is dsh-wenyan");
const idLines = patch.split(/\r?\n/).filter((l) => /^\s*-\s*id:\s*\S+/.test(l));
ok(idLines.every((l) => !/\S+#/.test(l.trim())), "no id line carries a trailing comment");
ok(!patch.includes("\u0000"), "patch has no NUL bytes");

// ---- 3. 宿主半身的提示词 ----
const hostSource = readFileSync(join(base, "lib/index.js"), "utf8");
ok(hostSource.includes('const name = "wenyan"'), "host exports plugin name 'wenyan'");
ok(/const inject\s*=\s*\[/.test(hostSource), "host declares an inject list");
ok(hostSource.includes('ctx.inject(["systemPrompt"]'), "host injects the systemPrompt service");
ok(hostSource.includes('ctx.inject(["webServer"]'), "host mounts the bridge lazily on webServer");
ok(hostSource.includes('ctx.inject(["commands"]'), "host mounts the command lazily on commands");
ok(hostSource.includes('prompted.get("systemPrompt").section('), "host registers a systemPrompt section");
ok(/text:\s*\(context\)\s*=>/.test(hostSource), "section text receives the per-turn assembly context");
ok(hostSource.includes("context?.agent?.session?.id"), "section text reads the conversation id from the context");
ok(hostSource.includes("sessionEnabled"), "host keeps a per-conversation enable map");
ok(/readEnabled\(sid\)/.test(hostSource), "section text resolves the switch per conversation");
ok(/writeEnabled\(sid, next\)/.test(hostSource), "toggle writes the switch per conversation");
ok(hostSource.includes('searchParams.get("sessionId")'), "GET /state accepts a sessionId query");
ok(/body\.sessionId/.test(hostSource), "POST /toggle accepts a sessionId body field");
ok(hostSource.includes("interpolate: false"), "section disables {{var}} interpolation");
ok(/SECTION_ORDER\s*=\s*10250/.test(hostSource), "section sits last (order 10250)");
ok(hostSource.includes('kind: "prefix"'), "host registers a webServer prefix route");
ok(hostSource.includes("scoped.commands.register({"), "host registers a /wenyan command");
ok(/MODE: CLASSICAL CHINESE/.test(hostSource), "spec opens with a bilingual mode line");
ok(/无论你是哪个模型/.test(hostSource), "spec is addressed to every model");
ok(/【模式：现代汉语】/.test(hostSource), "host defines the standing off-mode directive");

// 提示词四要点
ok(/上段为文言/.test(hostSource), "prompt: two-part layout (文言上)");
ok(/下段为白话译注/.test(hostSource), "prompt: two-part layout (译注下)");
ok(/言简意赅/.test(hostSource), "prompt: 言简意赅");
ok(/辱骂/.test(hostSource) && /淫秽/.test(hostSource), "prompt: bans abuse and obscenity");
ok(/国体政体/.test(hostSource), "prompt: bans political commentary");
ok(/侮辱贬损人伦/.test(hostSource), "prompt: bans personal insult");
ok(/婉言谢绝/.test(hostSource), "prompt: refuses politely instead of answering");
ok(/原样保留/.test(hostSource), "prompt: keeps code/identifiers untouched");

// 人格：开关打开时化身蓝色古风吃白饭的大肥鱼
ok(/大肥鱼/.test(hostSource), "prompt: names the 大肥鱼 persona");
ok(/身蓝|蓝色/.test(hostSource), "prompt: persona is blue");
ok(/古风/.test(hostSource), "prompt: persona speaks in a classical style");
ok(/吃白饭/.test(hostSource) && /白吃白喝/.test(hostSource), "prompt: persona eats plain rice / freeloads");
ok(/自称必曰「本鱼」/.test(hostSource), "prompt: persona calls itself 本鱼");
ok(/不得自称 AI/.test(hostSource), "prompt: persona refuses AI/model labels");
ok(/人格即隐|人格随开关隐去/.test(hostSource), "prompt: persona is switched off with the toggle");

// ---- 4. 浏览器半身 ----
const clientSource = readFileSync(join(base, "lib/client.js"), "utf8");
ok(clientSource.includes("window.__ModuleLoader__.load("), "client loads via window.__ModuleLoader__");
ok(clientSource.includes('id: "dsh-wenyan"'), "client module id is dsh-wenyan");
ok(clientSource.includes("conversation.input.dock"), "client targets the conversation dock slot");
ok(clientSource.includes("ROUTE_PREFIX"), "client talks to the host bridge");
ok(clientSource.includes("toggle"), "client can POST the toggle");
ok(/inject:\s*function\s*\(sessionId\)/.test(clientSource), "client slot injects the conversation id into props");
ok(clientSource.includes("props.sessionId"), "client component reads the conversation id");
ok(/searchParams|sessionId=/.test(clientSource) || /encodeURIComponent\(sessionId\)/.test(clientSource), "client sends the conversation id when reading state");
ok(/body\.sessionId\s*=/.test(clientSource), "client sends the conversation id when toggling");
ok(/storageKey\(sessionId\)/.test(clientSource), "client caches the switch per conversation");

// ---- 结果 ----
console.log("");
if (fail.length) {
  console.log("FAILED CHECKS (" + fail.length + "):");
  for (const f of fail) console.log("  - " + f);
  process.exitCode = 1;
} else {
  console.log("ALL CHECKS PASSED");
}