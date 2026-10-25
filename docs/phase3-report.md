# 阶段 3：三维流派星云空间 — 实施报告

基线 `09f5a2f`（阶段 2）。本阶段全部改动仍在工作区，**未提交、未推送**，等待验收。

## 1. 范围

实现：星云三维布局、单 draw call 粒子渲染、颜色/形态/数量映射、相机观察、悬停与选中、
标签（复用现有 overlay）、场景状态接入（`tn` / `genreId` / 相机保存恢复）、开发预览入口、测试与可视化验收。

未实现（留阶段 4/5）：黑洞点击进入星云的正式流程、`tc` 过渡、星云进入电台星团、播放器、搜索 UI 调整。
未触碰：黑洞 shader / 吸积盘 / 引力透镜、`src/radio/*`（13 类分类规则与 Repository 一行未改）、`docs/baseline/*`。

## 2. 变更清单

| 文件 | 变更 | 内容 |
| --- | --- | --- |
| `src/nebula/layout.js` | 新增 369 行 | 纯函数三维布局：固定 13 槽位、确定性抖动、分离松弛、非线性数量映射、相机 framing |
| `src/nodes/nebula-layer.js` | 新增 | 粒子生成 + 单 `THREE.Points` 渲染 + 代理球拾取（归属优先）+ 悬停/选中强调 |
| `src/stage.js` | +644 / −26 | 星云场景接入、状态机扩展、指针分流、标签调度、调试面 |
| `src/nodes/label-overlay.js` | +110 | 星云标签（名称/数量/环/刻度）、视口钳制、防重叠 |
| `src/scene/camera-rig.js` | +16 | 绝对半径上限 60 → 200，黑洞仍按模式把上限设回 60 |
| `client.js` | +8 | `?bhrlNebula=1` 开发预览参数 + 把 `visibleGenres()` 传给 stage |
| `client.stage.js` | 构建产物 | 重新生成 |
| `tools/validate-nebula.mjs` | 新增 | 80 项 Node 校验（含覆盖性 5 项） |
| `docs/nebula-harness/` | 新增 | 浏览器预览与 43 项交互验收 + 8 张截图 |

## 3. 架构决策

**拾取用归属而不是纯深度。** 见第 8 节第 3 条：按归一化距离选「这个像素属于谁」，
否则小星云被大星云圆盘覆盖时就永久不可交互。

**布局是纯数据，渲染只消费它。** `buildNebulaLayout(genres, {seed, vocabulary})` 不 import three、不碰 DOM、不查 Repository，
输出 `{ seed, count, genres[{ id, count, radius, center, color, brightness, shape, particles }], camera, extent, signature }`。
渲染层拿到什么画什么，分类算法仍在 `src/radio/`。

**槽位与数量解耦。** 13 个槽位按黄金角斐波那契球面固定，`genreId → 槽位` 由 `GENRE_IDS` 词表决定，与输入顺序无关。
某个类别消失只让它那个槽位空着，其余星云不动。未知 id 才回退到哈希槽位。

**数量映射有上下界。** `radius = 2.6 + 3.6 · (0.18 + 0.82 · (log1p(n)/log1p(max))^0.72)`：
Pop 52 与 Sports 3 的体积差被压到约 1.8 倍半径，最少的类别仍有 2.6 的基准半径（可辨识下限）。
亮度 `0.62 + 0.38·v` 用同一 `v`，所以大小与亮度同向、不会出现「大而暗」的怪组合。

**单 buffer、单 material、单 draw call。** 每个粒子带 `position / aTint / aSize / aAlpha / aSeed / aNebula / aStar`。
粒子位置一次性生成、可复现，逐帧只更新 `uTime`（亚像素级漂移在 GPU 里做），CPU 不重建几何。

**拾取与视觉解耦。** 每个星云一个代理球（半径 ×1.15），`pick(camera, ndc)` 只对 8 个球做射线求交，按交点距离取最近。
鼠标移动不遍历任何粒子。遮挡判定复用同一个 pick。

**形态来自分布而不是贴图。** 每个星云用固定种子生成：核心（指数聚拢）+ 弥散层 + 2–3 个瓣 + 各向异性拉伸 +
三角密度场挖空 + 径向 warp。所以轮廓不规则、明暗不均、有内部结构。

## 4. 接口（为阶段 4 预留，本阶段只用不推进）

```js
const handle = mountStage(container, { stations, genres, seed, nebulaPreview });
handle.enterNebula('jazz');   // 可选 genreId，进入即选中
handle.exitNebula();          // 相机恢复到进入前的黑洞机位
handle.setGenre('rock');      // 阶段 4 的分类星团导航入口
handle.state();               // { state, mode, genreId, tn, tc, progress, ... }
```

`tn` 是黑洞↔星云过渡量（0 黑洞 / 1 星云），`genreId` 是当前选中流派，进入/退出时相机位置存入
`nebulaSavedCamera` 并在退出时恢复。`tc` 已在状态里占位，本阶段不驱动。

## 5. 测试结果

| 项 | 结果 |
| --- | --- |
| `node tools/validate-nebula.mjs` | **80/80 通过**（含 coverage 5 项） |
| 浏览器验收 `window.NEBULA.run()` | **43/43 通过** |
| `validate-genres.mjs` | 通过 |
| `validate-radio-data.mjs` | 通过 |
| `validate-imaging.mjs` | 通过 |
| `validate-radio-imaging.mjs` | 通过 |
| `npm run build` | 通过（`client.stage.js` 变更） |

