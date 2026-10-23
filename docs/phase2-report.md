# 第二阶段报告：盘面电台源接入与成像/拾取验证

- 项目：`C:\Yu\dsh-blackhole-radio-lab`
- 日期：2026-10-23
- 上一基线：`docs/baseline/20261023-1117`（57 文件，未修改）
- 判定：**部分通过**。两个已核实缺陷已修复并有 GPU 证据；近侧与远侧源的成像位置命中 CPU oracle；近轴源、弱场源、颜色验收、视口/重置一致性未通过。GPU 整体验收**未完成**。

## 1. 结论

本次实测（真实 WebGL 2，Helium/Chromium，1280×720，DPR=1）：

1. `createRayTables().dispose()` 修复成立：两张表纹理上传后 `gl.isTexture` 为 true，dispose 后为 false，重复 dispose 不抛异常。
2. `QUERY_RESULT_DISJOINT` 已从 `getQueryParameter` 调用点移除；disjoint 判定保留在 `getParameter(GPU_DISJOINT_EXT)`，查询在帧循环、`dispose()` 与上下文丢失时都会被删除。
3. 近侧源：GPU 锚点 `(850.0, 376.5)`，CPU oracle `(851.1, 376.84)`，差 1.1 px，`branch 1`。
4. 远侧源：GPU 锚点 `(384.5, 339.5)`，CPU oracle `(384.01, 339.59)`，差 0.5 px；但 GPU 报告 `branch 2`，夹具规格里的预期标签 `branch 1` 未命中——分支编号约定需要按 shader 语义重新标定（见 §9.1）。
5. 近轴源：只得到 7 个 1–2 px 的碎片，分布在 y≈225.5 与 y≈489.5–491.5；CPU oracle 的两条弧质心在 y=210.8 与 y=505.4（相差 14–15 px）。不通过。
6. 弱场源：GPU 上完全无 id 像素（掩码隔离 `ids=[]`）。不通过。
7. 颜色：截图中锚点采样全部是页面背景色 `[3,4,8]`，主画布没有进入合成帧，颜色验收**未取得有效数据**。现有色相检查因此有 1 项假通过（背景偏蓝被判成 blue），不得据此宣称颜色通过。
8. 未取得 GPU 计时扩展（`EXT_disjoint_timer_query_webgl2` 为 null），本阶段不报告任何 FPS/GPU 毫秒数。

## 2. 环境

| 项 | 值 |
| --- | --- |
| OS | MINGW64_NT-10.0-26200 3.6.10 x86_64 |
| Node | v24.19.0 |
| 浏览器 | Helium（Chromium），WebGL 2.0 / GLSL ES 3.00 |
| GPU 计时扩展 | 不可用（`timerExt = null`） |
| 版本控制 | 无（项目与 `C:\Yu` 都不是 Git 仓库） |
| 标准条件 | 1280×720、DPR=1、`pixelRatioCap=1`、`antialias=false`、`reducedMotion=true`、seed 20261022、无电台目录（`?bhrlStations=0`） |

## 3. 修改文件与职责

| 文件 | 变更 |
| --- | --- |
| `src/scene/ray-tables.js` | `createRayTables()` 返回幂等 `dispose()` 与 `disposed` getter，释放两张 RG32F 表纹理 |
| `src/stage.js` | `collectGpuTimings` 去掉无效查询参数、新增 `discardGpuQueries()`；帧循环/`dispose()`/`onContextLost` 清理查询；夹具挂载、锚点扫描、`pickRadio`、点击优先、`handle.radio`、debug v6 |
| `src/scene/geodesic.glsl.js` | 新增 `RADIO` 段（`radioAtCrossing`）、`uProbeRect` 探针窗口、电台合成与可见 ID、probe 26–32 |
| `src/scene/accretion-disk.js` | `setRadio/getRadio`、`RADIO_SLOTS=4`、`uProbeRect`、`probe({region,radioMask,unpack})`、暴露 `tables` |
| `src/scene/radio-fixtures.js` | 新增：四条夹具、业务 ID/GPU ID、世界→shader 换算、选择解析 |
| `src/nodes/radio-overlay.js` | 新增：夹具标签与选中环，锚定实际成像位置 |
| `client.js` | `?bhrlRadio=` 开关；`stageSettings.radio` |
| `tools/validate-radio-imaging.mjs` | 新增：CPU 夹具规格与 oracle 校验（69 项） |
| `docs/radio-gpu-harness/*` | 新增：真实 GPU harness 页面、驱动脚本、产物 |
| `client.stage.js` / `client.radio.js` | 构建产物更新（`client.radio.js` 未变） |

