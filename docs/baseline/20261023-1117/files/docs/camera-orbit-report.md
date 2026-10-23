# Black Hole Radio — 相机交互修正报告

版本 0.3.1 · 2026-10-22

本次只改相机控制与相关交互：默认探索状态改为**固定黑洞中心的轨道观察**。没有重做
黑洞场景，没有改电台数据、Shader、节点分布，没有进入第四阶段，也没有接真实电台 API。

---

## 一、改了哪些文件

| 文件 | 行数 | 改动 |
| --- | ---: | --- |
| `src/scene/camera-rig.js` | 296 | 重写为 orbit-only 控制器：固定目标、左键环绕、滚轮缩放、右键平移删除、`orbit`/`focus` 两种模式、平滑退出聚焦、幂等 `dispose()` |
| `src/stage.js` | 859 | 读取黑洞实际世界坐标并传给控制器；`silhouette()` 与 LOD 改用黑洞位置；取消选择时从临时聚焦恢复默认构图；debug 增加 `holeScreen()` / `cameraPosition()` |
| `src/scene/dimensions.js` | 24 | 删除已无用的 `MAX_TARGET_OFFSET`；修正相机归宿点半径注释（r≈10.88） |
| `client.js` | 1773 | 中英文操作提示改为“左键环绕黑洞旋转 · 滚轮缩放 · 点击节点查看” |
| `README.md` | 148 | 同步相机行为、目录说明与“右键平移已禁用” |
| `client.stage.js` | — | 构建产物，575,248 B / gzip 149,200 / brotli 123,516 |
| `docs/camera-orbit-report.md` | — | 本报告 |

`client.radio.js` 没有变化（18,913 B）。`npm run build` 复跑两次均为 `changed: no`，说明
产物可复现。

---

## 二、原来的交互为什么会让黑洞漂移

旧控制器有三条互相叠加的自由路径：

1. **右键拖动直接改观察目标。** 旧 `pointerdown` 把 `button === 2` 当作 pan，`pointermove`
   用相机基向量改 `goal.target`，再把目标夹到 `targetLimit`。默认上限是 3.2 个世界单位，
   在近距离（r≈6）足以把黑洞推出画面中心。
2. **聚焦会把目标永久留在电台上。** `focusOn()` 不仅改 `goal.target`，还把 `targetLimit`
   放宽到“电台到原点的距离 + 1.5”。之后普通浏览仍围绕这个已经被移走的目标旋转，黑洞自然
   不在中心。
3. **取消选择只清数据，不清相机。** `clearSelection()` 只重置 `selectedIndex/selectedId`
   和节点层，`goal.target` 仍停在电台位置。于是“选一次、取消”就能把镜头焦点永久留在
   盘面某处。

另外，`silhouette()`（黑洞屏幕投影与标签遮罩）和 `computeLod()` 都写死用世界原点与
`camera.position.length()`。只要目标离开原点，遮罩、标签和 LOD 就会与真实黑洞位置脱节，
即使相机还在“看”某个点，画面上的黑洞也可能偏。

---

## 三、现在如何保证焦点固定在黑洞中心

### 3.1 只认黑洞的真实世界坐标

`src/stage.js:139-142`：

```js
const holeCenter = new Vector3();
if (blackHole && blackHole.object) blackHole.object.getWorldPosition(holeCenter);
const rig = createCameraRig(camera, canvas, { target: holeCenter });
```

`getWorldPosition()` 在场景组装后读取，不假设原点。当前黑洞核心在世界原点，读到
`(0,0,0)`；若以后给黑洞加父级变换，也会跟随实际位置。

### 3.2 只有三个地方能写 `goal.target`

- 构造时：写入黑洞位置；
- `focusOn(position)`：显式进入临时电台聚焦；
- `exitFocus()` / `reset()`：写回黑洞位置。

指针事件路径里没有任何 `goal.target` 赋值。左键只改 `theta/phi`，滚轮只改 `radius`。
因此普通鼠标操作无法移动观察目标，黑洞始终在 `camera.lookAt` 的中心。

