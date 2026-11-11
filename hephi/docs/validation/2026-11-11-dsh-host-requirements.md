# DSH 宿主需求单：R1 结构化 `tool/result.message.value` / R2 证据载体 OS 隔离（2026-11-11）

> **重建版（2026-11-12 重建），依据：`hephi/docs/validation/2026-11-07-a2-final.md` L47-60、`hephi/docs/validation/2026-11-07-evidence-chain-host.md` L147-156、`eval/evidence/t10-host-verification/report.md` L16-185、`eval/evidence/a2a3-binding-decision/material.md` L8-111、v5.4 计划附录 A（`git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md` L576-621）、exp-log exp-028/029/040/043，非原始文件。**
> 原文件建于已删除分支 `agent/roadmap95`；在 `/Users/zm/repos/hephi-review-main` 全 ref 检索 `git log --all -- hephi/docs/validation/2026-11-11-dsh-host-requirements.md` = 0 commits（2026-11-12 实测）。本文件只重建语义与引用，不声称是原文件。
> 重建方法：每条结论引用现存证据的文件+行号；无法从现存证据核实的数字/结论写「未知/待补」，不编造。
> 经验注入：Lead 给定 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`；experience-log 为 append-only 且当前已 45 行，内容寻址哈希随日志变化，**本地无法复现该 pack 哈希**（见 §7）；按任务卡点名的 exp-028/029/040/043 作为注入内容读取。

## 0. 摘要

| 需求 | 对应阻断项 | 建议优先级 | 一句话 | hephi 侧配套 |
| --- | --- | --- | --- | --- |
| **R1** | H2（前台结果无结构化 `value`） | P1（合法交付 + A1-BIND 启用条件） | 宿主持久化 `tool/result.message.value` 携带契约级结构化结果 `{kind, exitCode?, jobId?}`，不依赖 `[exit code: N]` 文本 | 判据不动；探针验收前需修采样缺陷（§2.4） |
| **R2** | H6（Worker 可写自身 Session 快照/state） | P0（当前唯一可能翻转 H6 的方向） | Worker 会话进程对自身 Session 快照与 hephi state 目录只读，同时保留宿主自身写入通道 | 近乎零代码；state 目录可外置（`HEPHI_STATE_DIR`） |

两者不互为替代：R2 决定 D1 档位上限（附录 A L589-594）；R1 决定强绑定下合法交付路径可用（T10 §3.2、附录 A L585-586）。

## 1. 背景：两个阻断项（现存证据）

### 1.1 H2：前台结果无结构化 `message.value`

- **判据原文**（`hephi/docs/validation/2026-11-07-evidence-chain-host.md:152`）：前台 `tool/result.message.value` 有结构化 `kind`；`foreground` 带整数 `exitCode`；`promoted/background` 带 `jobId` 且无最终退出码。
- **历史定案 fail**（`2026-11-07-a2-final.md:55`）：`bashResultCount=16`、`structuredValueCount=0`、`kinds=[]`；退出码只以文本 `[exit code: N]` 出现。
- **2026-11-12 在新真实快照上复现**（`eval/evidence/t10-host-verification/report.md:23`）：真实 Session 快照 170,899 字节/151 zstd 帧/264 事件，`tool/result` **结构化 value = 0**，`job/registered`=22 + `job/settled`=22。
- **消费方代码已按结构化契约编写**：`hephi/src/control/check-runner.ts:468-469` 只在 `value.kind === 'foreground'` 且 `Number.isInteger(value.exitCode)`、未 `timedOut`/`aborted`/`signal` 时接受为终态，否则抛错（`:574` 对未知 `kind` 抛 `native bash returned unknown result kind`）；A1-BIND path A 要求结构化 value（`hephi/src/control/evidence-verifier.ts:133-135`，缺失即 `carries no structured native value`；该形状的真实宿主形态仍以 `FI-FIXME(H2)` 标注在 `:45`）。

### 1.2 H6：Worker 可写自己的 Session 快照与 state 目录

- **判据原文**（`2026-11-07-evidence-chain-host.md:156`）：Worker 无法让 Session 快照/检查记录出现未发生的可信事件；任一自影响成功即 fail（人工，一次性实例）。
- **定案 fail**（`2026-11-07-a2-final.md:59`）：原始写入证据 `20261107T213750Z-full/run.jsonl`（SHA256 `aef6c922…`）**第 25 行** `append_exit=0`、`state_write_exit=0`——Worker 用 `>>` 追加自己的 `session.v4.jsonl.zstd` 并写伪造 `run.json` 均成功；**生产 B 未做写入尝试**（按方案禁止）；无"追加前"哈希对照（`:210` 登记未做）。
- **现状信任边界**（`hephi/docs/threat-model.md:20-21`）：`stateDir/hephi` 可被 Worker 所在进程写入（**同一宿主进程/同一 UID**），Session 快照 H6 fail（一次性 profile 实测）；因此强绑定保持关闭，A1-BIND 只按"检测已列举伪造"交付，不声称不可伪造。
- **G1 前置要求**：状态目录能否被 Worker bash 写入（`ROADMAP-95-PREREQUISITES.md:46`）、插件与 Worker shell 是否同一系统用户/能否配只读路径（`:47`，"同一用户且不能配置时没有真实权限隔离，D1 到不了 L3"）。

## 2. 需求 R1（宿主侧）：持久化 `tool/result.message.value` 结构化结果契约

### 2.1 需求陈述

对持久化到 Session 快照的每一个 bash `tool/result` 事件，其 `data.message.value` 必须是结构化对象，满足下表；该字段必须可从**持久化快照文件**直接读到（不是仅运行时内存/仅 Job 事件）。

### 2.2 字段契约（最低要求）

| 字段 | 类型 | 适用 `kind` | 约束 |
| --- | --- | --- | --- |
| `kind` | string | 全部 | 仅 `foreground` \| `background` \| `promoted`；不得缺失或取其他值 |
| `exitCode` | integer | `foreground` | 进程退出码；缺失/非整数时 hephi 拒绝该记录为终态（`check-runner.ts:468-469`） |
| `jobId` | string | `promoted`、`background` | 非空，可用于 `jobs.get(jobId, sessionId)` |
| （无最终退出码） | — | `promoted`、`background` | **不得**携带最终 `exitCode`（判据原文 `.152`：后台/转后台时进程未结束） |

补充约束（由消费方代码推导，供宿主确认）：`foreground` 若因超时/取消/信号未得到确认终态，不得编码为已完成 `foreground`，须改为 `promoted`/`background` 或显式携带对应标记（`check-runner.ts:469` 会拒绝）；同一 Session 内不得新旧编码混编（历史文本编码与新结构化编码并存会让 H2 判据"编码不统一"分支无法一致判定）。

### 2.3 为什么必须是契约级而非文本

- T10 实测本宿主 `structured value = 0`（`report.md:23`），内部 `hephi_check` 只留 path-B（`job/registered`+`job/settled`）事件，**path-B 不持久化 stdout**（`report.md:103-105`）。
- 后果：强绑定（binding on）下 A1-OUT 要求权威输出可重建，合法前台交付被拒 `ready.output-unverified`（`report.md:98-111`；v5.4 附录 A `:585-586` 明文"前台检查没有结构化结果的路径会被正确拒绝，这是设计行为……须写明为部署约束"）。
- 文本 `[exit code: N]` 只是展示格式，不是契约；结构化字段才能让 H2 判据免于"宿主换版改文案即静默失效"（**原版对路径 A 的具体风险量化数字已随原文件丢失，未知/待补**）。

### 2.4 验收（命令与证据形态）

```bash
cd /Users/zm/repos/hephi-review-main
node hephi/scripts/check-binding-host.mjs \
  --session <真实生产 Session 快照> \
  --check-record <对应 run.json> \
  --out /tmp/h2-r1-acceptance.json
