#!/usr/bin/env node
// dsh-wenyan 安装器：把本插件装进 $DSH_HOME/profiles/<name> 这个 profile。
//
// 做两件事（都是可回逆的）：
//   1. 把插件源码整包拷到 $DSH_HOME/plugins/dsh-wenyan/（与 profile 分离，
//      日后 pnpm 升级、重装 profile 都不会把它卷掉）；
//   2. 改 profile 的 package.json：
//        dependencies["dsh-wenyan"] = "file:<相对路径>"   ← pnpm 的安装来源
//        dsh.profile.bundles 追加 "dsh-wenyan"           ← 配置树的层栈
//   原 package.json 先备份为 package.json.bak-<时间戳>。
//
// 之后需要跑一次 pnpm install 把依赖实体化进 profile 的 node_modules：
//   dsh plugin --profile <name> install
// 或：
//   pnpm install --dir "$DSH_HOME/profiles/<name>"
//
// 卸载：node scripts/install.mjs --uninstall [--profile <name>]
// 卸载只回退 package.json 与 bundles 列表；node_modules 与暂存目录由
// pnpm（dsh plugin remove）或 --purge 负责清理。

import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const PACKAGE_NAME = "dsh-wenyan";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(SCRIPT_DIR, "..");

// ---- 参数 ----
const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--uninstall") flags.uninstall = true;
  else if (a === "--purge") flags.purge = true;
  else if (a === "--profile") flags.profile = argv[++i];
  else if (a === "--dsh-home") flags.dshHome = argv[++i];
  else if (a === "--stage") flags.stage = argv[++i];
  else {
    console.error("未知参数：" + a + "\n用法：node scripts/install.mjs [--profile <name>] [--dsh-home <dir>] [--uninstall] [--purge]");
    process.exit(2);
  }
}

const dshHome = flags.dshHome || process.env.DSH_HOME || join(homedir(), ".dsh");
const profile = flags.profile || "desktop";
const profileDir = join(dshHome, "profiles", profile);
const stageDir = flags.stage ? resolve(flags.stage) : join(dshHome, "plugins", PACKAGE_NAME);
const profileManifestPath = join(profileDir, "package.json");

const fail = (msg) => {
  console.error("错误：" + msg);
  process.exit(1);
};

/**
 * profile package.json 里的依赖规格：link: 指向暂存目录（posix 斜杠，相对 profile 目录）。
 *
 * 与 DSH 平台 plugin-manager 装本地目录的行为一致（它写的是 "link:<绝对路径>"）。
 * 刻意不用 "file:"——pnpm 对 file: 会把包**复制**进 node_modules，日后源码改了
 * 副本仍是旧的；link: 让 node_modules/dsh-wenyan 直接是指针，改暂存目录即生效。
 */
function fileSpecFor(target) {
  let rel = relative(profileDir, target).replace(/\\/g, "/");
  if (!rel.startsWith(".")) rel = "./" + rel;
  return "link:" + rel;
}

/**
 * 直接在 profile 的 node_modules 里建 junction 指向暂存目录。
 *
 * 桌面端的 desktop profile 由 Electron 专管，CLI 拒绝 `--profile desktop install`，
 * pnpm 那步在外部跑不了。而 pnpm（nodeLinker: hoisted）对本地 link 依赖本来就落成
 * junction——我们提前把它建好，清单里又有 dependencies 声明，下次 pnpm 对账结果一致，
 * 于是「装完重启即激活」，不依赖桌面应用先跑安装。建不成（权限/跨卷）不算失败：
 * 回退为提示用户跑一次 pnpm。
 *
 * @returns 成功时返回 junction 路径，失败返回 null。
 */
async function linkIntoProfile() {
  const { symlink } = await import("node:fs/promises");
  const nm = join(profileDir, "node_modules", PACKAGE_NAME);
  try {
    await rm(nm, { recursive: true, force: true });
    await mkdir(dirname(nm), { recursive: true });
    await symlink(stageDir, nm, "junction");
    return nm;
  } catch (e) {
    console.warn("提示：直连 node_modules 建链失败（" + (e instanceof Error ? e.message : String(e)) + "），改用 pnpm 安装即可。");
    return null;
  }
}

/** 需要进暂存目录的文件清单（与包结构一一对应）。 */
const STAGE_ENTRIES = ["package.json", "README.md", "LICENSE", "icon.svg", "cordis.patch.yml", "lib", "test"];