### 3.3 默认模式没有平移

`camera-rig.js:82-102` 只接受 `event.button === 0`；`pointermove` 只做球坐标旋转。
右键的 `contextmenu` 仍被 `preventDefault()`。原来的 pan 分支、`PAN_SPEED`、
`targetLimit` 与 `MAX_TARGET_OFFSET` 全部删除。

### 3.4 左键环绕，滚轮以黑洞为中心缩放

- 左键拖动：`theta -= dx * 0.0052`，`phi` 夹在 `[0.24, π−0.30]`；
- 滚轮：`goal.radius = clamp(goal.radius * exp(deltaY * 0.0011), 6.0, 44.0)`，只改距离；
- 阻尼：半径、角度、目标统一用 `1 − exp(−dt·9.5)` 指数收敛，没有突然停住或跳变。

### 3.5 拖动与点击分离

控制器和舞台都用 6 px 阈值：指针移动不超过 6 px 才算点击。控制器越过阈值后先
`exitFocus()`，再开始环绕；舞台在 `pointerup` 时若位移超过 6 px 就不做命中检测。
因此从电台节点上起手拖动相机，不会误选电台。

### 3.6 电台聚焦是独立临时模式

- `focusOn()` 设 `mode='focus'`，目标缓动到电台，距离 6.4（精选 7.0）；
- 以下任一操作会退出聚焦并回到黑洞中心：
  - 左键开始环绕（`exitFocus()`）；
  - 点击“取消选择”（舞台检测到 `mode==='focus'` 后 `rig.reset()`）；
  - 点击“回到默认视角”（`rig.reset()`）。
- `reset()` 把半径、俯仰角和方位角一起恢复到 `CAMERA_HOME`，方位角用
  `nearestAngle()` 走最短路径，不会为了复位多转几圈。
- 如果在默认轨道模式下只是清空选择，不会重置用户当前视角。

### 3.7 投影与 LOD 跟着黑洞走

`src/stage.js:230-241` 的 `silhouette()` 与 `computeLod()` 改用 `holeCenter`：

```js
projected.copy(holeCenter).project(camera);
const distance = Math.max(0.1, camera.position.distanceTo(holeCenter));
```

标签遮罩、命中检测的黑洞排除区、LOD 距离都与真实黑洞一致。

### 3.8 生命周期

`createCameraRig()` 仍然只由 `mountStage()` 创建一次；`dispose()` 摘掉 6 个监听器并清空
`onChange`，重复调用安全。舞台原有的 `dispose()` 继续负责 rAF、`ResizeObserver`、
`visibilitychange`、WebGL 上下文与 canvas 移除。

---

## 四、实际验收结果

验证环境：DSH `0.2.1-rc.2`，web profile 实例 `http://127.0.0.1:19388/`，窗口
1256×821，画布 668×643。使用 ego 浏览器 + CDP 真实鼠标事件，不是只看代码。

