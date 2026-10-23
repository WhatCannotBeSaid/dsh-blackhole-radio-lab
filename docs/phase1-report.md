# 第一阶段报告：基线冻结与验证入口

项目：`C:\Yu\dsh-blackhole-radio-lab`
日期：2026-10-23
版本：`package.json` = 0.4.0-lab.1；`src/stage.js:60` `STAGE_PHASE = 'phase-5'`；`index.js:124` 下发 `phase: 5`
本阶段边界：不实施电台透镜、不重构渲染管线、不升级依赖、不修改 DSH 配置、不重启宿主、不删除或覆盖已有工作。

## 0. 结论

1. **基线已冻结**：`docs/baseline/20261023-1117/`，57 个文件、10,072,870 B 副本，每个文件记 SHA-256 + 字节数 + mtime；副本与原文件逐条比对 57/57 一致。恢复方法已写入基线目录的 `README.md`，**未执行恢复**。
2. **验证入口已建立并跑通**：`docs/baseline/repro-validate.sh` 一条命令完成"运行 + 记录环境/退出码/分组通过数 + 对比源码漂移"，三次运行输出字节一致，`197/197`、退出码 0。
3. **本次实测**：`node tools/validate-imaging.mjs` → **197/197 通过，exit 0**；与历史记录的 197/197 一致，但本报告只把本次执行当作事实。
4. **两个代码缺陷已定位（未修）**：`createRayTables()` 没有 `dispose()` 而成像模块却调用了它，导致两张 RG32F 表纹理泄漏；GPU 计时把 `QUERY_RESULT_DISJOINT` 当成 `getQueryParameter` 的合法参数。
5. **文档大面积失真**：README 与两份旧报告仍在描述已删除的 `black-hole.js` / `photon-ring.js`、phase 4、旧构建体积、旧行号、旧电台带数值。其中"电台带 1.54–3.65"是**数值漂移**，不是排版问题。
6. **本阶段未跑真实浏览器 GPU 探针**，因此不宣称 GPU 成像通过；未复测 FPS，不引用旧 FPS 作为当前性能。
7. 额外产出：四类盘面夹具的几何与 CPU 参考像位置已测定，并暴露出一个对第二阶段关键的事实——默认相机下盘面斑点的径向尺寸只有 0.3–0.8 px（见 §7）。

## 1. 环境与版本控制

| 项 | 值 |
| --- | --- |
| 时间 | 2026-10-23 11:17–11:40 +0800 |
| 项目 | `C:\Yu\dsh-blackhole-radio-lab`（`/c/Yu/dsh-blackhole-radio-lab`） |
| node / npm | v24.19.0 / 11.17.0 |
| OS | `MINGW64_NT-10.0-26200 3.6.10-5a1665c8.x86_64 x86_64 Msys` |
| 依赖 | `three ^0.186.1`、`esbuild ^0.28.2`（devDependency），`package-lock.json` 29 个包条目（lockfileVersion 3） |
| 体积 | 含 `node_modules` 共 44 MB |

**没有 Git 仓库**。`git rev-parse --show-toplevel` 在项目目录和 `C:\Yu` 都返回 `fatal: not a git repository`（已实测）。所以"检查 Git 状态"的结论是：没有版本控制、没有提交历史、没有 stash/checkout 可退。本阶段的"可恢复"只能由 **SHA-256 清单 + 字节副本**承担，报告中不使用"回滚"一词。

## 2. 基线（可恢复点）

目录：`docs/baseline/20261023-1117/`

| 产物 | 内容 |
| --- | --- |
| `SHA256SUMS.txt` | 57 行，`sha256  size  mtime  path`（含纳秒），按路径排序 |
| `FILELIST.txt` | 57 行 `size  path` |
| `COPY.SHA256SUMS.txt` | 副本的 57 行 `sha256  path` |
| `ENVIRONMENT.txt` | 采集时间、路径、node/npm/OS、git 状态、排除项 |
| `files/` | 57 个文件的副本，10,072,870 B，保留 mtime（截断到秒） |
| `logs/validate-imaging-run1.log` | 第一次验证的完整 stdout，304 行 |
| `logs/validate-imaging-run{1,2}-meta.txt` | exit_code / duration_ms / node / cwd / command |
| `logs/validate-imaging-run2.log` | 第二次验证的完整 stdout，与 run1 字节一致 |

关键哈希（完整 57 条在清单里）：