只读外部数据：无。测地线表未重生成（revision 仍为 `e72b3f29…`）。

## 4. 数据与 Shader 接口

夹具（世界单位，静止源，`motion: static`，`patchRadius = 0.04`）：

| kind | 业务 ID | GPU ID | r | φ | 颜色（线性） | shader 中心 | shader 半径 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| near | `radio-near-side` | 101 | 2.6 | 0.654698 | (1, .62, .28) | (1.5832, −2.0624) | 0.1039 |
| far | `radio-far-side` | 102 | 3.2 | 3.796291 | (.30, .80, 1) | (−1.9485, 2.5383) | 0.1039 |
| axis | `radio-near-axis` | 103 | 1.6 | 3.246291 | (1, .30, .85) | (−0.1672, 1.5912) | 0.1039 |
| weak | `radio-weak-field` | 104 | 4.2 | 1.604698 | (.45, 1, .45) | (4.1976, 0.1424) | 0.1039 |

- 世界→shader：`(x, y, z)_shader = (x, −z, y)/RS`，`RS = 0.3849001795`。
- 源频移：`g_static = sqrt(1 − u_src)/sqrt(f)`，`flux = g_static⁴`；不复用吸积盘的 Kepler/Doppler 公式。
- 覆盖：`filteredPulse(0, radius, |p − center|, min(footprint, radius·0.35))`；`cov < 0.05` 不计。
- 合成：`a = cov · coverCross`，`premul += color · gain · flux · a`，`cover = 1 − (1 − cover)(1 − a)`；先远交点、后近交点。
- 可见 ID：`effFar = lumFar · (1 − coverNear)`；近交点亮度 ≥ `effFar` 时归属近交点，否则远交点；`gpuId = 0` 表示无电台。
- probe 新增编号：26 可见 ID、27 可见分支、28/29 两交点的电台覆盖、30/31 两交点电台亮度、32 可见亮度。原 1–25 未改动。
- 探针窗口 `uProbeRect`：`xy` 为左下角像素原点、`zw` 为尺寸；全帧探针时保持 0，输出与原实现逐位一致。

## 5. 两个缺陷的修复证据

### 5.1 表纹理释放

harness `unitTableRelease()`：用 ShaderMaterial 采样两张表触发上传，记录 `renderer.properties.get(tex).__webglTexture`，再 `tables.dispose()`：

```
PASS both ray tables upload to the GPU | new textures=2 alive=[true,true]
PASS table textures released by dispose() | alive=[false,false]
PASS dispose() is idempotent |
PASS main stage dispose marks its tables disposed | disposed=true
PASS main stage dispose removes its canvas |
```

`gl.isTexture(name)` 是驱动层判据，不是"没抛异常"。按 512×512×8 B + 64×32×8 B 计，每挂载周期泄漏的 2,113,536 B 不再发生。

### 5.2 无效查询参数与查询清理

