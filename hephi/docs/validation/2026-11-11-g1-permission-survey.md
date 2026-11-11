# G1 宿主权限调查记录（2026-11-11）

> **重建版（2026-11-12 重建），依据：`hephi/docs/threat-model.md` L4/L20-21/L39-56、`ROADMAP-95-PREREQUISITES.md` L45-48、`ROADMAP-95.md` L193/L210、`eval/evidence/g1-devset/PROGRESS.md` L3/L40、`eval/evidence/g1-devset/T20-DEPLOY-RECORD.md` L9、`external-review/HANDOFF-R3.7-2026-11-07.md` L154、`eval/evidence/t10-host-verification/report.md` L16-41/L129-139、exp-log exp-029/040/043，非原始文件。**
> 原文件建于已删除分支 `agent/roadmap95`；`git log --all -- hephi/docs/validation/2026-11-11-g1-permission-survey.md` = 0 commits（2026-11-12 实测）。
> **重要限制**：原调查的原始命令输出（`ps -o user`、`ls -la` 权限串、端口/pid 等）**未随本重建版保留，也无法从现存仓复核**。本文件只重建结论与可复核依据；原版逐条命令输出标记「未知/待补」。
> 经验注入：Lead 给定 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`（本地不可复现，日志已 append 至 45 行）；按任务卡点名 exp-028/029/040/043 读取。

## 0. 结论（原调查结论，附现存可复核依据）

1. **宿主进程与 Worker 同为一个系统用户（无独立 UID）**：`hephi/docs/threat-model.md:20` 把"状态目录可被 Worker 所在进程写入"明确归因于**同一宿主进程/同一 UID**；`:49` 进一步写明"同用户 Worker **可以**伪造 run.json/追加 Session 快照（H6 fail）"。原调查的 `ps -o user` 原始输出**未知/待补**。
2. **hephi 状态目录无 OS 级隔离**：A2 H6 定案在一次性 profile 上实测 Worker 可写入 `state/hephi/.../run.json`（`2026-11-07-a2-final.md:59`，`state_write_exit=0`）与自身 Session 快照（`append_exit=0`）——同用户可写由实测行为支持；原调查的目录权限串（如 `drwxr-xr-x`）**未知/待补**。
3. **宿主配置层没有逐 Worker 只读挂载能力**（原调查结论）：G1 第 7/8 项（状态目录能否被 Worker bash 写入、能否配只读路径或独立用户）在路线图前置清单中**仍是待办问题**（`ROADMAP-95-PREREQUISITES.md:46-47`），`threat-model.md:20` 亦记"无 OS 隔离证据；G1 第 7、8 项未做"；DSH session 级 sandbox 模式是策略开关而非 OS 只读机制（**原调查对此的实测配置面未知/待补**）。
4. **ROADMAP-95 §A3 的"解除命令只能在 Worker 环境之外执行"以 CLI 操作者通道实现成立且充分**：A3 的 `hephi resolve` 已实现（`hephi/src/cli.ts:23`/`:48`/`:172`），默认关闭（`HEPHI_ALLOW_OPERATOR_RESOLUTIONS`，`threat-model.md:23`），且明确"策略开关**不是安全边界**"（Worker 的 shell 会继承宿主 env）；G1 第 9 项（Worker 无法使用、只有操作者能用的执行通道）仍是待核实项（`ROADMAP-95-PREREQUISITES.md:48`）。原调查结论"Worker 无法凭会话内工具触发 CLI 操作者判定路径"以"CLI 在宿主 shell 执行"为前提（`ROADMAP-95.md:193`）。
5. **对 H6 候选 B（运行面隔离）的输入：现状不支持**，需宿主提供独立 UID / 只读状态目录；该结论与 T10 独立一致：伪造记录在 binding off 生产配置下被放行（`eval/evidence/t10-host-verification/report.md:129-139`），要消除需 H6 隔离 + R1 结构化（`report.md:181-184`；A2/A3 材料 P-1，`eval/evidence/a2a3-binding-decision/material.md:21`）。

## 1. 调查对象与实例（现存记录可复核的部分）

| 项 | 现存依据 | 原调查输出 |
| --- | --- | --- |
| 调查对象 | 实验宿主 `g1-ctl`：`eval/evidence/g1-devset/PROGRESS.md:3`（`g1-ctl` = 3086，冻结 `6d24e1b` + `62d7d53`，仅冒烟 1 任务）；`:40`（g1-exp/g1-ctl 独立 DSH_HOME/state/work/sources/端口/凭据；实载经 activation 标记回读） | 原版记录的启动 pid/端口/`curl 401`/`ps -o user`/`ls -la` 等原始输出**未知/待补** |
| 对照组实例定位 | `eval/evidence/g1-devset/T20-DEPLOY-RECORD.md:9`（对照组实例 g1-ctl(3086)：T01 冻结制品 `6d24e1b+62d7d53+原配置`） | 同上 |
| 生产宿主 | 原调查声明"**不是生产 3083 的结论**（生产未启动，未调查）"；现存材料确认生产侧结论以 A2 记录为准（`2026-11-07-a2-final.md` §2/§5 的只读生产 Session 探针） | 生产 3083 当时运行状态**未知/待补** |
| 同用户旁证（非本调查原始输出） | `external-review/HANDOFF-R3.7-2026-11-07.md:154`：独立验收"仍是同一用户/同一台机器上的 agent，不是人类签收" | — |

## 2. 重建后的结论强度（能声称/不能声称）

| 可以声称 | 不可以声称 |
| --- | --- |
| 现存证据（threat-model + A2 H6 实测）支持"同一用户、状态目录/快照可被 Worker 写、无 OS 隔离" | 本调查当时的原始命令输出（pid/user/权限串/端口响应）——**已丢失，未知/待补** |
| A3 操作者 CLI 通道在代码层存在且默认关闭；其可信边界仍待 G1 第 9 项核实 | "A3 操作者通道已是安全边界"（`threat-model.md:23` 明确不是） |
| G1 第 7/8/9 项仍是路线图前置中的待办（`ROADMAP-95-PREREQUISITES.md:46-48`） | "宿主已提供只读路径/独立用户能力"（无证据，且 H6 fail 反证） |
| 对 H6 候选 B 的输入：现状不支持，需宿主能力 | "H6 已缓解/隔离已验证" |

## 3. 对路线图的意义

- **A3**：原结论"以 CLI 操作者通道实现成立且充分"仍体现在代码与威胁模型口径中（`cli.ts:23`/`:48`/`:172`；`threat-model.md:23`），但**可信边界**（Worker 不可读/不可继承配置）仍未验证（threat-model `:43`）。
- **A4**：G1 第 7/8 项是 A4 验证的前置（`ROADMAP-95-PREREQUISITES.md:46-47`；`ROADMAP-95.md:210` "同一用户时，把状态目录移出检出目录**不构成隔离**"）；未补齐则 D1 到不了 L3（PREREQUISITES `:47`）。
- **H6/R2**：候选 B 依赖宿主独立 UID/只读状态目录；现状不支持（本文件结论 5 + `2026-11-11-h6-hardening-material.md` 重建版 §2.2）。

## 4. 引用清单与重放命令

```bash
cd /Users/zm/repos/hephi-review-main
sed -n '4p;20,21p;39,56p' hephi/docs/threat-model.md
sed -n '45,48p' ROADMAP-95-PREREQUISITES.md
sed -n '193p;210p' ROADMAP-95.md
sed -n '3p;40p' eval/evidence/g1-devset/PROGRESS.md
sed -n '9p' eval/evidence/g1-devset/T20-DEPLOY-RECORD.md
sed -n '154p' external-review/HANDOFF-R3.7-2026-11-07.md
sed -n '21p;129,139p;181,184p' eval/evidence/t10-host-verification/report.md
sed -n '23p;48p;172p' hephi/src/cli.ts
```

## 5. 明确未做 / 未知待补

- 未重新执行任何权限调查命令（未启动/停止 g1-ctl、未 `ps`/`ls`/`curl` 宿主）；未触发任何写入；未修改代码/配置。
- **未知/待补**：原版 §1 实测命令与输出（启动 pid、`curl 401`、`ps -o user`、`ls -la` 权限串、`state/worker-bin` 内容）；原版"宿主新版本是否提供只读路径配置"的复核方法；生产 3083 当时状态。
- 经验注入：Lead 给定 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`；因 experience-log 为 append-only（当前 45 行），本地无法复现该 pack，按任务卡点名 exp-028/029/040/043 读取，不虚构注入。