| 文件 | 字节 | SHA-256 前缀 |
| --- | --- | --- |
| `README.md` | 11,989 | `e6bfeeaf…` |
| `client.js` | 50,356 | `2d38e3ca…` |
| `client.stage.js` | 2,036,161 | `8fc656e4…` |
| `client.radio.js` | 19,017 | `76c4b463…` |
| `src/stage.js` | 54,203 | `a545f0cc…` |
| `src/scene/geodesic.glsl.js` | — | `9925bf15…` |
| `tools/validate-imaging.mjs` | 53,638 | `5ef8b925…` |

**恢复方法**（已写入 `docs/baseline/20261023-1117/README.md`，未执行）：

```bash
cd /c/Yu/dsh-blackhole-radio-lab/docs/baseline/20261023-1117
awk '{print $1"  "$NF}' SHA256SUMS.txt > /tmp/bhrl-baseline.sha256
sha256sum -c /tmp/bhrl-baseline.sha256           # 57/57 OK 才继续
tar -C files -cf - . | tar -C /c/Yu/dsh-blackhole-radio-lab -xf -
cd /c/Yu/dsh-blackhole-radio-lab && npm ci
sha256sum -c /tmp/bhrl-baseline.sha256
node tools/validate-imaging.mjs                  # 期望 exit 0、197/197
```

三点限制写在基线 README 里：恢复是"覆盖 + 补缺"而不是还原快照状态；`node_modules` 不在副本里，只能 `npm ci` 重建；替换 `client.stage.js` 后桌面宿主需要重启才生效（本阶段不重启）。

**未改动证明**：全部工作结束后，用基线清单重跑 `sha256sum -c` → **57/57 OK**；`client.js` mtime 仍是 `11:00:24.951`、`client.stage.js` `11:00:24.911`、`client.radio.js` `11:00:24.951`，与冻结时一致。

## 3. 本次实测：验证执行

命令：`node tools/validate-imaging.mjs`（项目根，node v24.19.0）

| 运行 | 时间 | 退出码 | 耗时 | 输出 SHA-256 | 结果 |
| --- | --- | --- | --- | --- | --- |
| run1 | 11:19 | 0 | 1180 ms | `de6e4f310ce9c571…` | 197/197 |
| run2 | 11:20 | 0 | 1198 ms | `de6e4f310ce9c571…` | 197/197 |
| repro 入口 | 11:27 | 0 | 718 ms | `de6e4f310ce9c571…` | 197/197 |

三次输出**字节完全一致**（304 行），说明脚本确定、无并发/时钟依赖。

逐组通过数（本次实测）：

| 组 | 通过 |
| --- | --- |
| A vs B | 6/6 |
| deflection | 62/62 |
| capture | 21/21 |
| radii | 8/8 |
| inverse radius | 73/73 |
| degenerate | 7/7 |
| doppler | 2/2 |
| blackbody | 2/2 |
| observer | 5/5 |
| redshift | 2/2 |
| composite | 3/3 |
| critical | 3/3 |
| texture | 3/3 |
| **合计** | **197/197** |

性质与边界：

- 纯 CPU。脚本无 `node:fs`、无写文件、无浏览器/GPU 依赖；唯一副作用是 `failures > 0` 时 `process.exitCode = 1`（`tools/validate-imaging.mjs:1151`）。导入即执行全部检查，这是设计意图（GPU 交叉验证要复用同一参考）。
- 它验证的是**测地线查表与成像公式的 CPU 参考**：两套独立参考（A 轨道方程 Gauss-Legendre、B 笛卡尔 RK4）互校，再与表链比对。它**不验证** GPU 上的实际着色结果。
- 断言与阈值原样保留：`TOL_DEFLECTION 3.0e-4`、`TOL_DEFLECTION_CRITICAL 1.0e-2`、`TOL_CROSSING_U 3.0e-3`、`TOL_CROSSING_T 0.5`，GPU probe 编号 1..25 未动。

### 3.1 可重复入口

`docs/baseline/repro-validate.sh`（新增，只读项目）：

- 每次写进新的 `docs/baseline/runs/<时间戳>[-label]/`，**存在即拒绝**（exit 2），不覆盖；
- 产出 `validate-imaging.log`、`meta.txt`（退出码、耗时、node/npm/OS、日志哈希、git 状态、GPU 探针状态）、`section-counts.txt`（分组通过数）、`source-drift.txt`（相对冻结基线的哈希漂移）；
- 退出码 = 验证脚本退出码；源码漂移只报告、不影响退出码（第二阶段新增文件后必然漂移）。
- 实测一次：`docs/baseline/runs/20261023-112726-entrycheck/`，`TOTAL 197/197`、`source_drift: 0 of 57 files differ`。