| 验收项 | 实测 | 结果 |
| --- | --- | --- |
| 初始黑洞居中 | `holeScreen = {x:334, y:321.5, r:76.99, w:668, h:643}`，正好画布中心 | 通过 |
| 左键拖动绕黑洞旋转 | 拖动 (639,455)→(839,475)：`theta −0.777`、`phi 1.052`，`target` 仍 `(0,0,0)` | 通过 |
| 水平完整环绕 | 单次拖动 1400 px：`theta −0.777 → −8.057`，变化 7.279 rad，超过 2π 且无回绕 | 通过 |
| 垂直观察盘面 | 上拖至 `phi = 2.84158`（π−0.30），下拖至 `phi = 0.240014`（下限），黑洞始终居中 | 通过 |
| 滚轮以黑洞为中心 | 近端 `radius 6.00004`、远端 `radius 43.9995`；两端 `target=(0,0,0)`，`holeScreen` 均为 (334,321.5) | 通过 |
| 普通操作不能拖离中心 | 360 px 对角拖动加正弦上下移动后：`target=(0,0,0)`，`holeScreen=(334,321.5)`，未选中任何电台 | 通过 |
| 右键平移禁用 | 右键拖动 120×60：framing 每个字段不变，`selected=null`；`contextmenu.defaultPrevented=true` | 通过 |
| 一键恢复视角 | 点击“回到默认视角”：`radius 10.879`、`phi 1.1524`、`theta 0.2625`，黑洞居中 | 通过 |
| 搜索聚焦后恢复 | 搜 “jazz” 选 “阿姆斯特丹 频率 Jazz” → `mock-1326`、`mode=focus`、`r=6.4`；点“取消选择”回 home orbit，黑洞居中 | 通过 |
| 电台选择/筛选/命中 | 筛选爵士：`matched=310`、`strength=1`；`hitTest` 在节点投影处返回 `mock-0002`；点击后选中并聚焦；取消后回 home，筛选仍生效 | 通过 |
| 拖动不误选 | 从电台投影点拖动 112×24 px 后松开：`selected` 仍为 `null` | 通过 |
| 反复切换不重复初始化 | 10 次卸载/重挂（侧栏切换与“返回对话”各若干次）：每次关闭 `canvas=0`、重开 `canvas=1`；重开后 framing 均为 home；canvas 监听器仍是一套（pointerdown/move/up/cancel 各 2 = 控制器 + 舞台，wheel/contextmenu/pointerleave 各 1） | 通过 |
| 资源清理 | 强制 GC 后堆 69.98 MB，基线 66.64 MB；没有 canvas、监听器或 WebGL 上下文按次数累加 | 通过 |
| 构建/安装 | web profile `dependencies` 为 `link:C:/Yu/dsh-blackhole-radio`，bundle 末位新增本插件；`npm run build` 两次均 `changed: no` | 通过 |

补充：

- Node 侧控制器检查脚本 28 项全部 PASS，覆盖初始目标、左拖、右键无效、滚轮不换目标、
  min/max、水平环绕、垂直夹取、聚焦/退出、拖动退出聚焦、复位、`dispose()` 幂等。
- 渲染开销：`calls=5`、`triangles=57,858`、`points=17,134`；相机稳定后每帧 GPU 提交
  p95 约 0.3–0.4 ms（自动化环境的计时值，只作回归参照）。

---

## 五、仍需人工确认的项目

1. **桌面宿主需要刷新或重启。** 桌面 profile 早已以 `link:` 安装本插件，但当前运行中的
   宿主加载的是旧 chunk。构建已更新 `client.js` 的 revision；刷新页面即可拿新 chunk，
   若宿主缓存了模块则重启 DSH。自动化验证跑在全新启动的 web profile 实例上。
2. **真实鼠标/触控板手感。** 阻尼、6 px 点击阈值、滚轮速度在自动化里只能验证数值，
   实际手感需要在桌面上拖几次确认。
3. **`reducedMotion` 模式。** 代码在相机收敛期间会继续调度帧（`rig.update()` 返回
   `moved`），但本次没有单独把 Host 配置切成 `reducedMotion: true` 做人工复测。
4. **一次未复现的异常。** 自动化中曾有一次“搜索结果聚焦后点取消”把 `phi` 留在 0.9288
   （半径和方位角已回 home），紧接着 `reset()` 正常，重复同样流程三次均精确回 home。
   怀疑是自动化指针事件的瞬时残留，未能复现；后续若再次出现，应检查取消点击与
   `pointermove` 的竞争。

---

## 六、结论

默认状态现在只有一个观察焦点：黑洞的世界坐标。左键绕它转，滚轮朝它缩放，右键和
任何平移路径都不再存在；电台聚焦是显式的临时模式，取消或开始环绕都会回到黑洞中心。
搜索、分类筛选、点击选择、命中检测与页面反复切换均保持原行为，构建产物可复现。
