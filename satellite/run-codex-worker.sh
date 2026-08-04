#!/bin/sh
# Mac 侧的 codex worker 循环，对应 Windows 的 scripts/run-codex-auto-worker-loop.ps1。
#
# 存在的理由：大脑漂到 Mac 后，Telegram 来的任务会进 Mac 的队列，而 Mac 上
# 从来没有 worker —— 任务就那么堆着，不报错也不执行（2026-08-04 实测，
# 两个任务卡了一整天才被发现）。
#
# 与 Windows 版的差异：
#   - Windows 用 assistant-running.flag 作为停机开关，那是本机的运行时标志、
#     不进灵魂包，Mac 上不存在。这里改用大脑归属作为闸门。
#   - 不在非大脑时退出，只是空转等待 —— launchd 负责生命周期，
#     退出会被 KeepAlive 立刻拉起，反而更吵。
#
# 为什么必须受大脑归属限制（而不是"各扫门前雪各自消费本地队列"）：
# codex-auto-worker 会写 data/state/in-flight.json，而它在灵魂包里。
# 两台同时写会互相覆盖，接管方还会据此误报"某任务被中断了"。
#
# 已知代价：大脑离开 Mac 时，Mac 队列里没跑完的任务会滞留 —— 队列本身不进
# 灵魂包，不会跟着大脑走。这是已知缺口，尚未处理。

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1
mkdir -p data/logs

POLL=$(grep -E '^CODEX_AUTO_POLL_SECONDS=[0-9]+' .env 2>/dev/null | head -1 | cut -d= -f2)
case "${POLL:-}" in
  ''|*[!0-9]*) POLL=20 ;;
esac

LOG="data/logs/codex-auto-worker-loop.log"

while true; do
  # 日志无限增长是已知问题（清理逻辑没覆盖它）。这里是新建的写入方，
  # 顺手封住：超过 5MB 就只留最后 1000 行。
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5242880 ]; then
    tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
  fi

  # 定时工作只在持有大脑租约的机器上跑，判定逻辑与 Windows 共用
  # src/state/brain-guard.mjs 同一份实现。
  if node src/state/brain-guard.mjs >/dev/null 2>&1; then
    out=$(node src/codex-auto-worker.mjs 2>&1)
    if [ -n "$out" ]; then
      printf '[%s] %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$out" >> "$LOG"
    fi
  fi

  sleep "$POLL"
done
