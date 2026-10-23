#!/usr/bin/env bash
# 黑洞电台成像验证入口（第一阶段建立，后续阶段复用）
#
# 只读项目：不写源码、不写构建产物、不碰 client.js 的 mtime、不启动浏览器。
# 每次运行把结果写进一个新的时间戳目录，绝不覆盖已有结果。
#
# 用法：
#   docs/baseline/repro-validate.sh                 # 输出到 docs/baseline/runs/<UTC 时间戳>/
#   docs/baseline/repro-validate.sh --label phase2  # 目录名加标签
#   OUT_DIR=/tmp/bhrl-run docs/baseline/repro-validate.sh
#
# 退出码 = tools/validate-imaging.mjs 的退出码（0 通过，1 有失败）。
# 源码漂移检查只报告、不改退出码：第二阶段新增文件后必然漂移，这是预期。

set -u

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJ=$(cd -- "$SCRIPT_DIR/../.." && pwd)
SNAPSHOT="$SCRIPT_DIR/20261023-1117"
LABEL=""
if [ "${1:-}" = "--label" ] && [ -n "${2:-}" ]; then LABEL="-$2"; fi

# 输出目录：默认 docs/baseline/runs/<时间戳>；存在即拒绝，不覆盖。
if [ -n "${OUT_DIR:-}" ]; then
  OUT=$OUT_DIR
else
  OUT="$PROJ/docs/baseline/runs/$(date +%Y%m%d-%H%M%S)${LABEL}"
fi
if [ -e "$OUT" ]; then
  echo "refusing to overwrite existing directory: $OUT" >&2
  exit 2
fi
mkdir -p "$OUT" || exit 2

cd "$PROJ" || exit 2

# --- 1. 运行验证，完整保留 stdout/stderr 与退出码 -------------------------
START_MS=$(date +%s%3N)
node tools/validate-imaging.mjs > "$OUT/validate-imaging.log" 2>&1
EXIT_CODE=$?
END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

# --- 2. 环境与元信息 -----------------------------------------------------
{
  echo "captured_at: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "project: $PROJ"
  echo "command: node tools/validate-imaging.mjs"
  echo "exit_code: $EXIT_CODE"
  echo "duration_ms: $DURATION_MS"
  echo "node: $(node --version 2>/dev/null)"
  echo "npm: $(npm --version 2>/dev/null)"
  echo "os: $(uname -srm 2>/dev/null)"
  echo "log_sha256: $(sha256sum "$OUT/validate-imaging.log" | cut -d' ' -f1)"
  echo "log_lines: $(wc -l < "$OUT/validate-imaging.log")"
  echo "git: $(git rev-parse --show-toplevel 2>/dev/null || echo 'none (not a repository)')"
  echo "gpu_probe: not run (no browser/WebGL probe in this entry)"
} > "$OUT/meta.txt"

# --- 3. 各组通过数（从日志尾部汇总，不改断言、不重算） ---------------------
awk '
  /ALL CHECKS PASSED|CHECK\(S\) FAILED/ { seen = 1; next }
  seen && /^  [A-Za-z]/ {
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^[0-9]+\/[0-9]+$/) {
        split($i, b, "/")
        pass += b[1]; total += b[2]
        name = ""; for (j = 1; j < i; j++) name = name (j > 1 ? " " : "") $j
        printf "%-16s %s\n", name, $i
      }
    }
  }
  END { printf "%-16s %d/%d\n", "TOTAL", pass, total }
' "$OUT/validate-imaging.log" > "$OUT/section-counts.txt"

# --- 4. 源码漂移检查（相对冻结基线，报告用，非失败条件） -------------------
if [ -f "$SNAPSHOT/SHA256SUMS.txt" ]; then
  awk '{ print $1"  "$NF }' "$SNAPSHOT/SHA256SUMS.txt" > "$OUT/expected.sha256"
  ( cd "$PROJ" && sha256sum -c "$OUT/expected.sha256" 2>&1 ) > "$OUT/source-drift.txt"
  echo "source_drift: $(grep -c 'FAILED' "$OUT/source-drift.txt" || true) of $(wc -l < "$OUT/expected.sha256") files differ from 20261023-1117" >> "$OUT/meta.txt"
  grep 'FAILED' "$OUT/source-drift.txt" | head -10 | sed 's/^/  /' > "$OUT/source-drift-summary.txt"
else
  echo "source_drift: snapshot $SNAPSHOT/SHA256SUMS.txt missing" >> "$OUT/meta.txt"
fi

# --- 5. 摘要 --------------------------------------------------------------
echo "output:  $OUT"
echo "exit:    $EXIT_CODE   (${DURATION_MS} ms)"
echo "result:  $(tail -1 "$OUT/section-counts.txt" 2>/dev/null)"
echo "log:     $OUT/validate-imaging.log"
if [ -s "$OUT/source-drift-summary.txt" ]; then
  echo "drift:   $(grep 'source_drift' "$OUT/meta.txt")"
  cat "$OUT/source-drift-summary.txt"
fi

exit $EXIT_CODE