- 删除的是 `getQueryParameter(query, QUERY_RESULT_DISJOINT)`；WebGL 2 该入口只接受 `QUERY_RESULT` 与 `QUERY_RESULT_AVAILABLE`。
- 保留：`QUERY_RESULT_AVAILABLE` 轮询、`QUERY_RESULT` 取值、`getParameter(timerExt.GPU_DISJOINT_EXT)` 全局 disjoint 判定。
- 清理：`discardGpuQueries()` 在 disjoint 分支、`dispose()`、`onContextLost` 各调用一次，逐帧删除已取结果的查询。
- 影响表述：修复前该调用每帧产生一次 `INVALID_ENUM`，但计时样本未被它污染（真正的 disjoint 判定在别处）——这一点在第一阶段已核实，本次未改口径。

## 6. 运行条件与复现

```bash
# CPU（纯 CPU，无 GPU 依赖）
node tools/validate-imaging.mjs            # 197/197，ALL CHECKS PASSED
node tools/validate-radio-imaging.mjs      # 69 项，RADIO FIXTURE CHECKS PASSED
node tools/validate-radio-imaging.mjs --write   # 重写 expected.json

# GPU（真实浏览器）
node tools/harness-server.mjs              # 端口 8741，只读静态服务
node C:/Work/scratch/bhrl-harness-run.mjs \
  http://127.0.0.1:8741/docs/radio-gpu-harness/ \
  C:/Yu/dsh-blackhole-radio-lab/docs/radio-gpu-harness/artifacts
```

夹具启动：页面 `?bhrlRadio=all`，或在 `docs/radio-gpu-harness/index.html` 中固定为 `radio: 'all'`。逐源隔离用 `probe({ mode: 26, radioMask: 1 << i })`。默认页面（不传 `bhrlRadio`）不建 overlay、不上传夹具。

GPU 产物：`docs/radio-gpu-harness/artifacts/gpu-results.json`、`gpu-meta.json`、`harness-1280x720.png`。

## 7. CPU 验证（本次实测）

- `tools/validate-imaging.mjs`：exit 0，13 个分组全部通过（formulations 6/6、deflection 62/62、capture 21/21、radii 8/8、inverse radius 73/73、degenerate 7/7、doppler 2/2、blackbody 2/2、observer 5/5、redshift 2/2、composite 3/3、critical 3/3、texture 3/3），合计 197/197，结尾 `ALL CHECKS PASSED`。阈值未放宽。
- `tools/validate-radio-imaging.mjs`：exit 0，69 项通过。oracle（formulation A 的独立积分）：

```
near  id 101  branch 1  (851.1, 376.84)
far   id 102  branch 1  (384.01, 339.59)
axis  id 103  branch 1  (640, 210.8), branch 2 (640, 505.4)
weak  id 104  branch 1  (1178, 361.83)
```

上述 `branch` 是 oracle 侧的假定标签，不是 shader 的约定，GPU 结果已证伪（§9.1）。

## 8. GPU 验证（本次实测）

运行：74 项检查，47 通过 / 27 失败，页面内 elapsed 8,371 ms（含多次全帧读回，不是帧率）。

### 8.1 通过

| 检查 | 实测 |
| --- | --- |
| 无 GL 错误 | 通过 |
| 近侧锚点与数量 | 1 个，`(850.0, 376.5)`，与 oracle 差 1.1 px |
| 远侧锚点与数量 | 1 个，`(384.5, 339.5)`，与 oracle 差 0.5 px |
| 阴影中心 | id=0，亮度 0 |
| 逐源掩码隔离 | 101 / 102 / 103 各自唯一 |
| 点击命中 | 近侧 branch 1、远侧 branch 2、近轴 branch 2 均返回本源 |
| 空击 | 阴影中心返回 null |
| 默认页面 | 无 overlay、`radio` 为 disabled |
| 资源释放 | 见 §5.1 |

### 8.2 未通过