async function stagePlugin() {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });
  const copied = [];
  for (const e of STAGE_ENTRIES) {
    const src = join(PLUGIN_ROOT, e);
    if (!existsSync(src)) continue;
    await cp(src, join(stageDir, e), { recursive: true });
    copied.push(e);
  }
  return copied;
}

async function readManifest() {
  if (!existsSync(profileManifestPath)) {
    fail("找不到 " + profileManifestPath + "；profile「" + profile + "」未初始化（先跑一次 dsh --profile " + profile + " 或检查 --profile 名称）");
  }
  let data;
  try {
    // 去 BOM：Windows 上的编辑器与 PowerShell 常给 UTF-8 文件加 BOM。
    const text = (await readFile(profileManifestPath, "utf8")).replace(/^\uFEFF/, "");
    data = JSON.parse(text);
  } catch (e) {
    fail("profile 的 package.json 解析失败：" + e.message);
  }
  return data;
}

async function writeManifestWithBackup(data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = profileManifestPath + ".bak-" + stamp;
  await rename(profileManifestPath, backup);
  await writeFile(profileManifestPath, JSON.stringify(data, null, 2) + "\n", "utf8");
  return backup;
}

// ---- 卸载 ----
if (flags.uninstall) {
  const data = await readManifest();
  const bundles = data?.dsh?.profile?.bundles;
  const removed = [];
  if (Array.isArray(bundles)) {
    const idx = bundles.indexOf(PACKAGE_NAME);
    if (idx >= 0) {
      bundles.splice(idx, 1);
      removed.push("bundles 条目");
    }
  }
  if (data.dependencies && data.dependencies[PACKAGE_NAME]) {
    delete data.dependencies[PACKAGE_NAME];
    removed.push("dependencies 条目");
  }
  if (flags.purge) {
    await rm(join(profileDir, "node_modules", PACKAGE_NAME), { recursive: true, force: true });
    await rm(stageDir, { recursive: true, force: true });
    removed.push("node_modules/" + PACKAGE_NAME + " 与暂存目录（--purge）");
  }
  if (!removed.length) {
    console.log("profile「" + profile + "」里没有 " + PACKAGE_NAME + " 的安装痕迹，无需卸载。");
    process.exit(0);
  }
  const backup = await writeManifestWithBackup(data);
  console.log("已从 profile「" + profile + "」卸载 " + PACKAGE_NAME + "。");
  console.log("  移除：" + removed.join("、"));
  console.log("  原清单备份：" + backup);
  console.log("后续请跑一次安装以更新锁文件：dsh plugin --profile " + profile + " install");
  if (!flags.purge) {
    console.log("（暂存目录与 node_modules 未删；需要一并清掉请加 --purge，或跑 dsh plugin --profile " + profile + " remove " + PACKAGE_NAME + "）");
  }
  process.exit(0);
}

// ---- 安装 ----
const data = await readManifest();
data.dependencies = data.dependencies ?? {};
data.dsh = data.dsh ?? {};
data.dsh.profile = data.dsh.profile ?? {};
data.dsh.profile.bundles = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles : [];

const copied = await stagePlugin();
data.dependencies[PACKAGE_NAME] = fileSpecFor(stageDir);
if (!data.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  data.dsh.profile.bundles.push(PACKAGE_NAME);
}
const backup = await writeManifestWithBackup(data);
const linked = await linkIntoProfile();

console.log("已把 " + PACKAGE_NAME + " 装进 profile「" + profile + "」：");
console.log("  暂存目录：" + stageDir + "（已拷入 " + copied.join(", ") + "）");
console.log("  依赖项：" + PACKAGE_NAME + " = " + data.dependencies[PACKAGE_NAME]);
console.log("  bundles：" + data.dsh.profile.bundles.join(", "));
console.log("  原清单备份：" + backup);
console.log("");
if (linked) {
  console.log("  node_modules 链接：" + linked + " → 暂存目录");
  console.log("重启 DSH（桌面端退出后重新打开）即可生效；改完源码重跑本脚本即可刷新暂存。");
} else {
  console.log("下一步（二选一），然后重启 DSH：");
  console.log("  dsh plugin --profile " + profile + " install");
  console.log("  pnpm install --dir \"" + profileDir + "\"");
}
