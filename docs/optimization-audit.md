# 优化审计笔记

- 对象：`dsh-blackhole-radio-lab` v1.2.4
- 日期：2026-11-07
- 性质：审计为主；维度 2① 与维度 3-P2 经用户明确授权执行了改动
- 方法：结构级快扫 + esbuild 元数据实测 + 导入图/导出扫描
- 状态：维度 2 已完成；维度 3 完成（P2 死导出 + P1 工具函数收敛）；维度 4 完成；维度 5 完成（遗留版本号一致性待定）

## 审计契约（来自 grilling 对齐）

- 目标维度：②体积 ③可维护性 ④依赖与健壮性 ⑤例行体检（**不看**运行时卡顿）。
- 产出：只读报告，对话内 Markdown + 本笔记；不改代码。
- 范围：只审「会发布 + 会运行」的部分——`client.js`、`client.stage.js`、`client.radio.js`、`client.hls.js`、`src/`、`tools/build-stage.mjs`、`tools/build-catalog.mjs`、`data/`。`docs/baseline`、`prototype`、测试脚本只做提示，不逐行审。
- 冻结区：黑洞+吸积盘成像、左栏电台卡片——只标注，不作默认改动建议。

---

## 维度 2 · 体积

### 2.1 三口径总览

| 口径 | 现状 | 主要问题 |
|---|---|---|
| npm 包体 | ≈ **27.9 MB** | `data` 两份 22.8 MB，其中裸 JSON 18.1 MB 与 gz 4.7 MB 重复 |
| 浏览器加载 | `client.stage.js` 2.14 MB raw / gzip 1.11 MB / brotli 0.93 MB | 其中 ray 表占 **65.9%** |
| 仓库克隆体 | 含 `docs/baseline`、`prototype` 多份整文件快照 | 不进 npm 包，只影响 clone |

### 2.2 npm 包体 ≈ 27.9 MB —— 高收益、低风险（建议先做）

组成（实测）：

| 部分 | 大小 |
|---|---|
| `data/catalog.v1.json`（裸 JSON） | **18.1 MB** |
| `data/catalog.v1.json.gz` | 4.7 MB |
| `client.stage.js` | 2.14 MB |
| `client.hls.js` | 0.59 MB |
| `client.js`（入口） | 0.20 MB |
| `client.radio.js` | 0.07 MB |
| `src/`（源码，随包发布） | 2.1 MB |
| locale + README/CHANGELOG/LICENSE 等 | ≈0.1 MB |

**结论：从 `package.json` 的 `files` 去掉 `data/catalog.v1.json`，包体 27.9 MB → ≈9.8 MB，省 ≈18.1 MB。**

安全性已逐条验证：
- 运行时能只用 gz：`index.js:71-84` 的 `readSnapshotPair` 对两个路径的 `statSync` 都包了 try/catch，缺裸 JSON 时不抛错；`index.js:94` `if (!json && gz) json = gunzipSync(gz)` 在内存重建；`index.js:95` 反向也成立。即**装好后只剩 `.gz` 仍可正常服务**。
- 路由按压缩协商回包：`index.js:413-428` 依 `accept-encoding: gzip` 直接回 gz。

两个必须写明的注意点：
1. **只改 `files` 白名单，不删仓库里的裸 JSON。** 因为开发/CI 侧仍需要它：`tools/test-radio-entry.mjs:31`、`tools/validate-radio-data.mjs:439` 直接读 `../data/catalog.v1.json`；`tools/build-catalog.mjs` 同时产出两份。
2. 维护者在 `src/host/catalog-refresh.js:12-13` 写了保留两份的理由：「CLI build 也用于 CI，人可能要 diff 纯 JSON」。这是**构建/CI 诉求，不是 npm 安装包诉求**——`files` 白名单排除裸 JSON 后，CI 仍能在仓库内 diff，安装用户体验不受影响，18 MB 成本可省。此项属需你拍板的取舍，本笔记只陈述利弊。

### 2.3 浏览器加载 —— `client.stage.js` 2.14 MB，ray 表占 65.9%