Node 校验覆盖：布局确定性（同种子/乱序输入/不同种子）、可见数量与顺序、严重重叠（松弛后最小间距）、
位置与半径有效、粒子分组归属与总数、数量映射上下界与单调性、拾取命中/未命中/归属优先、点击与拖动判定、
空数据与降级、不同画布尺寸下的 framing、Repository 空/单类/合并到 Other，以及覆盖性：默认视角可达每个星云、
每个星云中心自命中、6 个方位各覆盖全部星云、每个星云投影足迹 ≥3px。

浏览器验收覆盖：真实 WebGL 挂载、进入/退出星云、相机限位、悬停高亮、点击选中、拖动不误选、滚轮缩放、
标签数量与防重叠、遮挡隐藏、黑屏回归（黑洞模式渲染正常）、8 个可见星云与布局签名一致。

## 6. 性能

测量条件：1280×720（实际 1256×821 视口）、DPR 1、单次挂载后 60 帧计时、ANGLE / Intel Arc 集显 / D3D11。
数字为一次同步 `gl.finish()` 前后的墙钟均值，**不是** GPU timer query，跨运行有 ±20% 抖动。

| 指标 | 值 |
| --- | --- |
| draw call（星云模式） | **3**（吸积盘 + 星空 + 星云） |
| 粒子总数 | **30,334**（其中星云 24,000，8 个可见流派） |
| 每帧 CPU 粒子工作量 | 0（只更新 uniform） |
| 帧耗时（60 帧均值） | **9.0 – 12.6 ms**，本机多次测得 10.4 ms |

## 7. 视觉验收

截图在 `docs/nebula-harness/artifacts/`：

- `nebula-default-1280x720.png` — 默认机位，8 个星云、空间分层可读
- `nebula-angle-wide-1280x720.png` / `nebula-angle-low-1280x720.png` — 旋转后，星云不重叠、纵深自然
- `nebula-angle-close-1280x720.png` — 贴近观察，可见核心、瓣、尘埃与恒星节点
- `nebula-hover-other-1280x720.png` — 悬停 Other：环 + `其他 · 37`
- `nebula-selected-other-1280x720.png` — 选中 Other：环与标签保持
- `nebula-portrait-420x900.png` — 420×900，相机自动退远，标签仍在视口内
- `black-hole-regression-1280x720.png` — 退出星云后黑洞场景原样

主观结论：不是规则球体，边缘与内部都有结构；色相低饱和（爵士靛蓝、电子青、民谣苔绿、古典金、
新闻/谈话灰蓝），没有彩虹球；Other 是中性的灰蓝星云，形态完整，不是灰球占位。

截图左上角的 "DeepSeek" 徽标是 agent 浏览器自己的叠加层，不是页面内容。

## 8. 提交前核验（2026-10-23）

1. **数量一致**：mock Repository `visibleGenres()` = 8，星云数 = 8，拾取代理 = 8，标签 = 8。
   浏览器实测 8/8 均可悬停、均可点击选中；默认视角网格扫描覆盖 8/8。
2. **「11」与「8」不冲突**：阶段 2 报告里的 11 来自当时 240 台 **在线 Radio Browser 样本**；当前离线/mock 样本
   只落进 8 类（jazz 21 / classical 16 / electronic 24 / ambient 20 / folk-world 27 / news 55 / talk 40 / other 37）。
   代码里没有 11 或 8 的常量，布局一律用 `visibleGenres()` 的实际结果；数据变了星云数量就跟着变。
3. **每个星云都可交互**：拾取从「最近优先」改为「归属优先」——按 `射线到球心距离 / 该星云半径` 归一化比较，
   深度只在近似并列时决定次序。旧规则下，小星云落在大星云圆盘内时永远选不中它（可见但不可交互），
   这正是核验发现的缺口。改后 8/8 实测通过；13 类全量布局下，默认视角 13/13、每个中心自命中 13/13、
   6 个方位各 13/13、足迹全部 ≥3px。
4. **旋转覆盖**：12 次拖拽到不同方位，每个方位可见 7–8 个星云，并集 8/8，无遗漏。
5. **悬停清晰度（量化）**：悬停前后同帧对比，260×260 星云区域平均亮度差 4.07/255（1.6%），
   全帧 2.56% 像素变化 >8/255，最大差 188（标签环与文字）。属于「明确但不破坏低饱和」。
6. **黑洞相机边界未受影响**：黑洞 home `{min 6, max 12.87}`；连续 40 次滚轮外推停在 12.87。
   星云 home `{min 42.42, max 122.08}`，200 只是相机组件上限，星云模式没有把它用满。
7. 视觉未改动（本轮只改拾取语义与测试），第 7 节截图仍然有效。

## 9. 已知问题

1. 相机贴近到 46 单位以内（仅调试可及，生产最小 51.7）时，尘埃 sprite 会显出柔和的圆形笔触。
   生产视角下不可见，但若阶段 4 允许深入星云内部，需要再加一层屏幕空间降噪或更小的 sprite。
2. 悬停强调是刻意的：尺寸 +12%、自身 alpha ×1.55、其他 ×0.8。对本身很暗的星云（谈话/新闻）仍偏弱。
3. 标签没有引线，420px 宽度下「氛围」与「其他」靠得较近但不重叠；再窄需要优先级隐藏（已有防重叠，未做分级）。
4. 预览入口需要手动加 `?bhrlNebula=1`，正常启动行为不变，没有永久 UI 残留。
5. 性能只在单次挂载、单机型上测过，未做长时间会话的稳定性统计。

## 10. 复现

```bash
npm run build
node tools/validate-nebula.mjs
node tools/harness-server.mjs --port 8741
# 浏览器打开 http://127.0.0.1:8741/docs/nebula-harness/
```
