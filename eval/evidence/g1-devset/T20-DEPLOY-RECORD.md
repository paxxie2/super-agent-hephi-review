# T20 整包部署记录（实例 B，2026-11-08）

## 实载组合（部署后回读）
- HEPHI 插件：release `055491d016078b6d92eaa4d95364b097938e58fc`（=integration 055491d，含 T02/T07/T08/T10/T11/T13/T14/T17/T18 + 三个 follow-up）
- 实载证据：host.log 两条 `[hephi-activation] entry=index/tools commit=055491d0… pid=37467`；指针 `hephi-review/hephi/lib → releases/hephi/055491d…/lib`
- Super Agent：worktree checkout `d0e64d6`（T12+T10），仅构建未跑测试（T12 定向 5/5、T10 定向 23/23 已在其交付时验证）
- 提示 revision：delivery/scope 随 SA d0e64d6
- 项目配置：project-config/*.json 替换为 G1 版（requirePlan+protectedAssets+acceptance 检查），原版备份 *.g0
- 对照组实例 g1-ctl(3086)：T01 冻结制品（6d24e1b+62d7d53+原配置），T15 已建

## 门禁与测试口径（按用户指令：全量仅一次）
- 055491d 树的全量门禁在第一次部署尝试中运行：596 项中 1 项失败（probes 旧文案断言）→ 修复提交 055491d 后，第二次全量通过（见 deploy-20261108T143657Z-8102.json 构建段）
- 后续重试均使用 --skip-tests（typecheck+build），未再跑全量
- SA 侧全程无测试套件

## 部署过程问题（如实记录）
1. deploy-hephi.sh 首跑门禁抓到 probes/effectiveness 旧断言（T14 文案变更未同步，已修 055491d 前置提交）
2. previous 6d24e1b 为 legacy meta，前向部署需 --allow-legacy-rollback（S3 同款）
3. 我把 --releases 传错层级（releases/ 而非 releases/hephi/）→ 发布物落错位置、指针悬空 → 已移正
4. deploy-hephi.sh 在第 4 次尝试中出现纯 bash 死循环（91% CPU、无子进程、无打开文件，>11 分钟），kill 后按脚本同义步骤手工完成停机/切指针/启动/标记回读（全部命令留痕于会话）
5. B 重启时 setup 的 gh 探测撞上 REST 配额耗尽（agentCliSignedOut），待整点恢复后重启复验

## 待办
- ~~deploy-hephi.sh 死循环根因待查~~ → 已定位并修复（f56dcbf）：`--skip-tests` 参数分支漏 `shift`，
  参数解析 `while [ $# -gt 0 ]` 对其永不消耗 → 纯内建空转（无子进程/无 sleep/高 CPU，与现场症状逐项吻合）。
  已客观复现（修复前 2 秒 97.6% CPU 空转、校验不可达）→ 一行修复 → 复验立即 exit 2；
  假宿主套件 303 断言含新增 R3-T13b 回归用例一次通过。该缺陷由 1175694（--skip-tests 标志）引入，
  第 4 次尝试是首个实际传入该标志的调用。

## 最终复验（2026-11-08T15:15Z 配额恢复后）
- 重启 B：`[hephi-activation] entry=index/tools commit=055491d0… pid=51558` ✓
- setup problem: None ✓（agentCliSignedOut 已清除）
- paused 保持 true（按部署约定，派发恢复由操作者在 T21 启动时执行）
- 配额止损：g1-exp/g1-ctl 已停（开发集完成后不再轮询）