esbuild 元数据实测（minified，总 2,140,282 B）：

| 模块 | bytes | 占比 |
|---|---|---|
| `src/scene/ray-tables.data.js` | **1,410,126** | **65.9%** |
| `node_modules/three/build/three.module.js` | 355,628 | 16.6% |
| `node_modules/three/build/three.core.js` | 176,698 | 8.3% |
| `src/scene/geodesic.glsl.js` | 67,943 | 3.2% |
| `src/stage.js` | 41,240 | 1.9% |
| 其余（stations-layer、accretion-disk、disc-transfer…） | 合计 ≈8% | |
| 汇总：three 合计 532,326（24.9%），应用+其他 1,607,956（75.1%） | | |

- **ray 表是最大单项（1.41 MB）**，且它是**冻结区文件**（黑洞成像），本笔记只列不作默认建议。
- 更正（实测复核）：ray 表**已经是 base64 编码内联**，不是裸数字字面量。`ray-tables.js:4-9` 明确写了「base64 后约 1.4 MB 脚本，代替 2.1 MB 二进制，避免第二条 HTTP 路由」。所以外置成 `.bin` 最多省约 0.35 MB 原始字节（base64 的 4/3 膨胀），却要新增一个异步 fetch 与失败回退路径；维护者已权衡过并选择内联。**收益有限，不推荐**。
- `three` 内联 532 KB 属必要开销；`client.hls.js` 590 KB 中 **99.8% 是 hls.js 本身**（`node_modules/hls.js/dist/hls.mjs` 589,270 B），已懒加载，合理。`client.radio.js` 67 KB 全是应用代码。

### 2.4 仓库克隆体（不进 npm 包）

`docs/baseline/`、`prototype/`、`docs/*-harness/` 不在 `files` 白名单。`docs/baseline/20261023-1117/files/` 下有整份源码快照（如 5397 行 `client.stage` 副本、11794 行 `ray-tables` 副本），**只影响 git clone 体积，不影响发布与运行**，非必须处理；若在意，可迁到独立分支或外部归档。

### 2.5 维度 2 结论

| 优先级 | 动作 | 收益 | 风险 | 冻结 |
|---|---|---|---|---|
| **P0** | `files` 去掉裸 JSON（仓库保留） | 省 18.1 MB 包体 | 低（gz-only 已验证可跑） | 否 |
| P1 | ray 表移出 JS 改二进制按需加载 | stage 包显著缩小（1.4 MB 档） | 高（成像冻结） | **是** |
| P3 | 仓库快照归档 | 仅减 clone 体积 | 低 | 否 |

### 2.6 影响分析：三项「删了会怎样」

**① 去掉裸 JSON —— 无功能影响（前提：只改 `files`，仓库保留）**
- 运行时：`index.js:71-84` 两个 `statSync` 均 try/catch，缺裸 JSON 不抛错；`index.js:94` 用 gz 在内存 `gunzipSync` 重建，再进 `snapshotCache`（`:110`，最多 8 项）。
- 代价：首次读目录时把 4.97 MB 的 gz 解压成 18 MB 字符串一次（之后命中缓存）。内存里本来就同时持有 json(18 MB)+gz(5 MB)，与改动前相同。冷读多一次解压 CPU，可忽略。
- 若**连仓库里的裸 JSON 也删**：会断掉开发/CI 侧——`tools/test-radio-entry.mjs:31`、`tools/validate-radio-data.mjs:439` 直接读它，`tools/build-catalog.mjs` 也产出它。所以仓库里必须留。
- 发行侧唯一影响：npm 用户想看纯文本目录需自己 gunzip（gz 仍在包内），基本可忽略。

