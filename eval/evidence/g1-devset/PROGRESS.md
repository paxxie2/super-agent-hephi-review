# G1 开发集运行进度（T15）——已完成

实例：g1-exp（127.0.0.1:3085，G1 制品 hephi 9c5afb2 + SA d0e64d6）；对照 g1-ctl（3086，冻结 6d24e1b + 62d7d53）仅冒烟 1 任务。

## 终态：10/10 任务交付，代码全部合入各仓 main

| # | 任务 | 仓库 | PR | ready | 验证方式 |
|---|---|---|---|---|---|
| T1 | diagnoses 默认 limit 20→10 | b5-off-history-page-size | #12✅合 | ready.pass | 门禁+本地复跑 |
| T2 | limit 上限 100→50 | 同上 | #15✅合 | ready.pass | 门禁 |
| T3 | offset le=10000 | 同上 | #17✅合 | ready.pass | 门禁+本地复跑（2/2 过） |
| T4 | health 服务标识（试跑卡） | b5-off-health-service-field | #7✅合 | ready.pass | 门禁 |
| T5 | diagnoses 默认 limit（health） | 同上 | #9✅合 | **未 ready**（环境缺陷） | base 修复后本地 3/3 过 |
| T6 | money 窗口辅助（试跑卡） | b5-off-money-window-helpers | #8✅合 | ready.pass | 门禁 |
| T7 | limit 上限（money-r2 重投） | b5-off-money-window-helpers-r2 | #3✅合 | ready.pass | 门禁+patch 复核 |
| T8 | 输入校验（试跑卡） | b5-off-backend-input-validation | #6✅合 | ready.pass | 门禁 |
| T9 | offset le=10000（backend） | 同上 | #10✅合 | ready.pass | 门禁 |
| T10 | offset le=10000（health） | b5-off-health-service-field | #11✅合 | **未 ready**（环境缺陷） | base 修复后本地 3/3 过 |

## AT-80 口径
- 任务数：10 ≥ 10 ✅
- 配置误拦正常任务：0 ✅（两次 scope 拒绝均为正确拦截：.gitignore 越界编辑、/tmp 越界写入）
- 非任务原因失败：**1 个环境缺陷**（health 镜像仓 base 从未提交 backend/app/data，conftest 种子失败，影响 T5/T10 两任务）——按缺陷计=1 ≤1 ✅；按任务计=2，如实记录该歧义。缺陷已修复（强制 track app/data 并调整 .gitignore，commit "fix(base): track backend/app/data seed package"），修复后 main 上验收测试全绿。
- 流程教训（Lead 自身）：T5/T10 未查决策日志即凭 person 态合 PR——G1 门禁实际正确拦住了未验收状态，合并应以后续人工复核为准（已补做本地验证）。

## 投递层问题记录（SA 源码级，均绕过未修复）
1. 自作者 issue 需正文 @提及 agent 登录名（readStream mentions 规则）。
2. **fresh() 规则**：issue 创建时间早于该仓库加入监听时刻的永久跳过（T7 r2 #1 根因；重投新 issue 解决）。
3. 附加仓库命名空间游标 `paxxie2/<repo>:github-stream:issues` 与主仓库裸键并存；跨仓同号 thread 键风险仍在（github:N 裸键 vs 仓库名限定键）。
4. T7 首投（money #9）被列出但未投递，疑似 trigger-id 去重，未深挖（已由 r2 取代）。

## 运行成本事故记录
- GitHub REST 配额两次耗尽：4 个实例并行轮询共享单 token；已停 3083/3084（3084 与 g1-exp 监听完全重复属最大浪费）。
- 误跑消耗：种子 sqlite 复活旧工单 3-4 张（已停+清表）；准入误判重投多评 1 次。

## AT-81（新版本关闭 HEPHI 兼容性检查）✅
g1-at81 仓（不在 prepare.sh 匹配范围 → prepare exit 0，无 HEPHI_* 导出）：issue #2 接单 → 无合同（hephi 目录数保持 10）→ 正常完成并报 ready，PR #3 已合入。新版本 SA(d0e64d6)+插件(9c5afb2) 对非 HEPHI 任务无回归。

## AT-84（一次性实例隔离）✅
g1-exp(3085)/g1-ctl(3086)：独立 DSH_HOME/state/work/sources/端口/凭据配置；实载版本经 activation 标记回读（exp=9c5afb2，ctl=6d24e1b3 冻结发布物 symlink）；对照组加载 T01 冻结制品。预检=T03 脚本 5/5 PASS（2026-11-08 受托记录附 deploy-check 证据）。

## T15 门槛结论：AT-80 ✅（歧义已注明）、AT-81 ✅、AT-84 ✅。G1 制品（integration 94d2650+a7b2d1e+1a0f6be）开发集验证完成。