## 4. 当前渲染链路（静态检查）

以源码为准，行号为当前版本。

**入口与挂载**：`client.js:39` `STAGE_CHUNK='./client.stage.js'`；`client.js:207` `stage.mountStage(container, settings)`；`client.js:349-350` 用 `?bhrlStations=` 覆盖电台数；`client.js:1130` claim 面板。

`src/stage.js` 组装顺序：`:158` `createStarfield()` → `:161` `createAccretionDisk({ renderer })` → `:166` `holeCenter = new Vector3(0,0,0)` → `:168` `createCameraRig(camera, canvas, { target: holeCenter })` → `:173` `createStationsLayer(stations, { seed, pixelRatio })`（有电台时）→ `:182` `createLabelOverlay(container)`；`:371` `draw()`；`:467/:474` `requestAnimationFrame(tick)`；`:60` `STAGE_PHASE='phase-5'`；`:1411` 暴露 `window.__BHRL_DEBUG__`（version 5）；`:1137-1139` `state` 是 getter 不是方法。

**成像**：`src/scene/accretion-disk.js` 只有一个全屏四边形（`:121` `PlaneGeometry(2,2,1,1)`）+ 一个 `RawShaderMaterial`（`:104`，GLSL3、NoBlending、depthTest/depthWrite false、DoubleSide），`renderOrder = -10`（`:127`）。每像素在 `src/scene/geodesic.glsl.js` 里重建相机光线（`:804-809`），换算到静止观察者坐标（`:825-867`），查表求偏折与交点（`traceRay`，`:684-743`），最多两个盘面交点 `u0`/`u1`（`:715-734`），两次合成（`:999-1002`），一次曝光 + ACES + sRGB（`:1035`）。

**表**：`src/scene/ray-tables.js:127` `createRayTables(renderer)`，解码 base64 uint16 双通道为 RG32F `DataTexture`；`deflection` 512×512、`inverse_radius` 64×32（`src/scene/ray-tables.data.js:23,11687`），revision `e72b3f29…`。

**相机**：`src/scene/camera-rig.js`，`MIN_RADIUS 6.0` / `MAX_RADIUS 44`、`FOCUS_MIN_RADIUS 2.2`、`MIN_PHI 0.24` / `MAX_PHI π−0.30`、`ROTATE_SPEED 0.0052`、`DAMPING 9.5`、`DRAG_SLOP 6`；只认左键；`dispose` 幂等。宿主相机 `PerspectiveCamera(42, 1, 0.1, 400)`，`ACESFilmicToneMapping`、exposure 1.15、SRGB 输出、像素比 `min(dpr, cap)` 夹 1..4。

**电台与标签**：`src/nodes/stations-layer.js` 单 `Points`（每站 5 个 sprite，精选 8），黑洞模式下 `holeOnly > 0.5` 时 `interactive()` 返回 false、`labelVisibility` 为 0（即电台隐藏）；`src/nodes/label-overlay.js` 是 2D canvas，按"选中站名 → 精选/近距站名 → 云团名"三层绘制并做避让。

**单位**：`src/scene/dimensions.js:1-38` 的注释本身就是规范：世界单位 = `b_crit = 1`，`RS = 2/(3√3)`，`ISCO = 6M`，`DISK_INNER = ISCO`，`DISK_OUTER = 12 RS`。世界→shader：`(x,y,z)_s = (x,−z,y)/RS`。

**配置**：`package.json` DEFAULTS 由 `index.js:32-40` 定义：`antialias true`、`pixelRatioCap 2`、`reducedMotion false`、`showHints true`、`stationCount 2400`、`seed 20261022`、`featuredCount 18`；校验范围 `pixelRatioCap 1..4`、`stationCount 200..20000`、`seed 0..4294967295`、`featuredCount 4..40`；配置路由 `index.js:116`，响应带 `phase: 5`（`:124`）。

## 5. 未执行的检查及原因

