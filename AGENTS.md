# 项目规则

## 冻结区域：左栏底部电台卡片

状态：**冻结**。依据 2026-10-30 用户指令「提交并冻结左栏底部的电台卡片，再次修改需要二次确认」。

冻结范围：

- `client.js` 的 `StationFootCard` 与 `SidebarStation`，以及 `.bhrl-foot` / `.bhrl-fcard` 的全部样式。
- 卡片独占的播放历史状态：`PLAY_HISTORY_MAX`、`playHistory`、`playHistoryCursor`、`notePlayed`、`playPrevious`。
- 卡片上一切可见与可交互内容：站名、曲目行、星标与心标、播放/上一个/下一个/音量、折叠态 rail、音量浮层。

不冻结：面板、舞台、星云、虫洞，以及 `store` / `playback` 的通用能力。但这些改动若会改变卡片行为或外观，按间接修改处理，同样需要确认。

修改流程：

1. 先说明「改什么、为什么、影响哪些可见行为」，等用户明确同意再动手。
2. 只做用户点头的那部分，不顺带重构或美化。
3. 用户说「解除冻结」后，本约定失效。

## 验证门：改 `client.js` 后必须求值一次

`node --check` 只证明能解析，不证明能执行。模板字符串提前闭合这类错误语法合法、运行时才炸，会让整个插件 entry 激活失败、Web 直接起不来（2026-10-30 的 `fcard is not defined` 就是这么来的）。

所以每次改 `client.js`，提交前必须按真实加载路径求值一次：

1. 在 vm 沙箱里提供 `window.__ModuleLoader__.load`，`runInContext` 求值 `client.js`，确认拿到 `id`。
2. 用 stub `require` 调用 `factory`，确认返回 `inject` 与 `apply`。

判定：顶层求值不抛错、`factory` 返回 `['inject', 'apply']` 才算通过。

已知坑：`client.js` 里的 CSS 是一段反引号模板字符串，注释或文本里提到类名时必须转义反引号（写成 `` \` ``），否则字符串提前闭合，后面的标识符被当成 tagged template 的 tag，语法照样合法。

