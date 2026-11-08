# T21 准备工作交接审查包（供外部模型独立检查）

- 生成：Lead（DSH 会话），2026-11-09 00:50 Asia/Shanghai
- 仓库：`/Users/zm/repos/hephi-dev-base`，分支 `integration`，HEAD `7323c89`
- 被审查范围：本轮会话产出的 6 个提交（见 §2）；背景 T01–T20 已在此前完成并记录于 `eval/evidence/g1-devset/`
- 纪律声明：本文件只陈述事实与证据路径，不替评审下结论；所有限制/偏差如实列出（§5）。

## 1. 背景一句话

HEPHI DSH 插件交付改进清单 v5.2：T01–T20 已完成；本轮补 T21（保留集正式实验）的三个缺口：
deploy 脚本死循环修复、PREREG 锁定、变体任务卡 + D-9 投递一致性校验。

## 2. 本轮提交清单（git log 可核）

| SHA | 内容 | 关键证据 |
| --- | --- | --- |
| `f56dcbf` | deploy-hephi.sh `--skip-tests` 分支漏 shift 导致纯内建死循环的一行修复 + 回归用例 R3-T13b | 修复前复现：97.6% CPU 空转 2s+；修复后同命令立即 exit 2。套件 303 断言一次通过 |
| `2c3fcc1` | T20-DEPLOY-RECORD.md 补记死循环根因闭环 | `eval/evidence/g1-devset/T20-DEPLOY-RECORD.md` 待办节 |
| `b36a4d2` | PREREG v1.0 锁定（seed=20261108）：`eval/PREREG.md` 全数值化 + `decisions-draft.md` 终态 + `eval/PREREG.lock` | `node eval/prereg-lock.mjs --check` exit 0 |
| `e0a81e4` | 锁定文本更正：如实声明锁哈希仅覆盖 2 个 md（requirements/tasks/rubric 按 git 提交冻结）；`--force` 重锁，lock 内 `forcedOverwrite: true` | 复核脚本验证 md 哈希与 lock 匹配 |
| `36a72a8` | 18 张变体任务卡（9 族 ×2，`eval/tasks/site-pnl-diagnosis/*-v2/-v3`） | 每卡 `validation.json` 存 check-task full-mode 原始输出 |
| `7323c89` | D-9 投递一致性证据（30 文件，`eval/evidence/t21-prep/`） | 主文件 `d9-consistency-20261108T1605Z.md` + SHA256SUMS |

## 3. 参数决策链（评审重点之一）

1. 用户此前委托的外部模型参数**已在库**：`eval/approvals/2026-11-08-delegated-b5-parameters.md`
   （D-3/D-4/D-5/D-8：67 配对 / 100 元 / 每 10 次失败>20% 或连败 3 次停 / normal 模式）。
2. 本轮 Lead 误以为该委托未交货，另派零上下文代理（env-verifier，两次自查未接触试验结果）
   产出一版 pilot 参数（每分层 min_pairs=6、整体≤48 对、重复率 0.5）作对照；用户拍板
   **采用原委托参数**，pilot 版未入锁（存在于会话记录，未写入库）。
3. 语料产能事实（非结果，已入 PREREG §6）：保留集全新任务 5 + 新变体 18 = **23 个**，
   距 67 配对差 44；按锁定文本 §7，正式跑 23 对结论只能是"证据不足"，此为预注册诚实出口。

## 4. 评审可复跑命令（全部本地、零 GitHub API、零实例）

```sh
cd /Users/zm/repos/hephi-dev-base
git log --oneline d49ad79..HEAD                      # 应见 §2 六个提交
git status -s                                        # 应为空
node eval/prereg-lock.mjs --check                    # exit 0
# 抽查变体卡（任选，共 18 张；--repo 为只读本地 clone）
node eval/check-task.mjs eval/tasks/site-pnl-diagnosis/restore-data-package-v2 \
  --repo /Users/zm/dsh-instances/experiment/sources/site-pnl-diagnosis --json
# deploy 死循环回归（脚本级套件，~3-6 分钟，303 断言）
node scripts/host/test-deploy-hephi.mjs 2>&1 | tail -3
# D-9 证据哈希核对
shasum -a 256 -c eval/evidence/t21-prep/SHA256SUMS
```

实例现状（2026-11-09 00:40 核对）：仅 3083（实验 B，paused）与 3082（daily）存活；
3093 已停（D-9 窗口 6m06s，GitHub API 共 4 次）；g1-exp/g1-ctl 已停。

## 5. 已知问题 / 偏差 / 未验证（如实，评审请重点核对）

1. **D-9 机制 B（Trigger 评论注入）不可行**（源码事实）：superagent `src/sources/github.ts`
   对 self-authored 评论一律跳过；单账号无第二可写身份。实际采用 RUNBOOK §4.3 A（同文 Issue body）。
   语义差异：native body 含 670B `hephi-task` 合同后缀，off body 是其前缀；taskCard 部分逐字节一致。
2. **D-9 的 native 对照是既有投递的只读读取**（b5-native-site-pnl#2），非同批次新投递
   （避免触发宿主 B 产生真实 ticket）。一致性判定成立但非同批对照。
3. **off Worker 在校验窗口内完成了任务并建 PR #16**（open 未合并）——校验顺带产生了一次真实运行，
   未计入任何实验数据；其成本（deepseek-flash）未计入 100 元预算账。
4. **变体卡 reference.patch 是新写最小实现**，非历史提交回放；各卡 review.md/validation.json 已标注。
   隐藏测试对"需求点未被大模型训练数据污染"字段保守记 false。
5. **PREREG lock 覆盖面弱于文字声称的初版**：实际只哈希 2 个 md；已更正并 `--force` 重锁
   （`forcedOverwrite: true` 留痕）。依赖/任务清单/rubric 仅靠 git 提交冻结，无哈希锁。
6. **Lead 自纠三错**（评审可查证）：① 误判"外部委托未交货"引发冗余二次代填；② 锁定文本初版夸大
   锁覆盖面；③ 修正措辞时造成 md/lock 短暂不一致后修复。
7. **deploy-hephi.sh 修复不在任何 release 内**：属操作脚本，实例 B 实载 055491d 不受影响；
   下次部署自然生效。
8. **23 vs 67 缺口未决**：正式运行方案（按 23 对跑 / 升 v1.1 扩卡 / 暂缓）待用户选择，本包不含决定。
9. T22（模型盲评，已授权降级标注）与 T23（7 天观察窗）未开始；goal 处于 paused（需用户面板恢复）。

## 6. 上游背景索引（此前已完成，非本轮评审对象但可供溯源）

- 清单 T01–T20 证据根：`eval/evidence/g1-devset/`（PROGRESS.md / G2-PROGRESS.md / T20-DEPLOY-RECORD.md）
- 实例 B 实载：hephi release `055491d…`（激活标记回读）+ SA `d0e64d6` + G1 project-config
- 部署事故链与配额事故均已入档（T20-DEPLOY-RECORD.md §部署过程问题）
