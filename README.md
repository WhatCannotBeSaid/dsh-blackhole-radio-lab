# Black Hole Radio

DSH 的独立电台页面插件。最终形态是一块可旋转、可缩放的 3D 黑洞舞台：全球网络电台分布在吸积盘、光子环与外围空间。

**当前进度：第四阶段（黑洞交互入口与三维星团模式）已完成。** 默认是一整块可环绕、可缩放的黑洞系统，2,400 条模拟电台嵌在吸积盘里，页面上没有常驻搜索栏或分类侧栏：点击黑洞中心进入搜索，停留约 600 ms 展开分类面板，选择分类后黑洞、光子环与吸积盘消隐，该分类的电台在同一个主页中央重组成具有真实三维体积的星团；`Esc` 或左上返回键平滑退回黑洞。仍是模拟数据，不含真实电台接口与播放功能。

## 现在有什么

- 侧栏一个独立入口「黑洞电台」，带自绘图标，跟随应用语言。
- 一个占满 `main` 区域的深色页面，中间是黑体、光子环与吸积盘；没有常驻搜索栏、分类侧栏或大型悬浮面板。
- 左键拖动围绕黑洞旋转、滚轮以黑洞为中心缩放，阻尼收敛；右键平移已禁用，可一键回到默认视角。镜头焦点固定在黑洞核心，电台聚焦只是临时模式，拖动或取消即回到黑洞中心。
- 点击黑洞中心打开搜索框（自动聚焦），支持名称 / 国家地区 / 语言 / 分类；`Esc` 或点击遮罩关闭。搜索与分类筛选互相独立，输入搜索词不会进入星团。
- 指针在黑洞中心停留 600 ms 展开分类面板（渐显 240 ms），面板位于黑洞右侧、不遮挡中心点击区；指针移入面板不会关闭，离开后 320 ms 收起。触屏用长按 560 ms 等价打开，键盘可聚焦中心按钮后按 Enter 搜索。
- 选择分类后进入星团模式：黑洞核心、光子环与吸积盘在 0.8–1.5 s 内消隐，该分类的电台沿三维路径收拢成中心致密、外围稀疏的星团，未命中分类的电台淡出；相机目标平滑移到星团中心，可继续环绕与缩放。
- 星团是真实三维体积（径向密度 `u^1.9`、三条种子纤维、垂直压扁 0.82），每站 5 个微 sprite 在目标处散成 2–5 px 的小星结，因此 300–600 台也能形成颗粒感；电台 ID 仍是 `mock-####`。
- 星团里点击星点选中并显示左下详情卡（演示数据标注、稳定 ID、国家、语言、分类、简介），可聚焦或取消；`Esc` 与左上「黑洞」返回，返回时电台沿同一曲线散回吸积盘，相机回到黑洞默认视角。
- 2,400 条确定性模拟电台（种子固定）：全部落在 1.54–3.65 R 的盘带内，18 条精选位于 1.66–1.79 R 的内环弧上；默认不按分类分区。
- 单个 `Points` + 一个自定义 `ShaderMaterial` 承载全部节点；节点颜色、大小、透明度都是实例属性，不做逐电台 Mesh。
- 搜索跨模式工作：在星团内搜索其他分类的电台时，先平滑切到该分类的星团，再聚焦目标；稳定 ID 与坐标映射不变。
- 远中近三级 LOD：远看是连续的环状亮带与局部密度起伏，中距能分辨盘面亮结与微云块，近距才看清单个电台与附近名称。标签画在一张 2D canvas 上，不进 DOM。
- 面板左上显示词标、阶段与演示数据标记，右下角一行克制的操作提示；没有读数侧栏。
- 全部 3D 代码打成 `client.stage.js`，模拟数据与检索打成 `client.radio.js`，**只在打开面板时才下载**；关闭面板即停循环、丢上下文、清资源。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半。加载入口 + 配置校验 + 配置路由 + 卸载清理。 |
| `client.js` | 浏览器半。React 组件、样式、槽位注册、字典注册、搜索/过滤/详情 UI、懒加载入口、卸载清理。 |
| `src/stage.js` | 渲染模块入口：建 renderer/场景/相机，串起各部件，管理 rAF、指针拾取与释放。 |
| `src/scene/dimensions.js` | 全套尺寸常量（阴影、光子环、盘内外径、相机归宿点）。 |
| `src/scene/glsl.js` | 共用 GLSL 噪声与色调映射 include。 |
| `src/scene/black-hole.js` | 事件视界：纯黑球，负责遮住背后的东西。 |
| `src/scene/photon-ring.js` | 光子环：朝向相机的面片 + 径向剖面着色器。 |
| `src/scene/accretion-disk.js` | 吸积盘：极坐标网格 + 噪声条纹 + 远侧内缘抬升。 |
| `src/scene/starfield.js` | 三层球壳星点，带视差、闪烁与色温差异。 |
| `src/scene/camera-rig.js` | 手写黑洞中心轨道相机：固定焦点、环绕/缩放、阻尼、夹取、重置、临时电台聚焦与退出。 |
| `src/nodes/stations-layer.js` | 电台微结构层：单 Points、盘面剪切场着色、柱坐标云团形变、星团形态与稳定命中、选中环。 |
| `src/cluster/layout.js` | 星团布局：按分类取成员、径向密度、纤维拉偏、相机取景与离线投影测量。 |
| `src/nodes/label-overlay.js` | 2D canvas 标签层：选中环、近处电台名、显影云团名，屏幕空间避让。 |
| `src/radio/random.js` | `mulberry32` 与字符串哈希，确定性随机。 |
| `src/radio/taxonomy.js` | 八类分类、国家/语言池、展示色。 |
| `src/radio/names.js` | 电台名与简介的拼装词表。 |
| `src/radio/station.js` | 规范化 `RadioStation` 模型、逐条确定性生成与 `generateCatalog`。 |
| `src/radio/distribution.js` | 稳定空间分布：单一混合盘场 + 密度结 + 内环精选弧 + 分类云心。 |
| `src/radio/repository.js` | `RadioStationRepository` 接口 + `MockRadioRepository` 实现（列表、按 ID、搜索、分类计数）。 |
| `src/radio/index.js` | 数据层对外入口，`client.radio.js` 的打包入口。 |
| `tools/build-stage.mjs` | 用 esbuild 把两个入口分别打成自包含 chunk。 |
| `client.stage.js` / `client.radio.js` | **构建产物**，不要手改。 |
| `cordis.patch.yml` | bundle 补丁层，一行 loader 条目。 |
| `locale/zh.json` / `locale/en.json` | 插件显示名与描述。 |
| `icon.svg` | 侧边栏与插件列表图标，`currentColor` 跟随主题。 |

