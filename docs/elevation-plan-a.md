# 提权方案 A：白名单维护（设计）

**目标**：让远程任务（Telegram/队列派发）能跑一组**审核过的管理员维护命令**，无需每次手点 UAC；**不关 UAC、不给任意提权**。

## 威胁模型 / 边界

- 入口是 Telegram bot（owner 锁定）→ 队列。假设入口**可能被误用或被钻**。
- 因此提权执行**严格限定在固定白名单维护操作**：即使入口被攻破，爆炸半径 = 这几条维护命令（读 / 修复类，**非任意代码、非破坏性删除/格式化**）。
- 白名单写在**代码里**（runner 脚本的 map）。队列只能传"动作 key"，**不能传任意命令** → 无命令注入。

## 架构

```
非提权 worker / Telegram            预授权"最高权限"计划任务
  ① 写 job 请求(动作key + id) ─────▶  run-admin-maintenance.ps1 (elevated)
  ② Start-ScheduledTask 触发  ─────▶    a. 读 pending job
                                        b. 动作 key ∈ 白名单? 否 → 拒绝 + 记录
                                        c. 跑对应命令(elevated)
                                        d. 写 result + log
  ③ 读 result ◀───────────────────────
  ④ 回 Telegram
```

- 计划任务 `PAI Admin Maintenance`：`RunLevel = Highest`，**注册时一次性 UAC**；之后 `Start-ScheduledTask` 触发**不再弹窗**。
- worker **始终非提权**：只"写请求 + 触发任务 + 读结果"，自己不提权。

## 白名单（初版，待你增减）

| 动作 key | 命令 | 说明 |
|---|---|---|
| `dism-restorehealth` | `DISM /Online /Cleanup-Image /RestoreHealth` | 修复组件存储 |
| `dism-scanhealth` | `DISM /Online /Cleanup-Image /ScanHealth` | 扫描组件存储 |
| `sfc-scannow` | `sfc /scannow` | 系统文件修复 |
| `defender-quickscan` | `Start-MpScan -ScanType QuickScan` | Defender 快扫 |
| `defender-status` | `Get-MpComputerStatus` | 读 Defender 状态 |
| `disk-reliability` | `Get-StorageReliabilityCounter` | 磁盘可靠性计数 |
| `volume-status` | `Get-Volume` + `Get-PhysicalDisk` | 磁盘/卷状态 |

全部读 / 修复类，**无任意命令、无破坏性操作**。

## 安全属性

- 注册时一次 UAC；之后无人值守触发**无弹窗**。
- 只能跑白名单 → 队列被攻破也只能跑这几条。
- 白名单在**代码**、不在数据 → 不可经队列注入。
- runner 全程记日志（动作 / 请求 id / 结果）。
- **可撤销**：`unregister` 任务即收回全部提权能力。

## 要建的组件

1. `scripts/admin-maintenance/run-admin-maintenance.ps1`：runner + 白名单 map + 日志 + result 写出。
2. `scripts/register-admin-maintenance-task.ps1`（注册"最高权限"任务，**需一次管理员**）+ `unregister-admin-maintenance-task.ps1`。
3. 派发 helper：写 job → `Start-ScheduledTask` → 轮询/读 result。
4. 接入：Telegram `/maint <action>` 指令 或 worker 调用。

## 实施切片

- **S1**：runner + 白名单 + register/unregister（核心，可手动测；注册那次你给一次管理员）。
- **S2**：派发 helper + 读结果。
- **S3**：接入 Telegram `/maint`（owner 锁定）。

## 待你拍板

1. **白名单内容**：上面 7 条够不够 / 要删要加哪条？（只收"读+修复"，不收任何删除/格式化/改账号类）
2. **暴露方式**：要不要做 Telegram `/maint <action>`？还是先只做本地派发、Telegram 以后再说？
3. job/result/log 放 `data/admin-maintenance/`（gitignore 覆盖 data/）可以吧？