| 检查 | 为什么没做 |
| --- | --- |
| 真实浏览器 GPU 探针（probe 1..25 读回） | 需要 DSH Web 面板里的真实 WebGL2 上下文；本阶段不改宿主配置、不重启宿主，也没有为此开浏览器会话。因此**不宣称 GPU 成像通过**。 |
| `npm run build` / `node tools/build-stage.mjs` | 会重写 `client.stage.js`、`client.radio.js`，并在内容变化时 `utimesSync` 顶 `client.js` 的 mtime（`tools/build-stage.mjs`），违反"现有构建产物与 mtime 不变"。 |
| `node tools/build-tables.mjs` | 会重写 `src/scene/ray-tables.data.js`（生成文件），属于源码。 |
| `npm install` / `npm ci` | 无必要；会改 `node_modules`。依赖与锁文件本阶段不动。 |
| 宿主重启 / 插件重装 | 明确禁止。 |
| FPS、triangle/draw-call 计数 | 未跑真实页面，不引用旧值（旧报告 113.3/135.7/144.4 等全部属于历史实测）。 |
| 打包体积复核 | 只有仓内已有的 `client.stage.js` 2,036,161 B，不是本次构建产物；不拿它当"构建结果"。 |

## 6. 待修问题（本阶段只核实，不修）

### 6.1 `createRayTables()` 缺少 `dispose()`

**证据（静态检查，已逐行核对）**

- `src/scene/ray-tables.js:127` `export function createRayTables(renderer)`，返回对象只有 `{ deflection, inverseRadius, hardwareFilter, info }`，没有 `dispose`。
- `src/scene/accretion-disk.js:349` 在自身 `dispose()` 里调用 `tables.dispose();`。
- 该调用发生在 `src/stage.js:1166-1174` 的 `try { part.dispose(); } catch { }` 内，异常被吞掉。

**影响**：每次挂载/卸载面板会泄漏两张 `DataTexture`：512×512×8 B = 2,097,152 B，64×32×8 B = 16,384 B，合计 **2,113,536 B ≈ 2.02 MiB**；geometry 与 material 在 `tables.dispose()` 之前已释放，所以泄漏的只有表纹理。因为异常被吞，控制台无报错、测试也不会发现；反复开合面板会持续累积显存。

**建议修法**（第二阶段，不在本阶段做）：给 `createRayTables` 的返回对象补 `dispose()`（释放两张 `DataTexture`），或让 `accretion-disk` 只释放自己创建的资源、不假定 tables 有 `dispose`。两者取其一，不要两边都改。

### 6.2 GPU 计时使用无效的 `QUERY_RESULT_DISJOINT`

**证据**

- `src/stage.js:361` `gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)`（合法）。
- `src/stage.js:362` `if (!gl.getQueryParameter(query, gl.QUERY_RESULT_DISJOINT))` —— WebGL2 的 `getQueryParameter` 只接受 `QUERY_RESULT` 与 `QUERY_RESULT_AVAILABLE`；`QUERY_RESULT_DISJOINT` 不是 query 参数，`EXT_disjoint_timer_query_webgl2` 的 disjoint 语义是 `getParameter(timerExt.GPU_DISJOINT_EXT)`。
- 同一函数 `src/stage.js:352` 已经用 `gl.getParameter(timerExt.GPU_DISJOINT_EXT)` 做了正确的 disjoint 判断。

**影响**：`:362` 会产生一次 `INVALID_ENUM`，返回 `null`（falsy），于是条件恒真、结果照常 `push` 进 `gpuSamples`。**计时数据没有被污染**（真正的判断在 `:352`），但每帧制造一次 GL 错误，既污染错误检查，也让读代码的人误以为存在 per-query 的 disjoint 检查。属"噪音 + 误导"，不是数据错误——这一点必须说清楚，否则容易被当成计时全部作废。

### 6.3 README / 旧报告与当前实现的差异

（以下全部为静态检查；"历史"栏只记录旧文档写了什么，不代表当前实现。）