## 构建

```bash
npm install        # 首次：three + esbuild
npm run build      # 产出 client.stage.js 与 client.radio.js
```

产物是 DSH 包内动态 chunk：

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-blackhole-radio-lab',
  chunk: 'client.stage.js',
  factory(require) { /* three 已被内联，无裸模块请求 */ },
});
```

`client.js` 通过 `require.async('./client.stage.js')` 与 `require.async('./client.radio.js')` 按需拉取。构建脚本会顶一下 `client.js` 的 mtime，因为 chunk 的 URL 取自入口包的 revision——不顶这一下，浏览器会拿 immutable 缓存里的旧 chunk。

**只改 `src/` 里的文件，然后 `npm run build`。** 不要在 `client.js` 里 `import 'three'`：浏览器侧没有 `three` 的基座模块，解析会直接失败。

## 配置

`cordis.patch.yml` 的条目上可挂 `config`：

```yaml
- insert:
    - id: blackhole-radio-lab
      name: '@local/dsh-blackhole-radio-lab'
      config:
        antialias: true        # WebGL 抗锯齿
        pixelRatioCap: 2       # 渲染倍率上限，1–4
        reducedMotion: false   # 关闭动画，只渲染单帧
        showHints: true        # 显示提示文字
        stationCount: 2400     # 模拟电台数量，200–20000
        seed: 20261022         # 数据与空间分布随机种子
        featuredCount: 18      # 精选电台数量，4–40
```

未提供的键回落到 `index.js` 里的 `DEFAULTS`。调试时也可以给面板 URL 加 `?bhrlStations=5000` 临时覆盖数量。

## 数据接口

```js
import { createMockRadioRepository } from './src/radio/index.js';

