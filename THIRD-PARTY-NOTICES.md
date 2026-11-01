# 第三方组件与数据

本仓库自身代码以 MIT 许可发布（见 [LICENSE](LICENSE)）。下列第三方组件与数据各有其许可或来源条款，随包分发时一并向你声明。

## three.js

- 用途：黑洞舞台的全部三维渲染（事件视界、光子环、吸积盘、星点、星团）。
- 版本：0.186.x，作为开发依赖安装，构建时**内联**进 `client.stage.js`。
- 许可：MIT，Copyright © 2010-2026 three.js authors。
- 上游：<https://github.com/mrdoob/three.js>
- 义务：`client.stage.js` 顶部保留版权与许可声明行；MIT 全文见上游仓库与 `node_modules/three/LICENSE`。

## esbuild

- 用途：仅构建期使用（打包 `client.stage.js` / `client.radio.js`），不随包运行。
- 版本：0.28.x。
- 许可：MIT，Copyright (c) 2020 Evan Wallace。
- 上游：<https://github.com/evanw/esbuild>

## 电台目录数据（Radio Browser）

- 文件：`data/catalog.v1.json`、`data/catalog.v1.json.gz`。
- 来源：<https://www.radio-browser.info> 的公开 API，由 `tools/build-catalog.mjs` 抓取、探测、筛洗生成。
- 生成时间：2026-10-29T13:33:35.915Z；候选 50,000，探测后保留 24,514 台。
- 字段：台名、国家、语言、分类标签、码率、流地址等电台公开元数据。
- 上游条款（据其 API 文档 <https://api.radio-browser.info/>，访问日期 2026-10-31）：该 API「completely free and open source」，可用于自由与非自由软件，允许自建镜像与 fork；文档同时建议每次点击回传 `/json/url` 以便站点统计。
- 需要说明的是：该 API 文档只写了「可用于自由与非自由软件」，**没有**明确写出数据库集合本身的再分发许可。因此本仓库把这份目录视为「可公开获取的元数据快照」而非「已核实的自由许可数据集」：你可以用 `npm run build:catalog` 自行重建，也可以直接删掉这两个文件——插件在目录缺失时会退回运行时抓取。
- 音频流本身属于各家电台，本仓库不托管、不转存任何音频。

## 音频流与歌曲元数据

- 播放时，浏览器与 Host 会直接连接 `data/` 目录里记录的第三方电台流地址。
- 曲目信息来自流内的 `icy-metaint` 元数据块，Host 只取一个元数据块即断开（见 `src/host/now-playing.js`）。
- 这些连接会把你的 IP 地址暴露给对应电台，与本仓库作者无关，也不经作者服务器中转。