| 检查 | 实测 | 判读 |
| --- | --- | --- |
| 远侧 `branch 1` | 只有 `branch 2` | 分支约定与 oracle 标签不一致 |
| 近轴锚点数量 | 7 个 1–2 px 碎片 | 弧被覆盖阈值切碎 |
| 近轴上/下弧位置 | y≈225.5 / 489.5–491.5 | 与 oracle 210.8 / 505.4 差 14–15 px |
| 近轴 branch 1 | 全部为 2 | 无近分支覆盖 |
| 弱场源 | 锚点 0、隔离 `ids=[]` | 该源在 GPU 上不可见 |
| id 扫描 | 仅 {101,102,103}，无 104 | 与弱场缺失一致 |
| 颜色 | 采样 [3,4,8]/[4,4,7]，均为页面背景 | 截图未含主画布，颜色无有效数据 |
| 重置/视口 | 重置后仍 9 锚点、960×540 仍 9 | 与"期望 2 弧"一并失败 |

原始数据：`docs/radio-gpu-harness/artifacts/gpu-results.json`（含 74 条检查的 `name/ok/detail` 与 9 个锚点坐标）。

## 9. 未完成项与原因

### 9.1 分支编号

shader 的 `branch` 取交点序号（`u0=1`、`u1=2`），而 oracle 侧用了"上弧即 branch 1"的假定。远侧源实测为 2，说明可见像是第二交点；近轴上下弧的序号也需要按 `traceRay` 语义重标。**结论：夹具规格中的分支期望应由 shader 语义定义，而不是由屏幕方位定义。** 本阶段未改夹具期望值，以避免"改测试让测试通过"。

### 9.2 近轴弧碎裂与弱场缺失

两者的共同点是屏幕径向尺寸远小于切向（0.3–0.8 px 对 3–14 px）。当前 `cov < 0.05` 的阈值与 `min(footprint, 0.35·radius)` 的滤波上限是按"限制 id 涂抹"加入的，反向代价是：亚像素源只有少数像素越过阈值，弧因此断成碎片；弱场源（patch 3×0.3 px）没有任何像素越过阈值。这不是"源不存在"（CPU oracle 与针孔都能给出位置），而是覆盖判据对亚像素源过严。

### 9.3 颜色与截图

驱动在 `run()` 之后、`teardown()` 之前截图（本次已拆分），但采样仍是页面背景，说明主画布未落在截图取景内或合成帧中没有该 canvas。色相检查因此不可信：远侧那一条"通过"是背景 `[3,4,8]` 被判成 blue，属假通过。**颜色验收本阶段记为未完成。**

### 9.4 重置/视口一致性

两项失败是"锚点数量仍是 9"的连带结果，根因同上（近轴碎片 + 弱场缺失），不是相机重置或尺寸变更本身出错：相机键变化确实触发了重扫。

## 10. 性能与环境

- GPU 计时扩展不可用（`timerExt = null`），**不报告 FPS 或 GPU 毫秒**。
- 页面 elapsed 8,371 ms 覆盖整套检查（多次 1280×720 读回、逐源隔离、双击/缩放用例），不能当作渲染耗时。
- 本阶段未复测第一阶段报告里的任何 FPS 数字。

## 11. 范围限制

1. 只支持盘面源（`y = 0` 平面），不支持任意三维源；坐标保留目录语义，但未接入 2,400 台目录。
2. 只有两次盘面交点；不解析高阶像，完整光子环不在范围内。
3. 源为静止观察者模型；未实现沿圆轨道运动的源，也未套用吸积盘 Doppler。
4. 背景仍是无视差的无限远环境贴图；有限距离背景的透镜效应未建模。
5. 未实现 Kerr、自旋、音频。
6. 夹具上限 4（`RADIO_SLOTS=4`），固定小循环，无空间索引。

## 12. 相对第一阶段基线的恢复

```bash
cd /c/Yu/dsh-blackhole-radio-lab
sha256sum -c docs/baseline/20261023-1117/SHA256SUMS.txt   # 先证基线自身完好
tar -C docs/baseline/20261023-1117/files -cf - . | tar -C . -xf -   # 覆盖回滚
npm ci                                                    # 依赖按 lock 重建
node tools/validate-imaging.mjs                           # 197/197
```

