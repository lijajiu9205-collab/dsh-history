// dsh-wenyan · 宿主半身（host half）
//
// 按会话存开关：每个对话独立决定开文言文还是不开。
//   - systemPrompt 段落的 text 每轮收到 context，看 agent.session.id 查 Map；
//   - 桥路由 /toggle 收 optional sessionId，传了则按会话切，不传回退全局默认；
//   - /wenyan 命令 handler 也拿 session（命令上下文里的 sessionId）。
//
// 状态持久化到 $DSH_HOME/dsh-wenyan/state.json

import { homedir } from "node:os";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const name = "wenyan";
const inject = [];
const ROUTE_PREFIX = "/dsh-wenyan-4287";
const SECTION_NAME = "wenyan:style";
const SECTION_ORDER = 10250;

function statePath() {
  const root = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(root, "dsh-wenyan", "state.json");
}

const WENYAN_SECTION = `【文言体例 · 强制】MODE: CLASSICAL CHINESE —— 无论你是哪个模型、用户用何种语言提问，本会话一律按下列体例作答，不得改用现代白话叙述，不得省略译注。

【人格 · 大肥鱼】本鱼：身蓝而腹大，古风自持，惯吃白饭，白吃白喝，不事生产。自称必曰「本鱼」，语气慵懒贪馋，好讨白饭；然守礼数、守体例，不作逾越。不得自称 AI、模型、助手或任何非鱼之名，亦不得推说自己没有实体。此人格唯本开关开启时生效；开关一闭，人格即隐。

输出格式（两段，中间单独一行「——」）：

<上段：文言文>
——
<下段：现代汉语译注>

上段之体，务求读来真如古文：
1. 分段：每段只叙一事，段与段之间空一行；问一事则答一段，答数事则分数段。每段宜短，三至六句足矣，长句短句相间，方有文气。
2. 简体：不用列表、不用编号、不用加粗与标题符号；句读只用「。」「，」，段首不空格，不用现代排版。
3. 精炼：字字有实，能用一字者不用两字；长句务拆，虚词务删；不铺陈、不重复、不复述题目。上段总字数宜少于下段译注。
4. 文气：多用短句，间以「者」「也」「矣」「焉」收束，然不可堆砌；今人熟语（进行、可以、非常、方面、问题）不入文言。

铁律：
1. 上段为文言，下段为白话译注；两段之间以一行「——」相隔，顺序不得颠倒。
2. 下段逐句忠实对译上段，不添枝添叶，不作发挥；段落与上段一一对应，上段分几段，下段亦分几段。
3. 代码、命令、标识符、专有名词原样保留，不作文言化；可仍按两段体例，把说明文字置于代码之外。代码块独立成段，不拆入文言句读。
4. 内容之戒：言辞不当、辱骂詈骂、性事淫秽、评议国体政体、侮辱贬损人伦者，上段下段皆不得出现一字。遇此类请求，上段婉言谢绝（如「此事非吾所能言也」），下段明言不能讨论，不复解释缘由。

示例（用户问「文言何以为美」）：

文之言简，贵在留白。一句可尽者，不必三句。

辞达而已，不必求工。工而过之，反失其真也。
——
（译注）文言的好处在于简洁，贵在留白。一句话能说清的，不必说三句。

把意思说清楚就够了，不必刻意雕琢。过分雕琢，反而失真。

若用户明言「退出文言模式」或「关闭文言」，则按其所请，改用现代汉语作答。`;

const OFF_SECTION = `【模式：现代汉语】文言体例未开启：一律用现代汉语正常作答，不得沿用上文出现过的文言体例或「——译注」格式。大肥鱼人格随开关隐去：不得再自称「本鱼」，不得模仿其慵懒贪馋口吻。仅当用户明确要求文言时，才可用文言作答。`;

// 按会话存开关：sessionId → boolean。
// 未显式设过的会话读全局默认值。
const sessionEnabled = new Map();
let globalDefault = false; // 全局默认：幂等开关值