**② 浏览器加载「删」—— 没有可删的死重量**
- `ray-tables.data.js` 1.41 MB：黑洞引力透镜的必需数据，`ray-tables.js:130-131` 直接喂 GPU 纹理（`RAY_TABLES.deflection` / `inverse_radius`）。删 → 成像直接坏。且它已 base64 内联（见上），外置仅省 ~0.35 MB 还引入加载失败路径，冻结区内，性价比低。
- `three` 532 KB：WebGL 引擎，必需，无可瘦路径。
- `geodesic.glsl.js` 68 KB：shader 源码（冻结）。
- `client.hls.js` 590 KB：99.8% 是 hls.js，仅当电台需要 HLS 时才懒加载；删 → HLS 电台不可播。
- 结论：浏览器侧能动的只有「ray 表外置（收益 ~0.3 MB、有风险、冻结）」，没有能直接删的。

**③ 仓库克隆体「删」—— 部分不能删**
- `docs/baseline/`：**被工具依赖**——`tools/validate-radio-imaging.mjs:12,50` 明确读取 `docs/baseline/fixtures-probe/` 作为成像校验的基准数据。删它会断掉该校验。它是成像回归的基线存档，**不能直接删**；要瘦身只能 relocate 并同步改工具路径。
- `prototype/`：`ARCHIVED.md:10` 记为左栏电台卡片的独立原型（隔离构建 + 本地预览），代码无引用。删它只失去原型/预览，无运行时影响。
- 两者都不进 npm 包，删只减 clone 体积；且按 A2，清理一律走回收站。

**总评**：三项里，**只有①是干净可做的（省 18 MB、无功能影响）**；②基本没有真收益且涉冻结；③中 `docs/baseline` 还被校验工具依赖，不能盲删。

### 2.7 决策与执行（2026-11-07）

用户决定：**①做，②③不做**。已执行①：

- 改动：`package.json` 的 `files` 白名单移除 `"data/catalog.v1.json"`，保留 `"data/catalog.v1.json.gz"`；**仓库内裸 JSON 原样保留**（开发/CI/校验工具依赖）。
- 备份：`C:\Users\Axiom\.dsh\backups\package.json.bak-20261107-221605`
- 实测（`npm pack --dry-run --json`）：
  - `unpackedSize` = **9.8 MB**（改前 ≈27.9 MB）
  - tarball `size`（gz）= **7.2 MB**
  - 包内**不含** `data/catalog.v1.json`，**含** `data/catalog.v1.json.gz`
  - 包内最大四项：`catalog.v1.json.gz` 4.97 MB、`client.stage.js` 2.14 MB、`ray-tables.data.js` 1.54 MB、`client.hls.js` 0.59 MB
- 运行时安全性依据：`index.js:71-84`（两个 `statSync` 均 try/catch）+ `index.js:94`（gz 在内存重建）。

---

## 维度 3 · 可维护性

### 3.1 阶段一结构快扫（只读实测；shipped 源码 44 文件 / 22102 行）

体量集中（行数）：

| 行数 | 文件 |
|---|---|
| 4337 | `client.js` |
| 3934 | `src/stage.js` |
| 1730 | `src/scene/geodesic.glsl.js`（冻结·成像） |
| 1516 | `src/nodes/stations-layer.js` |
| 780 | `src/radio/repository.js` |
| 775 | `src/scene/accretion-disk.js`（冻结·成像） |

巨型函数（花括号实测跨度）：

| 函数 | 位置 | 跨度 |
|---|---|---|
| `mountStage` | `src/stage.js:166-3821` | 3656 行（占文件 93%） |
| `Panel` | `client.js:2499-3573` | 1075 行 |
| `StationFootCard` | `client.js:1698-2384` | 687 行（冻结卡片） |
| `createSharedState` | `client.js:483-1017` | 535 行 |

重复工具函数（clamp 家族，10 处 / 6 文件）：
- `clamp()`：`cluster/layout.js:399`、`radio/distribution.js:323`、`scene/camera-rig.js:408`（三份同签）
- `clamp01()`：`cluster/forms.js:392`、`nodes/stations-layer.js:1508`、`stage.js:3911`
- smoothstep 变体：`nodes/stations-layer.js:724`、`:1512`、`stage.js:3915`
- 另有 `clampRatio`（`stage.js:3906`）

### 3.2 死导出（全仓引用重算，含 `tools/test-*.mjs`、`validate-*.mjs`）

