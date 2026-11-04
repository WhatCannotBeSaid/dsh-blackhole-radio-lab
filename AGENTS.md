# 项目规则

## 冻结区域：左栏底部电台卡片

状态：**冻结**。依据 2026-10-30 用户指令「提交并冻结左栏底部的电台卡片，再次修改需要二次确认」。

冻结范围：

- `client.js` 的 `StationFootCard` 与 `SidebarStation`，以及 `.bhrl-foot` / `.bhrl-fcard` 的全部样式。
- 卡片独占的播放历史状态：`PLAY_HISTORY_MAX`、`playHistory`、`playHistoryCursor`、`notePlayed`、`playPrevious`。
- 卡片上一切可见与可交互内容：站名、曲目行、星标与心标、播放/上一个/下一个/音量、折叠态 rail、音量浮层。

不冻结：面板、舞台上除黑洞与吸积盘以外的部分（电台点阵、星云、虫洞），以及 `store` / `playback` 的通用能力。但这些改动若会改变卡片行为或外观，按间接修改处理，同样需要确认。

修改流程：

1. 先说明「改什么、为什么、影响哪些可见行为」，等用户明确同意再动手。
2. 只做用户点头的那部分，不顺带重构或美化。
3. 用户说「解除冻结」后，本约定失效。

## 冻结区域：黑洞与吸积盘

状态：**冻结**。依据 2026-11-04 用户指令「现在冻结卡片和黑洞+吸积盘」。

冻结范围：

- 成像源：`src/scene/accretion-disk.js`（单 pass 统一成像）、`src/scene/geodesic.glsl.js`（逐像素零测地线追踪 shader）、`src/scene/glsl.js`、`src/scene/ray-tables.js` 与 `src/scene/ray-tables.data.js`（预计算偏折表）。
- 盘的传送：`src/scene/disc-transfer.js`。
- 对应构建产物 `client.stage.js` 中上述模块的成像部分；该文件由 `tools/build-stage.mjs` 生成，只改 `src/` 后重建，不手改产物。
- 一切可见成像特征：阴影边界、引力透镜与光子环、薄盘温度剖面与黑体配色、多普勒增亮、热斑、盘的弯曲弧线与背景透镜。

不冻结：相机与轨道（`src/scene/camera-frame.js`、`src/scene/camera-rig.js`）、舞台尺寸与装配中与成像无关的部分（`src/scene/dimensions.js`、`src/stage.js`）、电台点阵与分类分布（`src/scene/station-field.js`、`src/cluster/`）、星云与星空（`src/scene/space-haze.js`、`src/scene/starfield.js`）、虫洞过渡、盘的悬停卡 `.bhrl-hovercard`，以及 `store` / `playback` 的通用能力。这些改动若会改变黑洞或吸积盘的成像，按间接修改处理，同样需要确认。

修改流程：同「左栏底部电台卡片」节。

## 验证门：改 `client.js` 后必须求值一次

`node --check` 只证明能解析，不证明能执行。模板字符串提前闭合这类错误语法合法、运行时才炸，会让整个插件 entry 激活失败、Web 直接起不来（2026-10-30 的 `fcard is not defined` 就是这么来的）。

所以每次改 `client.js`，提交前必须按真实加载路径求值一次：

1. 在 vm 沙箱里提供 `window.__ModuleLoader__.load`，`runInContext` 求值 `client.js`，确认拿到 `id`。
2. 用 stub `require` 调用 `factory`，确认返回 `inject` 与 `apply`。

判定：顶层求值不抛错、`factory` 返回 `['inject', 'apply']` 才算通过。

已知坑：`client.js` 里的 CSS 是一段反引号模板字符串，注释或文本里提到类名时必须转义反引号（写成 `` \` ``），否则字符串提前闭合，后面的标识符被当成 tagged template 的 tag，语法照样合法。

