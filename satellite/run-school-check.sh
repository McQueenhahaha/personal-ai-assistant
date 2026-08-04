#!/bin/sh
# Mac 侧的定时学校/邮件检查，对应 Windows 的 scripts/run-school-check.ps1。
#
# 存在的理由：大脑漂到 Mac 之后，Windows 会（正确地）停止跑定时任务，
# 而在此之前 Mac 上没有任何定时任务 —— 于是检查静默停摆，不报错，
# 只是什么都不发生（2026-08-04 实测的故障）。
#
# 与 Windows 版的差异，都是有理由的，不是偷懒：
#   - 不检查 assistant-desired-running.flag：那是 Windows 本地的开关，
#     由 start/stop-assistant.ps1 维护，不进灵魂包，Mac 上永远不存在。
#     照抄的话这里会永远跳过。
#   - 不检查游戏模式：进程名是 Windows 的 Tarkov。而且用户在 Windows 打游戏时
#     Windows 是醒着的、会持有大脑，本机根本不会是执行方。
#   - 不处理 catchup flag：它同样不进灵魂包，Mac 看不见 Windows 留下的补课标记。
#
# 急停不在这里判断 —— runSchoolCheckCli() 开头就查 isPaused()，
# 而 assistant-pause-state.json 是进灵魂包的，两台机器看到的是同一个状态。

set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1
mkdir -p data/logs

# 手动触发不受归属限制：那是用户明确要求的一次性动作。
# 这份清单与 Windows 版保持一致，两个平台的行为必须一样。
manual=0
for arg in "$@"; do
  case "$arg" in
    --force-school|--school|--force-game|--game|--force-personal|--personal|--mail|--check-only)
      manual=1
      ;;
  esac
done

# 定时工作只在持有大脑租约的那台机器上运行。判定逻辑集中在
# src/state/brain-guard.mjs，两个平台共用同一份实现。
if [ "$manual" -eq 0 ]; then
  if ! node src/state/brain-guard.mjs >/dev/null 2>&1; then
    printf '[%s] Skipped: this node does not hold the brain lease.\n' \
      "$(date +%Y-%m-%dT%H:%M:%S%z)" >> data/logs/school-check-skipped-not-brain.log
    exit 0
  fi
fi

exec node src/school-check.mjs "$@"
