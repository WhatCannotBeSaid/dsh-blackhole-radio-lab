# 第二阶段修复与复验报告（第三轮）

版本：0.4.0-lab.1 ｜ 日期：2026-10-23 ｜ 范围：四个 Schwarzschild 盘面夹具
状态：**部分通过**（不是完成）。结论按“通过 / 实际行为失败 / 测试基础设施修正 / 未执行”分级，见 §7。

本轮依据用户第三轮任务书执行：先复现定位再改，保留第一阶段冻结基线与第二阶段历史报告，新增本报告与新结果目录。
历史证据未覆盖：`docs/phase2-report.md`、`docs/radio-gpu-harness/artifacts/` 下旧目录、`docs/baseline/20261023-1117/`。

---

## 1. 本轮根因结论（三条，彼此独立）

### 1.1 分支标签被张冠李戴：`branch` 之前是“表槽位”，不是“交点序号”

用独立 CPU 路径（`C:\Work\scratch\p3\crossing-probe.mjs`，直接调用 `tools/validate-imaging.mjs` 的 `integrateCartesian`，逐条光线枚举该光线与 z=0 平面的**所有**交点）得到：

| 夹具 | 像 | 交点序号（沿光线） | 表槽位 | 交点半径（Rs 单位） |
| --- | --- | --- | --- | --- |
| `radio-near-side` | 单像 | 1 | 1 | 落在夹具 0.0004 内 |
| `radio-far-side` | 单像 | **1** | **2** | 落在夹具 0.0005 内 |
| `radio-near-axis` | 上弧 | 1 | 2 | 1.4387 |
| `radio-near-axis` | 下弧 | **2** | 2 | 1.4205（其 crossing 1 在 r=6.28，盘环外） |
| `radio-weak-field` | 单像 | 1 | 1 | 落在夹具 0.0057 内 |

所以上一轮 GPU 报出的 `branch=2`（远侧）与 `1/2`（近轴）是 shader 内部两次查表槽位，不是像的阶次。**不能因为 GPU 返回 2 就把期望改成 2**：上一轮的期望表恰好写错，本轮按 CPU 交点序号重写。

语义拆分为三个独立字段并落到接口：

- `crossingIndex`：沿光线路径的交点编号（1 = 第一次穿过盘面，2 = 第二次）。这是 `branch` 现在的唯一含义。
- `tableSlot`：shader 的 analytic 槽位（1 / 2）。只作诊断，不参与验收。
- `screenRegion`：仅供人读的屏幕方位（`upper` / `lower` / `lower-centre` / `upper-left` / `right`），不作断言依据。

依据：`src/scene/geodesic.glsl.js` 的 `radioAtCrossing(..., tableSlot, crossingIndex, ...)`；`src/stage.js` 的 `radioIdAt()` 读探针 26（id）/27（槽位）/33（交点序号）；`tools/validate-radio-imaging.mjs` 的 `REFERENCE` 与 `docs/radio-gpu-harness/harness.js` 的比对逻辑。

### 1.2 覆盖公式错误：把“像素足迹”当成了覆盖宽度

上一轮 `cov = filteredPulse(0, radius, dist, min(footprint, 0.35*radius))`，其中 `footprint` 是 `fwidth()` 推出的**世界单位每像素**。在阴影附近它可达数个世界单位，于是 0.04 的夹具被涂成一整片；把上限压到 `0.35*radius` 又让真实亚像素条带拿不到覆盖。

本轮改为几何覆盖：设 `fwp = vec2(fwidth(point.x), fwidth(point.y))`（两个轴向各自的世界单位/像素），则

```
wRadial = 0.5 * (|ux| * fwp.x + |uy| * fwp.y)      // 该像素在“到圆心距离”方向上的半宽
cov     = clamp((R - dist) / max(wRadial, 1e-6) + 0.5, 0, 1)
```

`cov` 因此是“这个像素有多大比例落在源圆盘内”，不再是滤波模糊半径。ID 只在 `cov >= 0.5` 且该源是当前像素最亮贡献时给出：**拾取区域等于几何足迹，不含发光晕**。

同时修掉一处错误门控：原先电台累积写在 `if (u1 >= 0 && a1 > 0)` 里，而 `a1` 含 `critFade`（临界带渐隐，盘面用的），会把临界带里的电台整片抹掉。现在电台只要求“交点存在”（`u1 >= 0`），可见性由 `cov` 与前景覆盖共同决定。

实测各向异性（同一像素的世界单位/像素，x 向 vs y 向）：近侧 15.9×、远侧 5.6×、近轴上弧 54.4×、下弧 59.1×、弱场 21.4×。这就是为什么盘面圆斑在屏幕上只有 0.3–0.8 px 的**径向**厚度：默认相机只比盘面高 0.401 U，视线与盘面夹角 2.8°。