初扫 238 个 src 导出中，29 个零外部引用：A 真死可删 12、B 仅本文件用可去 export 16、冻结 1。

### 3.3 P2 执行（2026-11-07，已授权）

删除声明（A，非冻结）12 处：`FORM_LABELS`、`FORM_GENRE_ORDER`、`colorCssOf`、`tagTintRgb`（`cluster/forms.js`）、`pickGroup`（`cluster/layout.js`）、`isHlsUrl`（`hls.js`）、`CATEGORY_RULES`（`radio/radio-browser.js:336`，别名 export `RULES_BY_ID as CATEGORY_RULES` 整行删除）、`STATION_MAPPING`（`radio/repository.js:779`，别名 export 改为 `export { streamUrlFor }`）、`fixtureByBusinessId`（`scene/radio-fixtures.js`）、`fieldAzimuthUv`、`fieldRadiusUv`（`scene/station-field.js`）。

去掉多余 `export`（B，非冻结）16 处：`GENRE_FORMS`/`GENRE_COLORS`/`colorOf`（forms.js）、`primaryGenreOf`/`primaryCategoryOf`/`shellDirection`（layout.js）、`BUILDER_USER_AGENT`/`BUILDER_DEFAULTS`（host/catalog-builder.js）、`CACHE_DIR`（host/catalog-refresh.js）、`sanitizeLibrary`（host/library.js）、`NOW_PLAYING_TIMEOUT_MS`/`NOW_PLAYING_TTL_MS`/`extractStreamTitle`（host/now-playing.js）、`toShaderFixture`（scene/radio-fixtures.js）、`FIELD_WIDTH`/`FIELD_HEIGHT`（scene/station-field.js）。

连带清理：`radio/repository.js:45` 的 import 移除已不用的 `MAPPING`。

保守保留不动：`maxOrbitRadiusForShadow`（`scene/dimensions.js`，成像相关常量，未删待确认边界）、`RADIO_SLOTS`（`scene/accretion-disk.js`，冻结）。

