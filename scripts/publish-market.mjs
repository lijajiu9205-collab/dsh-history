// 一键把 dsh-wenyan 提交到 awesome-dsh-plugin 市场列表。
//
// 用法（需要一枚能分叉公开仓库的经典令牌，scope: public_repo）：
//   $env:GH_TOKEN = "ghp_..."; $env:HTTPS_PROXY = "http://127.0.0.1:7897"
//   node --use-env-proxy scripts/publish-market.mjs
//
// 做的事：
//   1. 给自己的仓库加 dsh-plugin topic（需要 administration=write）
//   2. 分叉 awesome-dsh-plugin/awesome-dsh-plugin
//   3. 在分叉里开分支 plugin/dsh-wenyan，写入 data/plugins/<owner>__<repo>.yml
//   4. 向上游开 PR
//
// 市场规则要求目标仓库创建满 1 天才会过 CI；未满时脚本默认只做准备、不开 PR，
// 加 --force 可强行开（CI 会因仓库年龄失败，等满 24 小时后推一次空提交即可重跑）。

import { readFile } from "node:fs/promises";

const OWNER = "lijajiu9205-collab";
const REPO = "dsh-history";
const UPSTREAM = "awesome-dsh-plugin/awesome-dsh-plugin";
const BRANCH = "plugin/dsh-wenyan";
const ENTRY_PATH = `data/plugins/${OWNER}__${REPO}.yml`;

const token = process.env.GH_TOKEN || "";
if (!token) {
  console.error("缺少 GH_TOKEN：请设置环境变量后再运行。");
  process.exit(1);
}
const force = process.argv.includes("--force");
const API = "https://api.github.com";

process.on("unhandledRejection", (e) => {
  console.error("");
  console.error("发布失败：" + (e && e.message ? e.message : String(e)));
  if (e && e.status === 403) {
    console.error("令牌权限不足：分叉需要经典令牌 scope public_repo；加 topic 需要该仓库的 administration=write。");
  }
  process.exit(1);
});

async function call(method, path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          "user-agent": "dsh-wenyan-publish",
          authorization: "Bearer " + token,
          accept: "application/vnd.github+json",
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = { raw: text };
      }
      if (res.ok) return { status: res.status, body: json };
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = json;
      err.permissions = res.headers.get("x-accepted-github-permissions");
      throw err;
    } catch (e) {
      lastErr = e;
      if (e.status) throw e; // HTTP 错误不重试
      console.error(`  attempt ${attempt} 网络失败：${e.message}`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

const entryYaml = `url: https://github.com/${OWNER}/${REPO}
name: ${OWNER}/${REPO}
category: fun
tarball: https://github.com/${OWNER}/${REPO}/releases/download/v0.1.0/dsh-wenyan-0.1.0.tgz
description:
  en: 'Per-conversation toggle that makes the model answer in classical Chinese (文言 above a —— line, a modern-Chinese translation below) and speak as a blue classical-style fish that eats plain rice; each conversation keeps its own switch, and turning it off restores plain modern Chinese.'
  zh: '按对话独立的文言文开关：开启后模型改用文言行文（上段文言、中间「——」、下段白话译注），并化身蓝色古风、惯吃白饭的大肥鱼；每个对话各自记住开关，关闭即恢复现代汉语并隐去人格。'
`;

console.log("== 1. 检查目标仓库年龄 ==");
const repo = await call("GET", `/repos/${OWNER}/${REPO}`);
const createdAt = new Date(repo.body.created_at);
const ageHours = (Date.now() - createdAt.getTime()) / 3600000;
const ageOk = ageHours >= 24;
console.log(`  仓库建于 ${createdAt.toISOString()}，已 ${ageHours.toFixed(1)} 小时，满 24 小时：${ageOk ? "是" : "否"}`);

console.log("== 2. 加 dsh-plugin topic ==");
try {
  await call("PUT", `/repos/${OWNER}/${REPO}/topics`, { names: ["dsh-plugin"] });
  console.log("  topic 已加");
} catch (e) {
  console.log(`  跳过（${e.status ?? "?"}）：${e.permissions ?? e.message}`);
}

console.log("== 3. 分叉市场仓库 ==");
const me = await call("GET", "/user");
const meLogin = me.body.login;
console.log(`  当前账号：${meLogin}`);
try {
  await call("POST", `/repos/${UPSTREAM}/forks`, {});
} catch (e) {
  if (e.status === 422) console.log("  分叉已存在，继续");
  else throw e;
}
// 等分叉就绪
for (let i = 0; i < 20; i++) {
  try {
    await call("GET", `/repos/${meLogin}/awesome-dsh-plugin`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log("  分叉就绪");

console.log("== 4. 建分支并写入条目 ==");
const upstream = await call("GET", `/repos/${UPSTREAM}`);
const base = upstream.body.default_branch;
const baseRef = await call("GET", `/repos/${UPSTREAM}/git/ref/heads/${base}`);
const sha = baseRef.body.object.sha;
try {
  await call("POST", `/repos/${meLogin}/awesome-dsh-plugin/git/refs`, {
    ref: `refs/heads/${BRANCH}`,
    sha
  });
  console.log(`  分支 ${BRANCH} 已建（基于 ${base}@${sha.slice(0, 7)}）`);
} catch (e) {
  if (e.status === 422) console.log(`  分支 ${BRANCH} 已存在，继续`);
  else throw e;
}

const content = Buffer.from(entryYaml, "utf8").toString("base64");
try {
  await call("PUT", `/repos/${meLogin}/awesome-dsh-plugin/contents/${ENTRY_PATH}`, {
    message: `add ${OWNER}/${REPO}: classical-Chinese toggle with blue fish persona`,
    content,
    branch: BRANCH
  });
  console.log(`  已写入 ${ENTRY_PATH}`);
} catch (e) {
  if (e.status === 422) console.log("  条目已存在（内容相同则无需改动）");
  else throw e;
}

if (!ageOk && !force) {
  console.log("");
  console.log("仓库未满 24 小时，市场 CI 会拒绝本次提交，故暂不开 PR。");
  console.log("分支与条目已就绪；满 24 小时后重跑本脚本（或加 --force 先开 PR，之后再推空提交重跑 CI）。");
  process.exit(0);
}

console.log("== 5. 开 PR ==");
try {
  const pr = await call("POST", `/repos/${UPSTREAM}/pulls`, {
    title: `Add ${OWNER}/${REPO}`,
    head: `${meLogin}:${BRANCH}`,
    base,
    body: [
      `Adds **${OWNER}/${REPO}** — a DSH plugin that adds a per-conversation classical-Chinese toggle:`,
      "",
      "- Turned on, answers are two parts: 文言 above a `——` line, modern-Chinese translation below; the model also speaks as a blue classical-style fish that eats plain rice (自稱「本魚」).",
      "- Each conversation keeps its own switch; turning it off restores plain modern Chinese and retires the persona.",
      "- Declares `dsh.bundle` (installable via `dsh plugin add github:${OWNER}/${REPO}`) and ships a prebuilt `.tgz` on the v0.1.0 release.",
      "",
      "Repo: https://github.com/" + OWNER + "/" + REPO
    ].join("\n")
  });
  console.log(`  PR 已开：${pr.body.html_url}`);
} catch (e) {
  if (e.status === 422) console.log("  PR 可能已存在（422）");
  else throw e;
}