### 1.3 近轴弧只在两端成像：受 64×32 反半径表的分辨率限制

在近轴上弧区域取 430 个像素，用新增探针读 shader 的实际交点：

- 该区域 `u0` 恒为 −1（shader 认为没有第一交点），`u1` 恒 > 0；
- 同一列相邻 y 的 `u1` 从 0.2313 跳到 0.2401、0.2496……即 `Δu ≈ 0.007–0.011`，换算 `Δr ≈ 0.05–0.10` **世界单位**；
- 夹具半径是 0.04。也就是说表的分辨率步长已经大于源本身，只有恰好落在表节点附近的像素才能满足 `dist <= R`。
- 430 个采样里只有 39 个像素命中 id 103，且集中在弧的**两端**，中间为空洞。

`inverse_radius` 表是 64×32（`src/scene/ray-tables.data.js`，`RAY_TABLES_REVISION='e72b3f…'`），CPU oracle 用的是直接积分（formulation B），两者在临界曲线附近本质不同。**这不是覆盖公式能修的**：要修只有两条路，一是重生成更细的表（本轮明确禁止），二是给临界带换一套光线求交（等于重写内核，也禁止）。因此本轮把它记为“实际行为失败 + 范围边界”，并写进规格。

### 1.4 弱场源完全不出现（未定位）

`radio-weak-field`（r=4.2，φ=1.6047）在页面上找不到任何像素：全帧原生分辨率扫 id 得到 `{101,102,103}`，探针 34（`visibleCov`）在其预期像位附近恒为 0。也就是说“有交点但覆盖恒 0”，不是“像被遮住”。

已排除：夹具被禁用（mask 全开）、坐标换算错（同一套 `toShaderFixture` 对其它三个源正确）、前景遮挡（该处盘面覆盖为 0）。下一步最小修复见 §8：给探针加两个模式（交点 x / y），把 GPU 交点位置直接和 CPU oracle 比，判断是方位角错还是半径错。本轮不做进一步改动，避免把未定位问题“改绿”。

---

## 2. 修改的文件与职责

| 文件 | 职责 | SHA-256（前 12） |
| --- | --- | --- |
| `src/scene/geodesic.glsl.js` | RADIO 段：几何覆盖、`crossingIndex`/`tableSlot` 双标签、探针 33–40 | `59b16ec7ae18` |
| `src/stage.js` | 8 邻域连通、锚点带 `slot`/`crossingIndex`、`pickRadio`、`scanRadioAnchors` | `374f8f7f0cca` |
| `src/scene/accretion-disk.js` | `probe({region, radioMask, unpack})`、`setRadio/getRadio`、`RADIO_SLOTS=4` | `b9f169c9f85d` |
| `src/scene/ray-tables.js` | 幂等 `dispose()` + `disposed` getter（第二阶段前半已加） | `40f2a3fc4a4f` |
| `tools/validate-radio-imaging.mjs` | CPU 期望改为 `crossingIndex + screenRegion`，69 项 | `8878da04a70b` |
| `docs/radio-gpu-harness/harness.js` | 原生分辨率 id 扫描、锚点 3×3 邻域采样、DPR/视口/过期检查 | `5d9da51b956a` |
| `client.stage.js`（构建产物） | 2,055,806 B，`4fb4c53d6b5c` | — |

`client.radio.js` 内容未变（19,017 B）；`client.js` 仅 mtime 被构建脚本按既有规则顶起，内容未改（50,884 B）。

冻结基线 `docs/baseline/20261023-1117/` 未改动：本报告与结果目录都在 `docs/` 下新增路径，基线内的 `SHA256SUMS.txt` 未被写入。

---

## 3. 口径修正（测试基础设施，非渲染）

三条以上一轮的失败结论其实是**测量工具**造成的：

1. **半分辨率 id 扫描**：上一轮用 640×360 扫 id，1280×720 下宽 4 px 的远侧像在 1/2 分辨率只剩 2 px，1 px 条带直接消失。本轮改为原生分辨率，远侧 id 102 因此重新出现。
2. **分数像素探针原点**：`region.y = 720 - 1 - 376.5 = 342.5`，shader 于是在两个像素之间采样，1 px 条带读成空。本轮对探针 region 取整（`Math.floor`），并在锚点 3×3 邻域里取最强响应。
3. **4 邻域连通**：斜率为 1 的 1 px 条带在对角方向不相连，会被拆成单像素孤岛。本轮改 8 邻域。

这三条保留在报告里，不删除：它们解释了上一轮为什么把“远侧色相假通过”“近侧无颜色”写进结论。

---

## 4. 颜色证据链（两层，分开报告）

