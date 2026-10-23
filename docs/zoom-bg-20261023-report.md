# 黑洞电台 · 缩放边界与全方向背景参照

日期：2026-10-23
目录：`C:\Yu\dsh-blackhole-radio-lab`
构建：client.stage.js 2,070,462 B（gzip 1,086,226 / brotli 911,599）

---

## 1. 实际原因

### 1.1 拉得过远

不是滚轮坏了，是上限写死。

`src/scene/camera-rig.js` 里 `MAX_RADIUS = 44`，`src/stage.js` 把 `HOLE_LIMITS.maxRadius` 也定成 44。44 与画布尺寸无关：1280x720 下阴影直径只剩短边的约 12%（85 px / 720），视觉上是一个点浮在空场里。滚轮、阻尼插值本身正常，边界也正常，只是那个边界太远。

另外两处次级问题：

- 窗口变窄后（展开左栏、缩放窗口）上限不会跟着重算，旧值仍生效；
- 从星团返回黑洞时用的是 `machine.savedCamera` 的历史半径，不检查它是否已超过新上限。

### 1.2 只有一面能看出透镜

不是背景没参与引力透镜，是背景内容只铺了一条带。

全方向都走同一条路径：像素射线 → 偏折 → 逃逸时按 `dPrime` 采样天空（`color = (backgroundDiffuse(dPrime) + backgroundStars(dPrime, starFlux) * starTrust) * critFade;`），`dirFromFace` 用立方体六面网格，没有背面剔除，没有方向映射错误，也没有接缝。

问题在 `backgroundDiffuse`：

```glsl
float band = exp(-pow(dot(dir, bandNormal) / 0.34, 2.0));   // 约 ±19° 的一条银河带
vec3 ambient = vec3(0.0042, 0.0052, 0.0090) * (0.55 + 0.9 * mottle);  // 带外近黑
```

所有漫射亮部都在那一条带里，带外几乎是 0。星点又只有两层、阈值 `h < 0.90` 且整体乘 0.55，稀疏到无法承担参照。俯仰一转出带，画面就是黑的。

对照证据：同一 shader 下 `theta=1.57` / `theta=4.71` 的灰色雾状星河能清楚显示扭曲，`theta=0.10` / `theta=3.14` 全黑；`phi` 从 1.3 抬到 2.6，平均亮度从 53.6 升到 100.7，正好随带的位置变化。是分布问题，不是路径问题。

还有一处容易误判的：`starfield.setDim(rise)` 在黑洞模式（`progress=0`）下 `rise=0`，three.js 的 `Points` 星场完全隐藏。画面上所有星点都来自 shader。所以调 `starfield.js` 的亮度不会有任何效果。

---

## 2. 修改文件

| 文件 | 改动 |
| --- | --- |
| `src/scene/dimensions.js` | 新增 `maxOrbitRadiusForShadow(options)`：按 `shadow diameter >= fraction * min(w,h)` 反解最大轨道半径，二分 40 次。 |
| `src/scene/camera-rig.js` | 新增 `setLimits(limits)`；`update(dt)` 在阻尼前对 `goal.radius` / `state.radius` 再夹一次；`setHome` 里对 `home.radius` 按新上限夹一次。 |
| `src/stage.js` | `HOLE_LIMITS` 拆成 `HOLE_MIN_RADIUS` / `HOLE_MAX_RADIUS` / `SHADOW_SHORT_EDGE_FRACTION = 0.2`；新增 `holeOrbitLimits()`；`applySize()` 末尾对黑洞模式调 `rig.setLimits(...)`；`exitCluster()` 用 `holeOrbitLimits()`。 |
| `src/scene/geodesic.glsl.js` | `backgroundDiffuse` 新增全天亮底与柔和星云 veil（银河带保留、略加宽到 0.42）；`backgroundStars` 加第三层细星尘。 |
| `client.stage.js` | 构建产物（`npm run build`）。`client.radio.js` / `client.js` 无实质变化。 |

