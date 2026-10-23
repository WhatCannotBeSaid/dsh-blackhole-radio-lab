# 流派分类层报告（阶段 2）

日期：2026-10-23　范围：数据分类层，不涉及渲染、相机、动画与 UI。

## 1. 为什么要有第二套分类

项目里已经有一套八类 `taxonomy`：`music / news / talk / classical / jazz / electronic / world / ambient`。
它的用途是给吸积盘上的星点分配颜色，权重按画面调过，不承担"用户想按流派找台"的语义。
Radio Browser 的 `tags` 是自由文本，同一件事有十几种写法，不能直接当星云。

因此新增独立层 `src/radio/genres.js`，两套分类并存，职责分开：

| 层 | 回答的问题 | 是否随数据变化 |
| --- | --- | --- |
| `taxonomy.js`（8 类，未改） | 这颗星点在盘面上是什么颜色 | 否，常量 |
| `genres.js`（13 类，新增） | 这家电台属于哪个星云 | 定义固定；**显示分组**随样本变化 |

`taxonomy.js` 一个字节未改，`CATEGORIES`、`categoryCss` 等导出与颜色全部原样。

## 2. 分类规则

1. 只有 `tags` 与台名是证据，不编造。两者都没有时（模拟数据、或真实数据里没标签的台），退一步使用记录上已有的八类 `categories` 作为**弱证据**，权重 2，低于任何真实 tag 的 3。
2. 规范化：小写 → 去变音符 → `R&B` 拼成 `rnb` → `&` 展开成 `and` → 标点换空格。`Música Clásica` 与 `MUSICA CLASICA` 落到同一个 key。
3. 匹配分两档：tag 精确命中 +3，整词短语命中 +1（`jazz funk` 命中 jazz，`rocksteady` 不命中 rock），台名短语 +1。两侧补空格做整词判断，短词不会误伤长词。
4. 冲突：先比分数，再比 `tier`。`news 20 / sports 19 / talk 18`，音乐类 8。所以 `news, jazz` 判新闻，`jazz, jazz music, news` 判爵士——两个音乐证据能压过一个内容证据。
5. 每个电台只有一个主流派，`genres` 数组预留，第一版不填第二个。
6. 无证据 → `other`，同时 `metadata.genreMatched = false`，面板能区分"归到其他"和"识别成功"。
7. 排序：`tagsOf()` 会排序后打分，结果与 API 返回的标签顺序、行顺序无关；200 次乱序排列结果一致。

## 3. 显示分组与真实数量分开建模

`summarizeGenres(stations)` 同时给出两份账：

- `raw[13]`：真实分类数量，不合并、不丢弃。
- `visible[]`：可以成为星云的显示组。规则是——0 台的类不显示；1–2 台的类并入 `other`；其余独立成组。

被并入的台在数据里仍然是原分类（`listByGenre(id, {display:false})` 能查到），同时一定出现在 `other` 里（`listByGenre('other')`），不会被藏起来。`displayTotal` 与 `total` 必须相等，测试里守着这条。

## 4. 真实抓取样本（2026-10-23，240 台，`order=clickcount`）

| 类别 | 数量 | 占比 | 显示 |
| --- | --- | --- | --- |
| pop | 55 | 22.9% | 星云 |
| news | 43 | 17.9% | 星云 |
| talk | 15 | 6.3% | 星云 |
| rock | 15 | 6.3% | 星云 |
| folk-world | 10 | 4.2% | 星云 |
| electronic | 9 | 3.8% | 星云 |
| ambient | 9 | 3.8% | 星云 |
| jazz | 7 | 2.9% | 星云 |
| classical | 4 | 1.7% | 星云 |
| hip-hop | 3 | 1.3% | 星云 |
| blues-soul | 1 | 0.4% | 并入 other |
| sports | 1 | 0.4% | 并入 other |
| other | 68 | 28.3% | 星云 |
| **other 合计** | **70** | **29.2%** | 68 原始 + 2 并入 |

本次样本可见星云 11 个，无空星云。总耗时 2.2 s（3 个镜像、预算 20 s）。

### 已知问题

1. **Other 占比 29.2%，但其中 52/68 是完全无标签的台**（全样本 240 台里有 59 台 24.6% 没有任何 tag）。这部分不是分类漏判，是数据本身没有信号。剩余 16 台有标签但未命中的台，逐条审查见第 9 节；本轮只记录，不改词表。
2. **pop 偏高（22.9%）**：`pop` 词表覆盖 `top 40 / hits / charts / oldies / 80s / 90s / variety`，热门台榜（clickcount 排序）本来就以综合流行台为主。证据分布是 `tag×49 + tag~hits×5 + tag~adult contemporary×1`，全部来自真实标签，不是台名硬凑。
3. **blues-soul 与 sports 各只有 1 台**，按规则并入 other。这是样本问题（240 台里确实没有第二个），不是分类问题；样本量放大到 2000 台时这两类大概率能独立成云。
4. 以上数字只描述本次 240 台样本，不代表 Radio Browser 全库。

## 5. Repository 新增接口

全部是增量，旧接口未改：