### 4.1 Shader 层：同一像素的开/关差分（离屏，线性 + 显示）

用探针 35–37（线性 RGB）与 38–40（显示 RGB），对每个锚点分别在“全开”和“mask=0”下读同一像素：

| 夹具 | 线性（开） | 线性（关） | 显示（开） | 显示（关） |
| --- | --- | --- | --- | --- |
| `radio-near-axis` c1 | 0.2560, 0.2215, 0.2457 | 0.2043, 0.1913, 0.1994 | 0.638, 0.601, 0.627 | 0.575, 0.558, 0.569 |
| `radio-near-side` c1 | 见结果 JSON（3×3 邻域取样） | — | — | — |
| `radio-far-side` c1 | 同上 | — | — | — |

控制像素（画面左上，远离所有夹具）开/关最大差 `|Δ| = 0`，`2.8e-8` 以下，说明差分不是全局亮度漂移。

### 4.2 页面层：真实截图开/关差分

两页同一相机（`(0.856, 0.401, 8.146)`），唯一差别是夹具开关；截图 1280×720，逐像素取通道最大差：

| 区域 | 平均差（0–255） | 最大差 |
| --- | --- | --- |
| `radio-far-side` c1 | 15.0 | 116 |
| `radio-near-axis` c1 两端 | 11.0 / 21.7 | 65 / 118 |
| `radio-near-axis` c2 三处 | 10.5 / 19.8 / 23.4 | 65 / 112 / 167 |
| `radio-near-side` c1 | 25.3 | 138 |
| 5 个控制区 | **0.0** | **0** |
| 整帧 | 0.8 | 224 |

结论：**页面上确实画出了源，且只在源所在处变化**。上一轮的“截图恒为背景”已确认是驱动在 `run()` 已经把主 stage dispose 之后才截图；本轮拆成 `mount()` / `run()` / `teardown()` 三步后消失。

同时保留一项失败：`radio-far-side` 与 `radio-near-side` 的 shader 层开/关在**锚点质心那一像素**上差值为 0（条带只有 1 px 高，质心落在半像素上），改用 3×3 邻域后通过。这是测量口径，不是渲染问题，但报告里保留原始读数。

---

## 5. 视口、坐标与交互（本轮全部实测通过）

- **DPR**：`deviceScaleFactor` 1 / 1.5 / 2，`pixelRatioCap=2` 时 drawing buffer 分别为 1280×720 / 1920×1080 / 2560×1440，与 `CSS × min(DPR, cap)` 一致；CSS 锚点在三种 DPR 下均可点中（6/6、3/3、8/8）。
- **CSS ↔ drawing buffer**：锚点以 CSS 左上原点暴露，探针 region 用 buffer 左下原点，二者在 1.5 与 2 倍下都换算正确（点中率 100%）。
- **过期拾取**：相机重置后 `frameVersion` 从 2 → 3，`pick()` 返回的 `frameVersion` 等于当前值，不返回旧值。
- **视口变化**：容器改到 960×540 后重新扫描，锚点全部落在新盒内，`pick()` 仍能命中（`radio-far-side` at 288.5, 254.5）。
- **空击 / 阴影中心**：阴影中心不是夹具；`clear()` 能清选择；逐源 mask 隔离中 101/102/103 各自只出现在自己的 id 上（104 仍缺，见 §1.4）。

---

## 6. 本轮执行了 / 未执行

已执行（全部真实运行）：

- `node tools/validate-imaging.mjs` → 197/197，含 13 组；物理阈值未改。
- `node tools/validate-radio-imaging.mjs` → 69/69。
- 真实浏览器 GPU：Helium（Chromium）WebGL2，`webgl2` 上下文，1280×720，DPR 1 / 1.5 / 2；结果目录 `docs/radio-gpu-harness/artifacts/round3-20261023e/`（`round3-results.json`、`page-colour-diff.json`、4 张截图）。
- `npm run build` → `client.stage.js` 2,055,806 B；`client.radio.js` 内容未变；`client.js` 仅 mtime 更新。

未执行及原因：

- **未重生成测地线表**（`tools/build-tables.mjs` 未运行）：本轮任务明确禁止；而 §1.3 的修复需要更细的表。
- **未测 GPU 计时扩展**：`EXT_disjoint_timer_query_webgl2` 在本浏览器可用，但本轮没有做“修复前后计时对比”，因为无法在修复前重跑旧代码；表中只记“扩展可用”，不给出耗时数字。
- **未测帧间隔/FPS**：没有做 `requestAnimationFrame` 间隔采样，所以本报告不提供任何性能数字。
- **未测 4 类源在 Kerr / 自旋 / 任意三维源下的行为**：超出本阶段范围。

---

## 7. 结果分级（63 项 + 11 项）