未动：渲染管线结构、电台目录、播放、左栏布局、弧线修复、desktop profile、`docs/baseline/*`。
修改前副本：`C:\Work\scratch\bh-zoom-bg-20261023\orig\`（camera-rig.js / geodesic.glsl.js / dimensions.js / stage.js / starfield.js / client.stage.js，含 sha256 清单）。

---

## 3. 最终缩放参数与依据

**上限不再写死，按画布短边反解。** 约束是「阴影直径 ≥ 画布短边 × 0.20」。

`shadowScreenFraction(r, fov)` 返回的是「阴影半径 / 视口半高」，所以约束等价于

```
shadowScreenFraction(r) >= 0.20 * min(w, h) / h
```

（半径要求是直径的一半，半高也是高的一半，两个 0.5 抵消。）

实测结果（fov 42°）：

| 画布 | 最大半径 | 最大拉远时阴影直径 / 短边 |
| --- | --- | --- |
| 1280x720 | 12.867 | 20.0% |
| 1440x900 | 12.867 | 20.0% |
| 1920x1080 | 12.867 | 20.0% |
| 1000x600 | 12.867 | 20.0% |
| 950x755 | 12.867 | 20.0% |
| 620x755 | 15.697 | 20.0% |
| 900x1200（竖屏） | 17.200 | 20.0% |

横屏下都收敛到 12.867，因为限制来自高度方向，而 12.867 是解析解（不是调出来的数）。

**盘构图同时检查过**：12.867 处吸积盘外缘（12 Rs = 4.6188）投影到半高的 0.935，整盘落在画面内；而默认 8.2007 处盘是被上下裁切的。也就是说最大拉远不但没把构图拉散，反而给了盘一个完整入画的构图。

保留项：默认视角（radius 8.2007 / phi 1.5219 / theta 0.1047）、最近距离 6.0、自由旋转、`resetView()` 回默认，全部未变。

边界行为：滚轮在 `onWheel` 里夹、`update(dt)` 里再夹、`setLimits` 里再夹，三层保证插值不会越界；到达上限后 `goal.radius` 不再变化，所以停在原地不会抖；反向滚轮直接改 `goal.radius`，阻尼从当帧开始回拉。

---

## 4. 背景改动细节

`backgroundDiffuse` 现在是三层相加：

```glsl
// 全天亮底（原来是带内才有的暗部）
vec3 ambient = vec3(0.0075, 0.0088, 0.0145) * (0.62 + 0.85 * mottle);
// 全向柔和星云：低频、平滑、低对比
float nebula = fbm3(dir * 1.35 + vec3(-5.3, 2.7, 8.1));
float veil = smoothstep(0.26, 0.88, 0.72 * nebula + 0.28 * mottle);
vec3 veilColor = vec3(0.0190, 0.0180, 0.0280) * veil * (0.45 + 0.55 * mottle2);
// 原先的银河带，保留并略加宽
return ambient + veilColor + bandColor;
```

只多了一次 `fbm3`，`mottle` / `mottle2` 复用。veil 用 `smoothstep` 加低频噪声，是为了在临界曲线附近绕转时不出现细网格走样。

`backgroundStars` 加第三层：`starLayer(scaled, 96.0, 0.0022, 0.16, 2.0)`，整体系数 0.55 → 0.62。三层分别是亮星、中星、细星尘，让每个方向都有星点可当偏折参照，强度逐层递减，不抢盘。

三条硬约束都守住了：没有提高阴影亮度（阴影区仍为纯黑）、没有加整体曝光（`toneMappingExposure` 未动）、没有屏幕空间叠加（全部在 `dPrime` 采样后合成）。也没有用自动旋转掩盖问题。

---

## 5. 前后截图

同参数（harness，1280x720，pixelRatio 1，seed 20261022）：

- `docs/screenshots/zoom-bg-20261023/default-before-after.png` — 默认视角
- `docs/screenshots/zoom-bg-20261023/max-zoom-before-after.png` — 最大拉远（旧上限 44 vs 新 12.867）
- `docs/screenshots/zoom-bg-20261023/dark-directions-before-after.png` — 三行：theta 0.105 / theta 3.14 / phi 1.52

原始单图：`docs/screenshots/zoom-bg-20261023/raw/`。

DSH 实机页（1256x821，含真实侧栏，侧栏收起时画布 1200x821）：

- `docs/screenshots/zoom-bg-20261023/dsh-before-after.png` — 默认 / 最大拉远 / 1100x700 最大拉远 + 三个原全黑方向
- `docs/screenshots/zoom-bg-20261023/dsh/` — 30 张单图，含侧栏展开 976 宽、resize、反向缩放、恢复默认

---

## 6. 验证结果

### harness（软件渲染 swiftshader，1280x720）

| 项 | 结果 |
| --- | --- |
| 初始上限 | `framing().home.maxRadius = 12.866897`，默认 radius 8.2007 不变 |
| 连续滚轮到边界 | wheel×60 → 12.867，再 ×10 仍 12.867 |
| 反向响应 | 一格反向 120 ms 内 11.4662 |
| 阴影直径（像素实测） | 默认 232 px = 32.2%；最大拉远 153 px = 21.2%（含光子环亮带，几何值 20.0%）；反向 26.8% |
| 方向亮度（环形区均值） | dir0 20.04→28.86、dir1 46.81→62.06、dir2 19.80→29.14、dir3 43.02→57.55、phi1.52 20.32→29.16、phi2.6 100.69→101.65 |
| 接缝/突变 | 12 个方向 lit 像素占比均 100%，无大片缺失 |
| 构建 | `npm run build` 通过，client.stage.js 2,070,462 B |
| 成像回归 | `node tools/validate-imaging.mjs` → ALL CHECKS PASSED（deflection 62/62、capture 21/21、inverse radius 73/73 等） |
| 电台成像回归 | `node tools/validate-radio-imaging.mjs` → RADIO FIXTURE CHECKS PASSED（fixtures 4、checks 69） |
| 控制台 | 仅既有 X4000 `f_sampleTable_int2` 警告，本次未新增 |

### DSH 实机（真实浏览器，插件页）

| 项 | 结果 |
| --- | --- |
| 初始状态 | canvas 1200x821，max 12.8669 / min 6 / radius 8.2007，阴影 256 px = 31.2% |
| 连续滚轮到边界 | ×40 → 12.8669，再 ×10 仍 12.8669 |
| 反向响应 | 一格反向 150 ms 内 10.483，1.5 s 后 9.881 |
| 最大拉远阴影 | 164.2 px / 821 = 20.0% |
| 左栏展开（976x821） | max 仍 12.8669，最大拉远 20.0%，默认 31.2% |
| 左栏收起（1200x821） | 同上，构图回到展开前 |
| 窗口 1100x700 | canvas 1044x700，max 12.8669，阴影 140/700 = 20.0% |
| 窗口 1400x900 | canvas 1344x900，max 12.8669，阴影 180/900 = 20.0% |
| 三方向 | theta 0.10 / 3.14 / 4.71 均可见星点与云纹，无黑屏、无接缝 |
| 电台搜索 | 「打开搜索」→ 输入 jazz → 命中「Jazz Radio 法国·爵士乐」→ Esc 关闭正常 |
| 恢复默认 | `reset()` 回 8.2007，画面回到默认构图 |

### 未验证 / 未做

- 触摸板双指缩放、触屏 pinch 未单独走一遍（只验了 wheel 事件）。
- 未做全俯仰 360° 每 15° 的连续扫描，只抽了 phi 1.30 / 1.52 / 2.00 / 2.60 与 az 0.7 / 2.3 / 3.9 / 5.5。
- Firefox / Safari 未测。
- 「边旋转边缩放」同时操作下的边界未单独压测（单通道行为已验）。
- 实机验证期间临时把 web profile 的 link 指向 lab（为在真实前端看 lab 版），现已还原：`package.json` 恢复为备份内容、临时 junction 已删，旧链接与旧仓库未动。desktop profile 全程未改。

---

## 7. 复现命令

```bash
cd C:/Yu/dsh-blackhole-radio-lab
npm run build
node tools/validate-imaging.mjs
node tools/validate-radio-imaging.mjs
node tools/harness-server.mjs --port 8743   # 打开 http://127.0.0.1:8743/docs/radio-gpu-harness/
python C:/Work/scratch/bh-zoom-bg-20261023/probe_after.py
python C:/Work/scratch/bh-zoom-bg-20261023/probe_layout.py
```
