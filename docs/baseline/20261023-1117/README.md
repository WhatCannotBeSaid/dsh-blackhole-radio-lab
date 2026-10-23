# 基线快照 20261023-1117

冻结时间：2026-10-23 11:17:37 +0800（采集），11:19:24 +0800（写入清单）。
项目：`C:\Yu\dsh-blackhole-radio-lab`（无 Git 仓库，见下）。
用途：黑洞电台迁移第一阶段的恢复点。本目录只做记录与副本，不参与构建、不被任何源码 import。

## 1. 这份基线冻结了什么

- 项目里除 `node_modules/` 与 `docs/baseline/` 之外的全部 57 个文件：源码、`tools/`、`docs/`（既有报告与截图）、`locale/`、配置、锁文件、以及仓内已有的构建产物 `client.js` / `client.stage.js` / `client.radio.js`。
- 每个文件的 SHA-256、字节数、mtime（含纳秒），见 `SHA256SUMS.txt`。
- 一份可直接恢复的字节级副本，见 `files/`（tar 管道复制，保留 mtime；纳秒被截断到秒）。
- 本机运行环境，见 `ENVIRONMENT.txt`。
- 第一阶段 `tools/validate-imaging.mjs` 的两次运行日志，见 `logs/`。

没有冻结、也不声称可恢复的东西：`node_modules/` 的内容（由 `package-lock.json` + `npm ci` 重建）、DSH 宿主 profile 与插件安装状态、GPU/驱动状态、浏览器缓存。

## 2. 版本控制状态

`git rev-parse --show-toplevel` 在项目目录与 `C:\Yu` 均返回 `fatal: not a git repository`。没有 `.git`，没有提交历史，也没有 `git stash`/`git checkout` 可退。因此本阶段的"可恢复"完全由 **SHA-256 清单 + 字节副本** 承担；任何"回滚"都是文件级覆盖，不是版本控制操作。

## 3. 目录内容

| 文件 | 内容 |
| --- | --- |
| `SHA256SUMS.txt` | 57 行，`sha256  size  mtime  path`，按路径排序，路径相对项目根 |
| `FILELIST.txt` | 57 行，`size  path` |
| `COPY.SHA256SUMS.txt` | 副本 `files/` 的 57 行 `sha256  path`，用于独立核对副本自身 |
| `ENVIRONMENT.txt` | 采集时间、项目路径、node/npm/OS、git 状态、排除项 |
| `files/` | 57 个文件的副本，10,072,870 B |
| `logs/validate-imaging-run1.log` | 第一次 `node tools/validate-imaging.mjs` 的完整 stdout（304 行） |
| `logs/run1-meta.txt` | run1 的 exit_code / duration_ms / node / cwd / command |
| `logs/validate-imaging-run2.log` | 第二次运行的完整 stdout，与 run1 字节一致 |
| `logs/run2-meta.txt` | run2 的 exit_code / duration_ms / node |

### 3.1 关键文件哈希（完整 57 条见 `SHA256SUMS.txt`）

| 文件 | 字节 | SHA-256（前 16 位） |
| --- | --- | --- |
| `README.md` | 11,989 | `e6bfeeafe932b78a…` |
| `client.js` | 50,356 | `2d38e3ca904ae964…` |
| `client.stage.js` | 2,036,161 | `8fc656e423a236c1…` |
| `client.radio.js` | 19,017 | `76c4b463bb7f4a9c…` |
| `cordis.patch.yml` | 358 | `3e6f6572d28fc072…` |
| `src/stage.js` | 54,203 | `a545f0cc…` |
| `src/scene/geodesic.glsl.js` | — | `9925bf15…` |
| `tools/validate-imaging.mjs` | 53,638 | `5ef8b925d01e7964…` |
| `tools/build-stage.mjs` | 5,966 | `b3bbe0fba50636b0…` |

### 3.2 完整性核对结果

副本与原文件的 57 条 `sha256` 逐条比对，结果 **IDENTICAL (57 files)**：

```bash
cd /c/Yu/dsh-blackhole-radio-lab/docs/baseline/20261023-1117
awk '{print $1"  "$NF}' SHA256SUMS.txt   > /tmp/bhrl-orig.sha256
awk '{print $1"  "$NF}' COPY.SHA256SUMS.txt > /tmp/bhrl-copy.sha256
diff /tmp/bhrl-orig.sha256 /tmp/bhrl-copy.sha256   # 无输出 = 一致
```

副本的 mtime 与原件到秒一致，纳秒被 `tar` 截断（例：`README.md` 原件 `02:52:44.246373200`，副本 `02:52:44.000000000`）。内容不受影响；如果某天需要按 mtime 做判断，请以 `SHA256SUMS.txt` 记录的原始 mtime 为准。

## 4. 恢复方法（记录，未执行）

前提：恢复会**覆盖**同名文件。若当前树上有更新的工作，先把它另存，或在临时目录里恢复出一棵干净的树再比对，不要直接盖回在用目录。

```bash
# 0) 先校验这份基线自身没坏（在基线目录内执行）
cd /c/Yu/dsh-blackhole-radio-lab/docs/baseline/20261023-1117
awk '{print $1"  "$NF}' SHA256SUMS.txt > /tmp/bhrl-baseline.sha256
sha256sum -c /tmp/bhrl-baseline.sha256          # 57 条全部 OK 才继续

# 1) 恢复项目文件（保留整秒 mtime；不删除快照之后新增的文件）
tar -C files -cf - . | tar -C /c/Yu/dsh-blackhole-radio-lab -xf -

# 2) 重建依赖（副本不含 node_modules；lock 文件已在第 1 步恢复）
cd /c/Yu/dsh-blackhole-radio-lab
npm ci

# 3) 复核
sha256sum -c /tmp/bhrl-baseline.sha256          # 在项目根执行，路径相对根解析
node tools/validate-imaging.mjs                 # 期望 exit 0，197/197
```

注意事项：

1. 第 1 步是**覆盖 + 补缺**，不是"还原到快照状态"：快照之后新增的文件（含本目录、第一阶段报告与验证规格）不会被删掉。需要逐字节一致的干净树时，先 `mkdir /tmp/bhrl-restore && tar -C files -cf - . | tar -C /tmp/bhrl-restore -xf -`，再 `diff -r` 比对。
2. `npm ci` 会按 `package-lock.json` 重装 `esbuild` 与 `three`（`three` 0.186.1、`esbuild` 0.28.2 一线），需要网络；版本以锁文件为准，不升级。
3. 恢复后必须重跑 `node tools/validate-imaging.mjs`：基线只证明文件字节，不证明 GPU 成像。
4. 恢复**不会**恢复宿主侧状态。桌面宿主在启动时计算 chunk revision，替换 `client.stage.js` 后需要重启 DSH 才生效；本阶段按要求不重启、也不建议把恢复与重启捆在一起做。

## 5. 这份基线与第一阶段报告的关系

- `docs/phase1-report.md`：第一阶段的实测结果、静态检查结论、待修问题与第二阶段范围。
- `docs/imaging-verification-spec.md`：下一阶段新增的验证规格（单位、观察者、标准条件、四类夹具、验收项、范围边界）。
- 本目录只保存事实（哈希、副本、日志），不解释、不建议。