| # | 位置 | 旧文档 | 当前实现 | 影响 |
| --- | --- | --- | --- | --- |
| 1 | `README.md:33-35` | 目录表列 `src/scene/black-hole.js`（事件视界纯黑球）、`src/scene/photon-ring.js`（朝向相机面片 + 径向剖面） | 两个文件都不存在；黑洞由单一测地线 shader 一次画出，无独立环几何、无 shadow sphere | 按 README 找不到文件，误解架构 |
| 2 | `README.md:5` | "当前进度：第四阶段…已完成" | `src/stage.js:60` `phase-5`；`index.js:124` `phase: 5` | 阶段判断错误 |
| 3 | `README.md:35` | `accretion-disk.js` = 极坐标网格 + 噪声条纹 + 远侧内缘抬升 | 全屏四边形 + 逐像素测地线查表（`PlaneGeometry(2,2,1,1)`） | 完全不同的渲染模型 |
| 4 | `README.md:93` / `docs/phase4-report.md:6,167` | `?bhrlStations=` / `?bhrStations=` | `client.js:349-350` 只认 `bhrlStations` | 旧参数名无效 |
| 5 | `README.md:144` | `mountStage` 接口写 `state()` | 实际 `state` 是 getter（`stage.js:1137-1139`） | 按文档调用会 TypeError |
| 6 | `docs/phase4-report.md:7` | 读数来自 `window.__BHR_DEBUG__` | 实际 `window.__BHRL_DEBUG__`（`stage.js:1411`） | 调试读数脚本失效 |
| 7 | `docs/phase4-report.md:32` | `client.stage.js` 590,390 B / gzip 154,380 / brotli 128,110 | 仓内实际 2,036,161 B | 体积结论过期 3.4 倍 |
| 8 | `docs/rework-report.md:102-103` | `client.stage.js` 574,812 B、`client.js` 60,934 B、版本 0.3.1 | 2,036,161 B、50,356 B、0.4.0-lab.1 | 同上 |
| 9 | `docs/rework-report.md:35`、`docs/camera-orbit-report.md:14-19` | 行数：stations-layer 727、camera-rig 296、stage 859、dimensions 24、client.js 1773 | 1015、345、1502、157、1149 | 行号引用全部失效 |
| 10 | `docs/camera-orbit-report.md:51-57` | 引用 `stage.js:139-142` 的 `blackHole.object.getWorldPosition` | `stage.js:166` 直接 `new Vector3(0,0,0)` | 代码位置与实现都变了 |
| 11 | `README.md:17`、`docs/rework-report.md:17-18` | 电台带 1.54–3.65（`DISK_INNER 1.40 + 0.14`），精选 1.66–1.79 | `R_IN = DISK_INNER + 0.14 = 1.2947`、`R_OUT = DISK_OUTER − 0.95 = 3.6688`；精选 1.2547–1.7347 | **数值漂移**：`DISK_INNER` 已从 1.40 改为 ISCO 1.1547，电台带整体内移 0.245 U（0.64 RS） |
| 12 | `src/scene/dimensions.js:97` | 注释"a little under 5 degrees above the disc plane" | 实测仰角 2.8028° | 相机描述失真 |
| 13 | `docs/phase4-report.md:25` | 称改了 `accretion-disk.js` / `photon-ring.js` / `black-hole.js` 的透明度 setter | 只剩 `setOpacity`；`setRingIntensity` 是空实现；两个文件不存在 | 变更记录不可信 |
| 14 | `docs/phase4-report.md:157-167` | FPS 表 113.3 / 135.7 / 144.4 等 | 本次未复测 | 不得作为当前性能引用 |

结论：旧文档只能当历史记录读，不能当实现说明或数值来源。README 的"1.54–3.65 R"这类数值尤其危险——它看起来像规格，实际是过期常量。

## 7. 本阶段额外实测：夹具与范围边界

这部分不是任务要求，但直接影响第二阶段怎么设计，故记录。全部为 **CPU 参考（formulation B）实测**，不是 GPU 结果。

用 `tools/validate-imaging.mjs` 导出的独立参考写只读探针（`docs/baseline/fixtures-probe/`），在 1280×720、默认相机下追踪相机光线与 y=0 平面的交点，得到四类夹具的像位置：

| 夹具 | b_geom (U) | 像分支 | 实测像质心 (px) | 尺寸 (px) | 针孔锚点 (px) | 位移 |
| --- | --- | --- | --- | --- | --- | --- |
| N_near r=2.6 | 1.8208 | 1 | (851.10, 376.84) | 12.7 × 0.75 | (852.89, 376.98) | 1.8 |
| F_far r=3.2 | 1.2449 | 1 | (384.01, 339.59) | 4.8 × 0.80 | (496.02, 348.99) | 112.4 |
| A_axis r=1.6 | 0.0655 | 1 / 2 | 上弧 (640, 210.8)、下弧 (640, 505.4) | 141 × 16.5 / 137 × 16.5 | 不适用（在阴影后） | — |
| W_weak r=4.2 | 3.8406 | 1 | (1178.00, 361.83) | 3.0 × 0.30 | (1137.10, 362.00) | 40.9 |

三条结论：

