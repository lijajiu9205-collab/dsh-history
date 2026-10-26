# dsh-wenyan · 文言文应答模式（蓝色古风大肥鱼）

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）加一个「文言文」开关：打开后模型改用文言行文，并在下段附白话译注；同时化身一只**蓝色古风、惯吃白饭的大肥鱼**。开关**按对话独立**，每个对话各自记住自己的状态。

## 效果

开关打开时，回答固定两段：

```
文之言简，贵在留白。一句可尽者，不必三句。

辞达而已，不必求工。工而过之，反失其真也。
——
（译注）文言的好处在于简洁，贵在留白。一句话能说清的，不必说三句。

把意思说清楚就够了，不必刻意雕琢。过分雕琢，反而失真。
```

- 上段为文言：按事分段、段间空行，句短字省，不用列表与编号，读来如真古文；下段为白话译注，逐句对译、段落与上段一一对应。
- 上段总字数刻意压得比译注短，长句拆开、虚词删去，避免现代白话词混入。
- 代码、命令、标识符、专有名词原样保留，不作文言化；代码块独立成段。
- 人格：自称「本鱼」，身蓝而腹大，古风自持，惯吃白饭、白吃白喝，语气慵懒贪馋。
- 内容之戒：辱骂、淫秽、涉政评议、侮辱人伦诸类请求，上段婉言谢绝、下段明言不能讨论。

开关关闭时，一律现代汉语正常作答，人格随之隐去，不残留「本鱼」口吻与「——译注」格式。

## 安装

Web / headless 版：

```sh
dsh plugin --profile web add github:lijajiu9205-collab/dsh-history
```

或用 [Release](https://github.com/lijajiu9205-collab/dsh-history/releases) 里的预构建包（`.tgz`，免构建授权，也可直接下载）：

```sh
dsh plugin --profile web add "https://github.com/lijajiu9205-collab/dsh-history/releases/download/v0.1.0/dsh-wenyan-0.1.0.tgz"
```

桌面版（desktop profile 由 Electron 应用专管，`dsh plugin --profile desktop add` 会被拒绝）：

- 推荐：装 [dshmarket](https://github.com/dsh-market/dsh-market) 插件市场，在「发现」里搜索本插件一键安装；
- 或用本仓库自带的安装器（把插件暂存到 `$DSH_HOME/plugins/dsh-wenyan`，在 profile 的 `package.json` 里写 `link:` 依赖并在 `node_modules` 建链）：

  ```powershell
  node scripts/install.mjs                  # 默认装进 desktop profile
  node scripts/install.mjs --profile tui    # 装进别的 profile
  ```

装完**重启 DSH** 生效。

## 使用

- 对话输入框上方出现「文言文」按钮：点一下开，再点一下关。**只影响当前对话**。
- 或输入斜杠命令：`/wenyan`（查状态）、`/wenyan on`、`/wenyan off`。
- 新对话默认关闭；开过的对话状态会记住。

## 状态与配置

开关状态存在 `$DSH_HOME/dsh-wenyan/state.json`：

```json
{
  "default": false,
  "sessions": {
    "<会话 id>": true
  }
}
```

`default` 是未显式设置过的对话的默认值，`sessions` 记录每个对话自己的开关。删掉该文件即恢复全部关闭。

## 目录结构

```
lib/index.js       宿主半身：系统提示词段落 + 开关桥（HTTP）+ /wenyan 命令
lib/client.js      浏览器半身：输入框上方的开关（按会话注入 sessionId）
cordis.patch.yml   插件装载声明（dsh.bundle.patch）
icon.svg           图标
scripts/install.mjs 本地安装脚本（把本包装进某个 profile）
test/              静态检查、宿主行为自检、浏览器行为自检
```

## 开发

```sh
npm test            # 三套自检：static / host / client
```

- 宿主侧 `systemPrompt.section({ text: (context) => … })` 每轮求值，用 `context.agent.session.id` 查该对话的开关，因此每轮都会「看一眼当前对话的开关」。
- 浏览器侧插槽 `ctx.slots.register({ inject: (sessionId) => ({ sessionId }) }, …)` 拿到会话 id，查询与写入都带这个 id。

## 兼容性

- 需要 dsh ≥ `0.2.1-rc.2`（已在 `0.2.1-rc.2` 上实测）。
- 无网络依赖、无额外运行时依赖；只用 Node 内置模块与宿主提供的 React。

## License

MIT