验证：
- `node --check` 11 个被改文件全过。
- `npm test` **35/35 通过**（含 entry evaluation / inject / apply）。
- `npm run build`（`node tools/build-stage.mjs`）成功：`client.stage.js` 2141591 B（gz 1111689 / br 930003）、`client.radio.js` 69291 B、`client.hls.js` 591836 B。
- 复扫：src 导出 238 → **211**；零外部引用仅剩 2（即上面保留的两项）。
- 备份：`C:\Users\Axiom\.dsh\backups\optimization-audit-p2-20261107-222851\`（11 个源文件）。

### 3.4 仍存在（下一轮候选）

- P3 巨型函数 `mountStage`（`src/stage.js:166` 起，约 3656 行）、`Panel`（`client.js:2499` 起，约 1075 行）未动，建议只记技术债、暂不拆。
- 单文件专用小工具未提取：`clampRatio`（`stage.js`）、`inverseSmoothstep`（`stage.js`）、三参 `smoothstep(edge0,edge1,value)`（`nodes/stations-layer.js`）——单处使用，无需集中。

### 3.5 P1 执行（2026-11-07，已授权）

新建 `src/util/num.js`，收敛三处重复：

| 函数 | 原重复位置 | 处理 |
|---|---|---|
| `clamp(value,min,max)` | `cluster/layout.js`、`radio/distribution.js`、`scene/camera-rig.js` 各一份 | 统一 import |
| `clamp01(value)` | `cluster/forms.js`、`nodes/stations-layer.js`、`stage.js` 各一份 | 统一 import |
| `smoothstep01(value)` | `nodes/stations-layer.js`（函数内嵌套）、`stage.js` 各一份 | 统一 import |

- 语义归一（须记）：`clamp01` 采用防御式 `Math.min(1, Math.max(0, Number(value) || 0))`。forms 原本如此；stations/stage 原本无 `Number()` 强转，唯一差别是 NaN/undefined 输入由「返回 NaN」变为「返回 0」（数值输入结果完全一致，属更稳的边界处理）。
- 顺带删除：`src/scene/dimensions.js` 的 `maxOrbitRadiusForShadow`（用户指示删）；删后其唯一依赖者 `shadowScreenFraction` 变成零引用，一并删除；`shadowAngularRadius` 仍被 `stage.js` 使用，保留。
- 验证：8 文件 `node --check` 全过；`npm test` **35/35**；`npm run build` 成功——`client.stage.js` 2141406 B（gz 1111685 / br 931641）、`client.radio.js` 69291 B、`client.hls.js` 591836 B（hls 未变）。
- 备份：`C:\Users\Axiom\.dsh\backups\optimization-p1-20261107-223741\`（含 dimensions.js；其余可从 git 追溯）。
- 注意：build 重写 `client.stage.js`/`client.radio.js`（hls 未变），产物已与当前 src 一致。

### 3.6 暂缓 / 不建议（P3、P4）

- **P3 拆巨型函数**：`mountStage`（`src/stage.js:166`，≈3656 行）、`Panel`（`client.js:2499`，≈1075 行）、`createSharedState`（`client.js:483`，≈535 行）。收益仅可读性，体积/性能≈0；风险高（WebGL 装配、冻结成像、过渡状态机交织，且视觉回归测试不足）。**结论：只记录，暂不做**；若日后要大改，仅提取低耦合纯函数并配单测。
- **P4 单体结构拆分**：`client.js`（4337 行单 factory）+ `stage.js` 单文件装配拆模块。收益仅可维护性；风险最高（牵涉冻结卡片/面板/播放通用能力）。**结论：不建议**。

## 维度 4 · 依赖与健壮性

### 4.1 依赖清单（shipped / 运行相关）

| 类别 | 依赖 | 说明 |
|---|---|---|
| 运行时 `dependencies` | `hls.js ^1.7.4` | **唯一运行时依赖**；仅 HLS 电台时懒加载（`client.hls.js`） |
| 构建期 `devDependencies` | `three ^0.186.1` | 内联进 `client.stage.js`，运行期不是独立依赖 |
| 构建期 `devDependencies` | `esbuild ^0.28.2` | 仅 `tools/build-stage.mjs`；`allowScripts` 放行 |
| `engines` | `node >=20` | |
| dsh 集成 | inject `@deepseek-ai/dsh-client-ui-sidebar` | 由 harness 提供，不随包安装 |
| 兼容 | dsh `0.2.1-rc.2` / `0.2.2-rc.1` = compatible | |
| 锁文件 | `package-lock.json`（存在） | 可复现安装 |
| 许可 | MIT + `LICENSE-BLACK_HOLE_SHADER` + `THIRD-PARTY-NOTICES.md` | |

`src/` 的外部 import 只有 `three`、`hls.js`，其余全是 Node 内置（`fs`/`zlib`/`os`/`path`/`dns/promises`/`net`）。无其它第三方包。

### 4.2 依赖健康

- 无多余、无未用依赖：`three` 被 `scene/*` 使用；`hls.js` 仅 `src/hls.js`；`esbuild` 仅构建脚本。
- 版本范围合理（`^`，由 lock 锁定）。未见已知风险项。
- 运行时攻击面极小：外部包只有 `hls.js` 一个，且懒加载。

### 4.3 健壮性机制（实测证据）

- 联网一律带超时/取消：`catalog-builder.js:123-124`、`catalog-refresh.js:165-169`（deadline + `unref`）、`now-playing.js:299-300`、`repository.js:174-236`（`fetchJson` 与自有计时赛跑 + `request.catch(()=>{})` 防未处理拒绝 + `credentials:'omit'`）、`metadata-poll.js:17`、`cache.js:82`。
- `JSON.parse` 全部有保护：`library.js:119-130`（try/catch → `null`）；`catalog-refresh.js:40-47`（try/catch → `false`，坏缓存当过期 → 触发重建）；`repository` 的 parse 处于被捕获的请求内。
- 原子写盘：`library.js:145-149`（按进程 + 时间戳命名临时文件再 `rename`，避免并发互相覆盖）；`catalog-refresh.js:74-89` 清理残留 `.tmp-` + 原子替换缓存。
- SSRF / 内网防护：`now-playing.js:304-348` 手动跟随重定向、仅 http/https、拒 userinfo 与私有主机、DNS 解析校验、逐跳检查。
- 路由加固：`index.js` catalog 路由 etag/304、按 `accept-encoding` 解析 q 值回 gz、`writeHead` 容错；library POST 强制 `application/json` + `sec-fetch-site` 同源 + 体积上限 + 405；now-playing 应答 `.catch → 502`。
- 播放重试：`playback.js:76-78` 三次尝试（初始 + 1s + 2s）。
- 目录多源回退：`repository.js:647-772` 多主机尝试、记录 `attempts`、预算超时，失败返回结构化 `{ok:false,reason,...}` 而不抛。
- 后台定时器 `unref`（`catalog-refresh.js:150,170`），不阻止宿主进程退出。
- 测试：`tools/test-radio-resilience.mjs`、`test-now-playing.mjs`、`test-transition.mjs`、`test-radio-entry.mjs`；`npm test` 35/35。

### 4.4 残留风险（记录，非必须改）

- `fetchJson` 放弃的请求会跑到传输层放弃为止（注释已声明，代价一个空闲 socket），可接受。
- 插件无进程级 `unhandledRejection`/`uncaughtException` 兜底，依赖 harness；插件形态下可接受。
- `now-playing` 的 SSRF 是「先解析 DNS 再连接」，理论上有 DNS rebinding 的 TOCTOU 残余，已逐跳校验，属标准残余。
- `hls.js` 用 `^1.7.4`，无精确锁定（由 `package-lock.json` 固定）。

### 4.5 维度 4 结论

依赖面极小且健康（单一运行时依赖、无冗余、有锁文件与许可）；健壮性明显高于平均（超时、原子写、输入上限、SSRF 防护、多源回退、重试、测试覆盖）。**无可执行的高收益改动项，仅记录。**

## 维度 5 · 例行体检

### 5.1 检查项与结果

| 项 | 结果 | 证据 |
|---|---|---|
| 包元数据 | 正常 | `package.json`：main/exports/files/dsh 均齐全 |
| **版本一致性** | **✗ 不一致** | `package.json` 1.2.4；`README.md:9`、`README.en.md:9` 标 v1.2.1；`CHANGELOG.md:5`、`CHANGELOG.en.md:5` 最高 `[1.2.1]`；git 最近 release 提交 `v1.2.3`；缺 1.2.2/1.2.3/1.2.4 条目 |
| 依赖清单 | 正常 | 运行时仅 `hls.js`（见维度 4） |
| 锁文件 | 正常 | `package-lock.json` 存在 |
| 许可 / 第三方 | 正常 | `LICENSE`、`LICENSE-BLACK_HOLE_SHADER`、`THIRD-PARTY-NOTICES.md` |
| 双语文档 | 正常 | `README.md`/`README.en.md`、`CHANGELOG.md`/`CHANGELOG.en.md` |
| 资源 | 正常 | `assets/demo.gif` 存在（README 引用） |
| 配置 | 正常 | `cordis.patch.yml` 存在；`locale/en.json`、`locale/zh.json` 均可解析 |
| `.gitignore` | 正常 | 覆盖依赖、凭据、构建缓存、日志、编辑器、`*.bak` |
| 仓库卫生 | 正常 | 无 `.tgz`/`.bak`/`node_modules` 入库；330 tracked |
| 构建 | 正常 | `npm run build` 成功（见 3.3/3.5） |
| 测试 | 正常 | `npm test` 35/35 |
| **CI** | **✗ 无** | 无 `.github/workflows`，仅本地 `npm test` |
| 工作区状态 | ⚠ 脏 | 33 个 `M` + 5 个 `??`，混有本次改动与既有未提交改动 |

### 5.2 发现

1. **版本号漂移（唯一实质问题）**：包 `1.2.4`、文档 `v1.2.1`、最近 release 提交 `v1.2.3`；`CHANGELOG` 缺 `1.2.2`–`1.2.4` 条目。属文档滞后，不影响运行与发布功能，但对外发布前应统一。
2. **无 CI**：仅本地 `npm test`，无自动化门禁。可选，非必须。
3. **工作区脏**：本次改动（P1/P2 + `package.json` + 本笔记 + 重建的 `client.*.js` 产物）与既有未提交改动混在一起，提交前需按清单分拣。

### 5.3 维度 5 结论

除「版本号 / CHANGELOG 滞后」外，其余例行体检项均正常。版本一致性是否现在统一，由用户决定（需用户给出 `1.2.2`–`1.2.4` 的变更内容，或授权按提交记录整理）。

### 5.4 版本统一执行（2026-11-07，已授权）

用户决定统一到 **1.2.6**。已执行：

- `package.json` 版本 → `1.2.6`；`README.md:9`、`README.en.md:9` 版本标签 → `v1.2.6`。
- `CHANGELOG.md` / `CHANGELOG.en.md` 补齐 `1.2.2`–`1.2.6` 条目：
  - `1.2.2` 兼容性（`dshReleases` 加 `0.2.2-rc.1`）；`1.2.3` 维护性发布（无功能变更）；`1.2.4` 电台断流退避重连 / 跳过死台 / 停止失败恢复原台；`1.2.6` 本次审计（体积优化 + P2 死导出 + P1 工具函数收敛 + 删 `maxOrbitRadiusForShadow`）。
  - `1.2.5` 标注为「npm 误发、本地跳过」——实测 npm：`latest`=1.2.3，且 1.2.2/1.2.4/1.2.5 均于 11-05 从同一 commit `80dbf68` 误发，故本地不占用 1.2.5，直接跳 1.2.6。
- CI：已向用户解释（push/PR 自动跑构建与测试的门禁）；本仓当前无 CI，是否添加待定，本次未改动。
- 备份：`C:\Users\Axiom\.dsh\backups\version-unify-20261107-225326\`（package.json、README.md、README.en.md、CHANGELOG.md、CHANGELOG.en.md）。
- 校验：`package.version` = 1.2.6；两 README 版本串 = `v1.2.6`；两 CHANGELOG 标题序 `1.2.6 → 1.2.0` 一致。

---

## 变更记录

- 2026-11-07：建立笔记，完成维度 2（体积）。
- 2026-11-07：补维度 2 影响分析（2.6）；定稿决策 ①做②③不做并执行①，`package.json` 移除裸 JSON，实测包体 27.9→9.8 MB。备份见 2.7。
- 2026-11-07：补维度 3 阶段一（结构快扫）+ 死导出全仓重算；执行 P2（删除/收敛死导出，仅非冻结），`node --check` 全过、`npm test` 35/35、`npm run build` 成功，src 导出 238→211，零外部引用仅剩 2。备份见 3.3。
- 2026-11-07：删除 `maxOrbitRadiusForShadow` 及其孤儿 `shadowScreenFraction`；执行 P1，新建 `src/util/num.js` 收敛 `clamp`/`clamp01`/`smoothstep01`（3+3+2 份 → 1 份），8 文件 `node --check` 过、`npm test` 35/35、`npm run build` 成功。备份见 3.5。
- 2026-11-07：完成维度 4（依赖与健壮性）审计：依赖面仅 `hls.js` 一个运行时依赖，健壮性机制齐备；无可执行高收益项，见 4.1–4.5。
- 2026-11-07：完成维度 5（例行体检）：发现版本号漂移（包 1.2.4 / 文档 1.2.1 / 最近 release 提交 v1.2.3，CHANGELOG 缺 1.2.2–1.2.4）、无 CI、工作区脏；其余卫生项正常。见 5.1–5.3。
- 2026-11-07：按用户决定将版本统一到 `1.2.6`（package.json / README 双语 / CHANGELOG 双语），补齐 1.2.2–1.2.6 条目（1.2.5 记 npm 误发跳过）。见 5.4。