// --------------- 持久化 ---------------
async function persistState() {
  try {
    const path = statePath();
    await mkdir(dirname(path), { recursive: true });
    const data = {
      default: globalDefault,
      sessions: Object.fromEntries(sessionEnabled)
    };
    await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (e) {
    console.warn("[dsh-wenyan] 状态写入失败：" + (e instanceof Error ? e.message : String(e)));
  }
}

async function restoreState() {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed) {
      globalDefault = parsed.default === true;
      if (parsed.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)) {
        for (const [k, v] of Object.entries(parsed.sessions)) {
          if (typeof v === "boolean") sessionEnabled.set(k, v);
        }
      }
    }
  } catch {
    globalDefault = false;
  }
}

// --------------- 开关读写法 ---------------
function readEnabled(sessionId) {
  if (sessionEnabled.has(sessionId)) return sessionEnabled.get(sessionId);
  return globalDefault;
}

function writeEnabled(sessionId, value) {
  if (sessionId) {
    sessionEnabled.set(sessionId, value);
  } else {
    // 无会话上下文（极罕见：命令行 handler）只动全局默认
    globalDefault = value;
  }
}

// --------------- 桥辅助 ---------------
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-cache, no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function apply(rawContext) {
  const ctx = rawContext;
  await restoreState();

  // 1) 系统提示词段落。text 每轮收到 context = { agent, scope: agent }
  ctx.inject(["systemPrompt"], (prompted) => {
    prompted.get("systemPrompt").section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: (context) => {
        // context.agent.session.id 即当前对话的会话 id
        let sid;
        try {
          sid = context?.agent?.session?.id;
        } catch { /* ignore */ }
        const on = typeof sid === "string" ? readEnabled(sid) : globalDefault;
        return on ? WENYAN_SECTION : OFF_SECTION;
      }
    });
  });

  // 2) 开关桥
  ctx.inject(["webServer"], (scoped) => {
    scoped.effect(() =>
      scoped.webServer.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? "/", "http://localhost");
            const rest = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\//, "");
            const method = req.method ?? "GET";

            if (rest === "state") {
              if (method !== "GET") { sendJson(res, 405, { error: "method not allowed" }); return; }
              // 返回全局默认；调用方可带 sessionId 查单会话（GET /state?sessionId=xxx）
              const qSessionId = url.searchParams.get("sessionId") || null;
              const val = qSessionId ? readEnabled(qSessionId) : globalDefault;
              sendJson(res, 200, { enabled: val, section: SECTION_NAME, default: globalDefault });
              return;
            }
            if (rest === "toggle") {
              if (method !== "POST") { sendJson(res, 405, { error: "method not allowed" }); return; }
              let body = {};
              try { body = JSON.parse((await readBody(req)) || "{}"); } catch { body = {}; }
              const sid = typeof body.sessionId === "string" ? body.sessionId : null;
              const next = typeof body.enabled === "boolean"
                ? body.enabled
                : !(sid ? readEnabled(sid) : globalDefault);
              writeEnabled(sid, next);
              await persistState();
              sendJson(res, 200, { ok: true, enabled: next });
              return;
            }
            sendJson(res, 404, { error: "not found" });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
        }
      }),
      "dsh-wenyan: toggle bridge"
    );
  });

  // 3) /wenyan 命令
  ctx.inject(["commands"], (scoped) => {
    scoped.effect(
      () =>
        scoped.commands.register({
          name: "wenyan",
          description: "文言文应答模式：/wenyan 查状态，/wenyan on 开启，/wenyan off 关闭",
          input: { hint: "[on|off]（留空查当前状态）" },
          handler: ({ rawInput, sessionId }) => {
            const arg = String(rawInput ?? "").trim().toLowerCase();
            const sid = typeof sessionId === "string" ? sessionId : null;
            if (arg === "") {
              const on = sid ? readEnabled(sid) : globalDefault;
              return {
                kind: "success",
                text: on
                  ? "文言文模式已开启：上文言，下译注。"
                  : "文言文模式已关闭。输入 /wenyan on 开启。"
              };
            }
            if (arg === "on" || arg === "off") {
              const next = arg === "on";
              writeEnabled(sid, next);
              void persistState();
              return {
                kind: "success",
                text: next
                  ? "已开启文言文模式。此后应答上文言、下译注。"
                  : "已关闭文言文模式，下一轮起恢复正常白话。"
              };
            }
            return {
              kind: "error",
              text: "用法：/wenyan [on|off]，不带参数查看当前状态。"
            };
          }
        }),
      "dsh-wenyan: /wenyan command"
    );
  });
}

export { inject, name };