```js
repository.genres()      // { definitions: 13 个固定定义, ...summarizeGenres() }
repository.visibleGenres()   // 可成为星云的显示组，含 count 与 mergedIds
repository.genreCounts()     // { genreId: count }，13 个键
repository.listByGenre(id, { display = true })
    // display:true 按显示组解析（小类 → other，other 含并入的台）
    // display:false 按原始分类解析（被并入的台仍可查到）
```

`stats()` 增补 `genres / genreVisible / genreMerged` 三个字段；`search()` 的 haystack 加入流派中英文名与 id，搜 "jazz" 或 "爵士" 都能命中。
`buildRepository()` 是两套数据源的唯一装配点，所以模拟源与真实源都自动带上流派，降级路径不需要额外处理。

## 6. 验证

| 命令 | 结果 |
| --- | --- |
| `node tools/validate-genres.mjs` | GENRE CHECKS PASSED，180 项（含 1 次真实抓取；`--offline-only` 时 174 项） |
| `node tools/validate-radio-data.mjs` | RADIO DATA CHECKS PASSED，120 项 |
| `node tools/validate-imaging.mjs` | ALL CHECKS PASSED，197 项 |
| `node tools/validate-radio-imaging.mjs` | RADIO FIXTURE CHECKS PASSED，69 项 |
| `npm run build` | 成功；`client.stage.js` 未变（2,070,462 B），`client.radio.js` 41,018 → 51,397 B |

`validate-genres.mjs` 分九节：vocabulary（13 类完整性、冻结、颜色、与 8 类的关系）、matching（规范化与同义词、复合标签、整词边界、台名弱证据）、conflicts（内容类压过单个音乐 tag、双音乐 tag 反压）、determinism（200 次乱序、幂等、纯读）、fallback（无标签/未知标签/分类弱证据）、display（合并、隐藏、数量守恒、other 可回查）、repository（新旧接口、数量守恒、三视图一致性）、sources（模拟源与降级路径）、live（真实样本统计）。

三视图一致性检查（repository 节 8 项 + live 节 1 项）是本轮新增，专门盯「被合并的台会不会变成孤岛」：

- `genreCounts()[id]` 必须等于 `listByGenre(id, { display: false }).length`，13 类逐一比对；
- `visibleGenres()[i].count` 必须等于 `listByGenre(visibleGenres()[i].id).length`；
- 每个被合并类别里的每一台，都必须能通过 `listByGenre('other')` 查到；
- `other` 里不能有重复记录；
- 全部显示组必须恰好把样本划分一次，每台出现且只出现一次；
- 被合并的类别不能出现在 visible 里，隐藏类别必须解析成空列表。

真实 240 台样本上这 9 项全部通过：13/13 计数一致、11 组显示组一致、显示组求和 240、merged 台全部可经 other 查到、显示组恰好划分 240/240。

## 7. 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/radio/genres.js` | 新增，13 类定义 + 规范化 + 打分 + 显示分组 |
| `src/radio/repository.js` | 装配时 `attachGenre`；新增 4 个流派接口；search haystack 补流派词；stats 补 3 个字段 |
| `src/radio/index.js` | 数据 chunk 导出流派层（供后续星云使用） |
| `tools/validate-genres.mjs` | 新增，180 项检查 |
| `client.radio.js` | 重新构建 |

未改：`src/stage.js`、`src/scene/*`、`src/nodes/*`、`src/cluster/*`、`client.js`、`taxonomy.js`、`radio-browser.js`。
未做：星云、场景状态机、播放器、搜索 UI 移除——留给后续阶段。

## 8. 下一阶段可以直接用的东西

- 星云数量取 `visibleGenres()`，颜色取定义里的 `color`（已按天文星云调成低饱和），尺寸按 `count`。
- 点星云 → `listByGenre(id)` 拿该云的真实电台，不需要再请求网络。
- 分类与视觉分离：加一个类别只改 `GENRES` 与词表，星云渲染逻辑不用动。

## 9. Other 逐条审查（16 台有标签但未命中，未改词表）

样本同上：240 台、`order=clickcount`、2026-10-23 抓取。下表是 `genre === 'other'` 且 `tagsOf()` 非空的全部记录。