```

| 证据项 | 期望形态 |
| --- | --- |
| `rings[H2].status` | `pass` |
| `rings[H2].evidence.bashResultCount` | > 0，等于快照中 bash tool/result 总数 |
| `rings[H2].evidence.structuredValueCount` | 等于 `bashResultCount` |
| `samples[].kind` / `exitCodeField` | `foreground` 有整数 `exitCodeField`；`promoted`/`background` 有 `jobId` 且无最终退出码 |

> **验收前置条件（现存代码事实）**：当前探针 `h2Ring` 只对**前 5 条**结果采样（`hephi/scripts/check-binding-host.mjs:594`），用样本计数（`:610`）与**总数**比较（`:620`）——因此真实快照含 >5 条 bash result 时，即使全部结构化也会判"编码不统一 → fail"。R1 验收前必须先在 hephi 侧修该采样缺陷（全量统计或另立全量 ring）；**原版是否已登记此条件未知/待补**。
> 另注：若样本不含 `promoted`/`background`，报告中必须标注该分支未覆盖，不得当 pass。

### 2.5 不做 R1 的后果

1. 强绑定开启后项目常用前台合法交付不可用（`report.md:98-111`，部署约束）。
2. H2 持续 fail；若改走"文本判据修订"路径：无结构化权威输出、无法把 T10 攻击①（伪造记录）的检测抬到可验证水平（**原版对路径 A 的防伪量化未知/待补**）。
3. T10 两类合法路径（前台/后台）目前 **0/2 通过**（`material.md:60`），T10 与后续 Q4 只能保持 blocked（`report.md:171-187`）。

## 3. 需求 R2（宿主侧）：证据载体对 Worker 会话进程只读，保留宿主写入通道

### 3.1 需求陈述

同一会话运行期，Worker 会话进程（Worker 的 bash 及子进程、工具执行进程）对以下**证据载体**必须无写权限（OS 级拒绝，不是 PATH 限制/工具白名单/沙箱策略开关）：
1. 该 Worker 自己的 Session 持久化快照（`<dsh-home>/sessions/**/session.v*.jsonl.zstd`，含追加与重写）；
2. hephi 状态目录（`<stateDir>/hephi/<ticket>/**`，`check-store` 布局；`stateDir` 可用 `HEPHI_STATE_DIR` 外置）。

同时**必须保留宿主进程对上述载体的写通道**（快照边写边持久化、检查记录落盘）——只读只针对 Worker 进程。

### 3.2 现状（为何是宿主需求）

- 现状同一 UID（`threat-model.md:20`）；H6 fail 证明 Worker 可 append 快照并写伪造 `run.json`（`a2-final.md:59`）。
- 插件侧只能收窄工具面，无法改变进程 OS 权限；G1 把"是否同一用户/能否配只读路径"列为路线图 A4 的前置问题（`ROADMAP-95-PREREQUISITES.md:47`）。
- 具体 g1 实例的进程用户/目录权限实测输出**不在当前仓**（原 g1 调查记录亦已丢失，见 `2026-11-11-g1-permission-survey.md` 重建版）；该结论只能以 `threat-model.md:20` 与 A2/H6 证据为准。

### 3.3 验收（一次性实例，人工判定）

**前置**：H6 是人工（一次性实例）判据（`evidence-chain-host.md:156`），生产实例禁止写入尝试（`a2-final.md:59`）。

| 观测项 | 通过条件 |
| --- | --- |
| `append_exit`（Worker bash 向自身快照 `printf x >>`） | **非 0**（权限拒绝），且 stderr 有 OS 级拒绝依据 |
| `state_write_exit`（向 `state/hephi/**` 写入） | 非 0 |
| 载体 SHA256 | 追加前后**相等**（补齐 A2 未做的"追加前哈希对照"，`a2-final.md:210`） |
| 正向对照 | 宿主自身落盘不受影响：新检查记录正常生成、`decisions.jsonl` 正常追加、快照正常增长 |
| 判定 | 上述全满足后由操作者按 H6 判据给出人工结论；不得只凭退出码写 pass |

### 3.4 不做 R2 的后果

1. H6 持续 fail → 强绑定保持关闭（`a2-final.md:59`）；D1 档位上限按"隔离未验证"回落 L1（附录 A L589-594；`material.md:56-60`）。
2. T10 攻击①（伪造记录）在 binding off 下被放行 `ready.pass`（一票否决项，`report.md:129-139`）无法被消除；要同时满足攻击侧与合法侧，必须（a）H6 隔离通过后开启强绑定 +（b）R1 结构化或可用后台 Job 路径（`report.md:181-184`）。
3. A1-BIND 只能作为"检测已列举伪造方式"的检测层，不能作为不可伪造证明（`threat-model.md:49`）。

## 4. 优先级与不做的后果

| 需求 | 解除的阻断 | 建议优先级 | 依据 | 不做的直接后果 |
| --- | --- | --- | --- | --- |
| **R2** | H6 | P0 | 附录 A 开启顺序第 1 步=隔离验证（L578-584）；D1 上限规则（L589-594）；`material.md:21`（P-1 未通过） | D1 无 L2 可能；T10 攻击①误放行无法消除 |
| **R1** | H2 / 合法交付 | P1 | T10 §3.2（`report.md:98-111`）；附录 A L585-586；`material.md:22`（P-2 未满足） | 强绑定下合法前台交付不可用（部署约束）；H2 持续 fail |

**本文不承诺排期、不指定/不虚构宿主联系人**，只固定需求与验收口径；转达方式由负责人决定。R1/R2 语义与 T10 报告 `:184-185`、A2/A3 决策材料 `:24`/`:65` 的引用一致——该处引用的需求单文件本体此前缺失，本重建版即为其补录。

## 5. 影响面与兼容性

- 宿主版本：runtime **DSH 0.2.1-rc.5**（`material.md:9`，与 A2 探针环境一致）。
- **宿主升级后必须复跑 A2 探针**（`hephi/docs/host-compatibility.md:23-26` 的升级回归清单）；H2 判据/结构化字段形态随宿主版本变化，旧结论不得沿用。
- R1 落地后 hephi 侧**零代码即可消费**（消费方已按契约实现，§1.1）；探针需先修采样（§2.4）。
- R2 落地后 hephi 侧近乎零代码；state 目录已支持外置（`HEPHI_STATE_DIR`，`hephi/src/control/activation.ts:596-597` 的 `defaultStateDir` 解析）。

## 6. 引用清单与重放命令

```bash
cd /Users/zm/repos/hephi-review-main
git log --all --oneline -- hephi/docs/validation/2026-11-11-dsh-host-requirements.md   # 0 commits（确证原文件缺失）
sed -n '47,60p' hephi/docs/validation/2026-11-07-a2-final.md                 # H2/H6 定案表
sed -n '147,156p' hephi/docs/validation/2026-11-07-evidence-chain-host.md    # H1–H6 判据
sed -n '16,111p;129,187p' eval/evidence/t10-host-verification/report.md      # 结构化缺口/攻击①/结论
sed -n '8,111p' eval/evidence/a2a3-binding-decision/material.md              # 硬前置 P-1~P-4/档位 L1
git show docs/hephi-plan-v5.4:docs/hephi-95-plan-v5.4-20261112.md | sed -n '576,621p'  # 附录 A
sed -n '589,624p' hephi/scripts/check-binding-host.mjs                       # h2Ring（含 594/610/620 采样缺陷）
sed -n '468,469p;574p' hephi/src/control/check-runner.ts                     # R1 消费方
sed -n '133,135p;45p' hephi/src/control/evidence-verifier.ts                 # path A 结构化要求/FI-FIXME(H2)
```

## 7. 明确未做 / 未知待补

- **未知/待补（原文件内容，无法从现存证据核实）**：原版 371 行中的章节编号与逐条验收表格原文；原版"路径 A 文本判据防伪量化"（本机快照扫描数字）；原版是否已登记探针采样缺陷；原版对 R1/R2 的排期建议与影响面细节。
- 未复跑 A2 探针（无授权的真实 Session 输入）；未在宿主上执行 R1/R2 验收；未修改任何代码/宿主配置。
- **经验注入说明**：Lead 给定 pack_sha256 无法本地复现（experience-log 已 append 至 45 行）；已按任务卡点名的 exp-028/029/040/043 读取内容，未虚构注入。