**通过（真实 GPU，45/63 + 11/11）**：颜色开/关两层证据；近侧、远侧的像位置（≤1.2 px）与条带形状；同源多像同业务 ID（近轴上/下两弧均为 103）；空击与阴影中心；逐源隔离 101–103；默认页面无 overlay；相机重置后一致性；DPR 1/1.5/2 映射与拾取；视口变化后拾取；表纹理释放（`gl.isTexture` 由 true 变 false）；查询清理与无 `INVALID_ENUM`；二次 `dispose()` 无害。

**实际行为失败（15 项，均为近轴 / 弱场）**：

| 检查 | 实测 | 期望（CPU oracle） | 归因 |
| --- | --- | --- | --- |
| 近轴上弧分段 | 1 px 单像素 × 若干 | 连续弧 141×16.5 px | 表分辨率（§1.3） |
| 近轴锚点数 | 5 | 2 | 同上 + 8 邻域后仍不连续 |
| 近轴位置 | 距期望 68–70 px | ≤3 px | 只在弧两端的节点像素成像 |
| 弱场 | 0 个像素 | 3.0×0.30 px | 未定位（§1.4） |
| +1 px 命中 | null | 同 id | 亚像素条带无相邻像素 |
| 重置/960×540 计数 | 7 / 7 | 与分段后的数量一致 | 分段结果的下游 |

**测试基础设施修正（3 条，已修，不算渲染失败）**：`id sweep` 半分辨率、探针分数原点、4 邻域连通。上一轮据此得出的“远侧色相假通过 / 近侧无颜色”结论已作废。

---

## 8. 下一项最小修复（建议，未实施）

1. 给探针加 41 = 交点 x、42 = 交点 y（world/shader 同空间），在 `radio-weak-field` 的预期像位逐像素读，与 CPU oracle 的 `(1174.5, 0.39)` 比：差值 > 0.05 就说明是 shader 交点算错，差值 < 0.05 但 `cov=0` 就说明是覆盖/标签逻辑。**先定位再改**。
2. 若 §1.3 的表分辨率确认为硬限制，需要单独批准重生成 `inverse_radius`（更细的 φ / u 采样，或按临界带自适应），并重跑 197 项 CPU 校验比对上游误差。
3. 只有这四项（含颜色与视口）都达到规格，才可把第二阶段标记为完成；此前保持“部分通过”。

---

## 9. 相对基线的恢复方式（未执行）

本轮修改只涉及 `src/`、`tools/validate-radio-imaging.mjs`、`docs/radio-gpu-harness/`、构建产物与 `client.js` 的 mtime。回到第一阶段冻结状态：

```bash
cd /c/Yu/dsh-blackhole-radio-lab
sha256sum -c docs/baseline/20261023-1117/SHA256SUMS.txt   # 先确认基线自身完整
tar -C docs/baseline/20261023-1117/files -cf - . | tar -C . -xf -
npm ci
```

这会覆盖本轮与第二阶段的源码改动，但**不会**删除本报告、结果目录与基线本身（它们不在 `files/` 里）。恢复后需重启宿主，因为 `client.stage.js` 的替换要靠重新加载插件生效——本轮没有重启宿主。

---

## 10. 复现命令

```bash
cd /c/Yu/dsh-blackhole-radio-lab
node tools/validate-imaging.mjs            # 197 项，exit 0
node tools/validate-radio-imaging.mjs      # 69 项，exit 0
node tools/harness-server.mjs --port 8741  # 静态服务（独立终端）
node /c/Work/scratch/p3/run-round3.mjs round3-manual   # 打开 Helium，跑 4 个阶段
python -c "..."                            # 见 page-colour-diff.json 生成方式
```

`run-round3.mjs` 依赖 ego-lite 的 `browser.json`（CDP 端口 4957）与 `C:\Work\scratch\p3\` 下的探针脚本；不带这些文件时，页面层证据可用 `docs/radio-gpu-harness/artifacts/round3-20261023e/` 的历史截图与 JSON 复核。

---

## 11. 证据文件

- `docs/radio-gpu-harness/artifacts/round3-20261023e/round3-results.json` —— 63 项检查、11 项本轮检查、锚点、探针开/关读数、DPR 结果。
- `docs/radio-gpu-harness/artifacts/round3-20261023e/page-colour-diff.json` —— 页面级开/关差分。
- `docs/radio-gpu-harness/artifacts/round3-20261023e/radio-on-1280x720.png` / `radio-off-1280x720.png` / `radio-dpr2-1280x720.png` / `radio-dpr1p5-1280x720.png`。
- 前两轮证据保持原样：`docs/phase2-report.md`、`docs/radio-gpu-harness/artifacts/gpu-results.json`、`docs/phase1-report.md`、`docs/imaging-verification-spec.md`。
