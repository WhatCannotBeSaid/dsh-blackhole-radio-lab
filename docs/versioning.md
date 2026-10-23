# 版本管理与备份规范

本文件是本项目（DSH 黑洞电台 lab 副本）的固定开发流程。**不需要每次重新确认**：任何后续阶段默认按此执行。

## 模式

本地 Git 版本管理 + GitHub 私有仓库备份 + 阶段验收后同步。

- 本地开发，GitHub 只做备份。
- 每完成一个独立阶段 → 验收 → 提交 → 同步 → 下一阶段。
- 未通过验收的代码不覆盖远程稳定版本。
- 开发期仓库保持 **Private**，不公开发布、不建 Release、不加许可证。
- 不引入多余分支、CI/CD 或自动化发布。

## 远程

| 项 | 值 |
| --- | --- |
| 仓库 | `WhatCannotBeSaid/dsh-blackhole-radio-lab`（Private） |
| remote | `origin` → `https://github.com/WhatCannotBeSaid/dsh-blackhole-radio-lab.git` |
| 主分支 | `main`（单一长驻分支） |

仓库名曾为 `DSH-BlackHole-Radio`，按「一律小写」规则改为 `dsh-blackhole-radio-lab`。GitHub 会保留旧地址的跳转，但本地 remote 已更新，不要再用旧名。

## 单阶段流程

1. **需求确定** —— 明确本阶段改什么、不改什么。
2. **本地开发** —— 只改必要文件，不顺手重构，不动 DSH 核心。
3. **自动验证** —— 按改动性质选跑：

   ```bash
   npm run build                     # 构建两个 chunk，24 s 左右
   node tools/validate-imaging.mjs        # 引力透镜/成像回归
   node tools/validate-radio-imaging.mjs  # 电台成像 fixture
   node tools/validate-radio-data.mjs     # 数据映射（会打真实 Radio Browser API）
   ```

   自动验证**不能**代替黑洞渲染、Shader、相机交互、视觉一致性的实机目视验收。

4. **用户验收** —— 报告完成项、改动文件、测试结果、需人眼确认的视觉项、已知问题。**用户明确通过后**才作为稳定版本推送。
5. **提交** —— 一个提交对应一个明确目标，不混塞无关改动。

   | 前缀 | 用途 |
   | --- | --- |
   | `feat:` | 新增功能 |
   | `fix:` | 修复问题 |
   | `refactor:` | 代码重构 |
   | `perf:` | 性能优化 |
   | `chore:` | 工程维护 |
   | `docs:` | 文档与流程 |

6. **同步** —— 确认提交内容、无敏感文件、仓库仍 Private，然后 `git push origin main`，再核对远程 commit 与本地一致。

高风险实验或需要隔离未完成改动时，才开临时分支；合并后删掉。

## 命名一律小写

新建的文件、目录、分支名、tag、仓库名、`package.json` 的 `name`、提交信息里的路径，全部小写连字符。

查文件先 `ls` 确认实际大小写。Windows 大小写不敏感，`Foo.yml` 会被 `foo.yml` 静默盖掉。

例外：引用他人已有的文件名、标识符、仓库名时保留原样，并说明为什么没改成小写。

## 关联技能

同一套流程已固化为技能 `dsh-dev-git-flow`（`<redacted>\.agents\skills\dsh-dev-git-flow\SKILL.md`），含首次初始化、敏感扫描、`.gitignore` 模板、验证矩阵、推送前三查与红线。做开发任务时先加载它。

## 提交前自检

```bash
git status --short
git diff --cached --name-only | grep -iE "\.env|secret|credential|\.key|\.pem"   # 应无输出
gh repo view --json visibility                                                    # 应为 PRIVATE
```

## 禁止

- `git push --force`、`git reset --hard`、`git clean -fd`、删除历史。
- 覆盖或改写已有远程仓库；擅自改仓库可见性。
- 提交凭据；凭据只存 `<redacted>\.dsh\.env`（在全局 ignore 内）。
- 为版本管理而改黑洞渲染、电台逻辑或插件 UI。
- 任何可能丢代码的操作：停下来报告，不自行执行。

## 版本标签

日常进度用普通提交即可，不逐次打 tag。里程碑按实际验收情况再打，例如 `v0.1.0` / `v0.5.0` / `v0.9.0` / `v1.0.0`（示例，不代表当前进度）。

## 仓库内容边界

入库：源码 `src/`、宿主与客户端入口、`client.*.js`（构建产物，插件运行必需）、`tools/` 构建与验证脚本、`locale/`、`docs/`（阶段报告、验收截图、baseline 快照与其 SHA256SUMS、历史验证日志）、`package-lock.json`。

不入库（见 `.gitignore`）：`node_modules/`、`.env*`、`*.key`、`*.pem`、凭据类文件、编辑器与系统垃圾、`*.bak` 临时备份。