| 电台 | 原始 tags | 现有分类 | 可能归属 | 归因 |
| --- | --- | --- | --- | --- |
| RTL | `généraliste` | music | 综合台，Pop 或 Talk 都可 | 格式词，无流派信息 |
| Radio Paradise Main Mix | `california, eclectic, free, internet, non-commercial, paradise, radio` | music | Rock / Pop（成人另类混播） | 格式词 + 自定义词 |
| CCTV-13新闻伴音 | `tv` | music | News | 名称含「新闻」，但名称提示只有英文 |
| Arabesk FM | `müzik, türkçe` | music | Folk & World（土耳其 arabesk） | 地区流派词缺失 |
| Cadena 100 | `music` | music | Pop（西班牙流行/摇滚金曲） | 只有通用词 |
| Radio Italia Solo Musica Italiana | `italian pop` | music | Pop | **短词短语匹配缺口** |
| RMF FM | `fm, rmf, rmffm` | music | Pop（波兰 AC 台） | 只有频段/台名缩写 |
| Mettaswara Koplo | `koplo` | music | Folk & World（印尼 dangdut koplo） | 地区流派词缺失 |
| 怀集音乐之声 | `music` | music | 中文流行 | 只有通用词 |
| Rádio Antena 1 94.7 FM | `adult, flashback` | music | Pop（AC / 怀旧金曲） | 词表只有 `adult contemporary` |
| REYFM - #original | `#original, fm, rey, reyfm` | music | 无流派信息 | 台名缩写 |
| Cadena Dial | `música en español` | music | Pop / Folk & World（西语流行） | 语言描述而非流派 |
| 华语金曲500首 | `golden music` | music | Pop（华语金曲） | 描述性短语 |
| Anime Para Ti | `anime, anime openings, jpop, music` | music | Pop（J-Pop） | **`jpop` 与 `j pop` 不同形** |
| Campursari FM Jakarta | `campursari, dangdut, koplo` | music | Folk & World（印尼传统） | 地区流派词缺失 |
| Türkülerle Türkiye | `türkü` | music | Folk & World（土耳其民歌） | 地区流派词缺失 |

标签频次（该组内，规范化后）：`music ×3`、`fm ×2`、`koplo ×2`，其余 19 个标签各出现 1 次：`adult / anime / anime openings / california / campursari / dangdut / eclectic / flashback / free / generaliste / golden music / internet / italian pop / jpop / musica en espanol / muzik / non commercial / original / paradise / radio / rey / reyfm / rmf / rmffm / turkce / turku / tv`。

四类归因，占比很清楚：

| 归因 | 台数 | 是否值得修 |
| --- | --- | --- |
| 地区流派词缺失（印尼/土耳其/西语） | 6 | 值得，`folk-world` 会从 10 涨到 15–16 |
| 短词短语匹配缺口（`pop` 只有 3 字符，被 4 字符下限挡在短语匹配外） | 2 | 值得，且是**规则**问题不是词表问题 |
| 名称提示只有英文（中文「新闻」） | 1 | 值得，但需要 CJK 专用匹配 |
| 纯格式/频段/自定义词，无流派信息 | 7 | **不建议修**，硬分会制造假分类 |

注意：这 16 台全部只带 `music` 这个八类标签，所以分类弱证据回退也不可能救回它们——`music` 被刻意排除在弱证据之外。

## 10. 分类优化建议（均未实施，等指令）

按收益与风险排序。所有改动都只落在 `src/radio/genres.js` 的 `RULE_TAGS` / `buildRules()`，不涉及渲染与 UI。

1. **短词短语匹配（规则，优先）**：短语匹配下限是 4 字符，`pop` / `rap` 因此只能精确命中，`italian pop`、`jpop` 都落空。词边界保护本身已经足够安全（`popular` 不会命中 `pop`），可以把下限降到 3，或对白名单短词单独放行。预计 pop +2，Other −2。
2. **地区流派词（词表）**：`koplo / campursari / dangdut / türkü / arabesk / música en español` → `folk-world`。预计 folk-world +5～6（10 → 15～16），Other −5～6。风险低，这些词没有歧义。
3. **CJK 名称提示（规则）**：中文没有空格，现有整词短语匹配对 CJK 无效。只对明确复合词做子串匹配：`新闻/新聞 → news`、`体育/體育 → sports`、`古典 → classical`、`爵士 → jazz`、`摇滚/搖滾 → rock`、`民谣/民謠 → folk-world`、`蓝调/藍調 → blues-soul`、`嘻哈/说唱 → hip-hop`。不要映射「音乐」这类通用词。预计 news +1，风险是单字词误伤，需要词级白名单。
4. **不要修的部分（设计选择）**：`music / fm / généraliste / eclectic / paradise / reyfm / tv / california` 这些是格式词、频段词或台名缩写，不构成流派证据。为了把 Other 从 29% 压到 25% 而把它们强行分配，等于造假数据，违反本阶段「不人为制造分类」的约束。
5. **弱证据不要扩大**：`music` 现在被排除在分类弱证据之外。不要为了覆盖这 16 台把 `music` 映射到 pop——那会让全库最大的一类标签变成 pop 的万能入口。
6. **阈值不要动**：`MIN_GENRE_STATIONS = 3` 在 240 台样本下把 blues-soul、sports 各 1 台并进 Other，样本放大到 2000 台后它们会自然独立成云。为单次样本调阈值会让星云数量随抓取抖动。

**预期收益上限**：以上 1–3 全做，Other 从 70（29.2%）降到约 58（24.2%），folk-world 10 → 15、pop 55 → 59、news 43 → 44。剩余 52 台无标签的台无论怎么改词表都救不回来，**Other 的天然下限约 21.7%**。这组数字也说明：靠词表优化把 Other 压到很低是不现实的，后续星云空间应把 Other 当成正常类别设计，而不是当作失败兜底。

每次改词表必须重跑 `validate-genres.mjs` 并记录改动前后的真实样本对比，避免为某一次抓取过拟合。