基线目录未被本次改动触碰（新增文件均在 `docs/` 之外的新路径与 `src/`、`tools/`）。恢复是覆盖+补缺，不删除第二阶段新增文件；如需彻底回到第一阶段，另需删除 `src/scene/radio-fixtures.js`、`src/nodes/radio-overlay.js`、`docs/radio-gpu-harness/`、`tools/validate-radio-imaging.mjs`。替换 `client.stage.js` 后宿主需重启才生效。

## 13. 第三阶段最小建议

1. **先定分支语义**：把 `branch` 的定义写进规格（交点序号，而非屏幕方位），并据此重标 oracle 与 `expected.json`；这是一次规格修订，不是放宽断言。
2. **把覆盖判据换成可解释的两级判据**：几何覆盖 `cov` 与 ID 归属分离——几何用固定的源半径/像素足迹比，ID 用"该像素的源贡献是否是该像素最大贡献"，避免用阈值同时承担抗涂抹与可见性。
3. **亚像素源的验收改为质心 + 沿切向的连续性**，并允许 id 在 1–2 px 邻域内以多数票归属；不要用单像素 id 作为唯一判据。
4. **修截图链路**：在 `run()` 与 `teardown()` 之间从合成器取帧，或在 harness 中开启 `preserveDrawingBuffer` 后再采样；颜色检查在拿到有效像素前不得计入通过数。
5. **弱场源单独处理**：若固定 0.04 半径在 1280×720 下必然亚像素，应提高其角尺寸或明确标注"弱场夹具仅验证位置，不验证可见性"。

## 14. 证据分级

- **本次实测**：§5 的 GPU 资源释放、§7 的两个 CPU 校验、§8 的 74 项 GPU 检查与 9 个锚点、§10 的扩展不可用。
- **静态检查**：分支编号取自 `traceRay` 源码；`cov` 阈值与滤波上限取自 `geodesic.glsl.js`；`RADIO_SLOTS`、uniform 名称取自 `accretion-disk.js`。
- **历史报告**：第一阶段基线、197/197、GPU 探针缺失的结论；本阶段未复测任何 FPS。
- **后续建议**：§13，未实施。

## 15. 文件与哈希（本次改动后）

```
69864dcc042cafe7482a250acab4acac565050624180479d88cc921d5d07f14f  client.stage.js   (2,051,973 B)
c79fd3825049bb6dd2231ba0defbfe451c3d7cb5b427034911714a63fe44d607  client.js         (50,884 B)
76c4b463bb7f4a9c28c32efff7cd7341967d07bf627e7b54eacb5072314fc34d  client.radio.js   (19,017 B，未变)
1def4ebe34252206a7ee91183523de91b84bf948c975afb70085e103b38eb454  src/scene/geodesic.glsl.js
d479706d4e91fd7d0a55ee473abfb3662092beb7d024e90e14fb5e53dfa77334  src/scene/radio-fixtures.js
1b4d1671240ddb298d17f243893360a851c6b6f9171ba768b352def63d56dd29  src/nodes/radio-overlay.js
75e700b31da05ed20916a2fe1e06d4dd410a318d78fa77a79db0c89424e1d7b8  src/stage.js
b9f169c9f85d2cbf571f14d26174a5232ecfb8e2cddf27124de362c4d65608b8  src/scene/accretion-disk.js
40f2a3fc4a4f80b583446b0375913dbbd75b60828e8da179f3d6f9d63fe69a30  src/scene/ray-tables.js
072b21855912a537efdac677a220148bcd8effb21c1ff5a3da9f2ad6d76e245e  tools/validate-radio-imaging.mjs
```

`client.js` 的 mtime 被构建脚本按设计顶到 12:21；第一阶段基线中的原件哈希与副本不受影响。