1. **盘面斑点是细条，不是圆斑**。相机只比盘面高 0.401 U，视线与盘面夹角 2.8°，0.04 U 的半径在屏幕径向被压到 0.3–0.8 px。任何按面积/IoU 写的验收都会失败，且失败原因是投影几何，不是成像错误。验收必须用质心 + 分支 + 切向范围。
2. **针孔不能当 oracle**。弱场夹具（b = 3.84 U）已偏 40.9 px，近临界夹具偏 112.4 px；默认相机下不存在"绝对弱场"。只有独立 CPU 测地线参考可作判据。
3. **强场夹具才有面积**。近轴源（r=1.6、正对黑洞后方）被透镜拉成上下两条弧，各约 140 × 16 px，是最适合做可视验收的夹具；其余三类是 1 px 级细条，只能验证质心。

## 8. 第二阶段的建议范围与验收条件

**最小改动范围**（建议，不是本阶段已做）

1. 新增一个成像映射模块（暂定 `src/nodes/radio-imaging.js`）：输入盘面电台 `(r, φ)`，输出屏幕坐标与像分支；内部复用现有表，不复制数学。
2. 夹具数据 + 调试开关：4 个夹具、固定种子/时间，只在 `__BHRL_DEBUG__` 下生成，正式场景不渲染。
3. 一个 CPU 侧 golden 生成器（`tools/` 下新文件）：用 `validate-imaging.mjs` 的独立参考生成四类夹具的像位置，冻结成 JSON。
4. 标签与命中测试改接成像坐标（`label-overlay.js`、`stations-layer.js` 的锚点来源）。
5. **不动**：`geodesic.glsl.js` 的测地线数学、`ray-tables.data.js`、表尺寸、`build-stage.mjs` 行为、`package.json` 依赖、DSH 配置。

**验收条件**（对应 `docs/imaging-verification-spec.md` §6）

- 四类夹具的颜色（线性 ≤ 1/255、整像素 ≤ 2/255）、可见 ID、像分支（A_axis 必须两条弧）、标签锚点（≤ 1–2 px）、点击一致性（±2 px 命中、±10 px 外不命中）；
- `t=0` 与 `t=3.85` 质心差 ≤ 0.5 px；
- `node tools/validate-imaging.mjs` 仍 197/197，阈值不放宽；
- 真实 GPU 探针（如果做）必须与 CPU golden 比对，而不是与针孔比对。

**风险**：如果第二阶段要用"可见的电台斑点"做验收，必须先决定是平面 patch 还是锚点 billboard（见规格 §8）。平面 patch 在当前相机下只有 0.3–0.8 px 厚，视觉上几乎不可见。

## 9. 证据分级

| 类别 | 本报告中的内容 |
| --- | --- |
| **本次实测** | 验证脚本三次运行（197/197、exit 0、同哈希）；基线副本 57/57 一致；结束时原件 57/57 未变、mtime 未动；夹具像位置（§7）；`STATION_RADIUS 1.2947–3.6688` 与仰角 2.8028°（由源码常量计算）；`repro-validate.sh` 实跑结果 |
| **历史报告** | FPS 表、构建体积（590,390 / 574,812 B）、phase4 的交互与性能结论、早先的 197/197 记录。仅作为历史记录，不作为当前事实 |
| **静态检查结论** | 渲染链路与行号；`createRayTables` 缺 `dispose`；`QUERY_RESULT_DISJOINT` 用法错误；文档漂移 14 条；probe 模式 1..25；探针/计数器实现 |
| **后续建议** | §8 的改动范围与验收条件；§6 的两个修法建议；规格 §8 的未决问题 |

## 10. 交付物与改动清单

新增（全部为新增，未修改任何既有文件）：

| 路径 | 内容 |
| --- | --- |
| `docs/baseline/20261023-1117/` | 基线：清单、副本、环境、两次验证日志、基线 README（含恢复方法） |
| `docs/baseline/repro-validate.sh` | 可重复验证入口（只读项目，时间戳输出，不覆盖） |
| `docs/baseline/runs/20261023-112726-entrycheck/` | 入口首次运行的结果 |
| `docs/baseline/fixtures-probe/` | 夹具测量探针（只读）与 4 px 扫描原始输出 |
| `docs/imaging-verification-spec.md` | 第二阶段验证规格（单位、观察者、标准条件、四类夹具、验收项、范围边界） |
| `docs/phase1-report.md` | 本报告 |

未改动：`src/**`、`tools/**`、`client.js`、`client.stage.js`、`client.radio.js`、`package.json`、`package-lock.json`、`cordis.patch.yml`、`docs/` 下既有报告与截图、DSH 配置。已用基线清单复核 57/57 一致。

本阶段到此停止，等待第二阶段指令。