const repo = createMockRadioRepository({ count: 2400, seed: 20261022, featuredCount: 18 });
repo.list();                    // RadioStation[]
repo.byId('mock-0161');         // RadioStation | null
repo.search('东京', { limit: 8 }); // 名称 / 国家 / 语言 / 分类
repo.categories();              // [{ id, label, count, color }]
repo.anchors();                 // 分类计数与云心（3D 只用于标签定位）
```

第四阶段接真实数据时，实现同一个接口替换 `createMockRadioRepository` 即可；舞台只消费 `list()`（含 `position` 与 `metadata.layout/clouds`）与 `anchors()`，不读生成逻辑。

## 安装

```bash
cd "$DSH_HOME/profiles/<profile>"
dsh plugin --profile <profile> add "C:/Yu/dsh-blackhole-radio-lab"
```

装完必须重启 DSH。桌面端进程没有 profile 监听器，不会自己发现新 bundle；重建 chunk 之后同理——revision 是启动时算的。

## 卸载

```bash
dsh plugin --profile <profile> remove @local/dsh-blackhole-radio-lab
```

或直接从 profile 的 `package.json` 中删掉 `dependencies` 里的这一项和 `dsh.profile.bundles` 里的这一行，再重启。两边都会清掉：Host 路由随插件 fiber 释放，客户端槽位条目与 `<style id="bhrl-styles">` 一起移除。

## 架构约束

- 原生 Three.js，不用 React Three Fiber。
- 面板是注册进 `main` 槽的 React 组件，**不是 iframe**：iframe 会丢掉主题变量和语言。
- Host 半零运行时依赖，`link:` 进 profile 即可；重活全在浏览器侧的 chunk 里。
- 不碰 DSH 核心文件、不改原生布局、不覆盖其他插件。
- 不要求任何 `@deepseek-ai/dsh-client-*` 包作为模块；那会让槽位直接崩掉。
- 不改 Host 静态路由，不引 CDN：Three.js 是插件自己的私有依赖。
- chunk 必须自包含，不能同步 `require` 另一个相对路径的 `client*.js`。
- 电台 ID 与 Three.js 实例索引分离：`idToIndex` 映射由舞台维护，过滤与排序不改基础位置。
- 数据层（`src/radio/`）不 import three；渲染层（`src/nodes/`）不生成数据。

## 渲染模块接口

`mountStage(container, settings)` 返回 `{ info, resetView, selectById, focusById, clearSelection, locateStation, setInteraction, enterCluster, exitCluster, setCategoryFilter, setLanguage, state, holeScreen, selection, dispose }`：

- `info`：`{ phase, antialias, pixelRatio, triangles, stars, stations, featured, categories, animated }`，给面板读数用。
- `state()`：`{ state, mode, ui, categoryId, progress, transitioning, stations }`，`state` 为 `black-hole / search / category-panel / transition-to-cluster / cluster / transition-to-black-hole` 之一。
- `setInteraction(ui)`：面板把 `search` / `category-panel` / `black-hole` 写回舞台，用于统一 hover、点击与 Esc 的优先级。
- `enterCluster(categoryId)` / `exitCluster()`：启动形态转换；重复调用会从当前进度反向或改道，不并行改同一批对象。
- `locateStation(id)`：跨模式定位——目标在当前场景直接聚焦，否则先平滑进入其分类星团再聚焦。
- `selectById(id, { focus, notify })`：按稳定 ID 选中，可选聚焦与回调；`notify` 默认 `false`，避免搜索选择回灌成点击事件。
- `setCategoryFilter(ids)`：传空数组恢复全部；返回是否有变化。星团模式下忽略。
- `dispose()`：幂等。停 rAF、断开 `ResizeObserver`、摘掉网格、dispose 几何/材质/renderer、`forceContextLoss()`、移除两根 canvas。
- `settings`：`{ antialias, pixelRatioCap, reducedMotion, stations, seed, categories, language, onSelect, onMode, onCenterClick, onHoverChange }`，同一对象复用，避免 effect 重启。

## 第五阶段前置

1. Radio Browser API 的 Host 侧代理与缓存，实现 `RadioStationRepository` 的真实版本。
2. 音频播放与电台在 3D 空间中的锚定（`mountStage` 的 `stations[].position` 已是稳定坐标）。
3. 真实播放状态、收藏与账号——前四阶段全部未做。
