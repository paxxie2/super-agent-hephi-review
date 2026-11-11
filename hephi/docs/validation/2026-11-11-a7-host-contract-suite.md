# A7 宿主契约测试合并（可选夹具门）— 2026-11-11

> **重建版（2026-11-12 重建），依据：现存脚本 `hephi/scripts/check-stage-host.mjs`（PASS 文案在其末尾 `console.log`）、`hephi/scripts/check-binding-host.mjs --self-test`（`SELF-TEST: PASS`）、任务板 task-15 的原始规格与完成记录（含两次运行退出码/耗时/跳过原因）、`hephi/docs/host-compatibility.md` L21-39/L74-75、`ROADMAP-95.md` L256-259、`hephi/docs/validation/2026-11-07-a2-final.md` L59/L93、`2026-11-07-evidence-chain-host.md` L156，非原始文件。**
> 原文件（测试+文档）随已删除分支 `agent/roadmap95` 丢失：`git log --all -- hephi/tests/host/host-contract.test.ts` / `git log --all -- hephi/docs/validation/2026-11-11-a7-host-contract-suite.md` 均 0 commits（2026-11-12 实测）。
> 本任务只重建测试与文档（纯测试+文档）；**未重建 `hephi/src/control/snapshot-seal.ts`**（H6 检测实现本体缺失，见 §5）。
> 经验注入：Lead 给定 `pack_sha256=4768c226ffac53544196458bb74fc4137678fb996af5f135163beb3552054673`；experience-log 为 append-only，当前已 53 行，内容寻址哈希随日志变化，**本地无法复现该 pack**（见 §7）；按任务卡点名条目（含 exp-046 重建版标注要求）执行，不虚构注入。

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 重建套件 | `hephi/tests/host/host-contract.test.ts`（94 行，1 个 opt-in 测试，串起 2 个真实入口） |
| 带 env 真跑 | **exit 0**；`Tests 1 passed (1)`；测试耗时 2406ms（vitest Duration 2.52s，wall 3.15s） |
| 不带 env 跑 | **exit 0**；`Tests 1 skipped (1)`；stderr 打印明确跳过原因；耗时 100ms |
| 门控负面（不合规根） | **exit 0**；1 skipped；原因含 `does not contain @deepseek-ai/dsh-tools`；耗时 146ms |
| 类型检查 | `npx tsc --noEmit`（cwd=`hephi`）**exit 0**（含本新文件） |
| 夹具 | `/Users/zm/dsh-instances/runtime/node_modules`，实读 `@deepseek-ai/dsh-tools` = **0.2.1-rc.5** |

## 1. 目标与合并方式

ROADMAP-95 §A7（`ROADMAP-95.md:256-259`）要求"把 A2 的夹具和现有的 `check-stage-host.mjs` 合并成一套宿主契约测试，覆盖事件结构、`tools/pre-execute`、工具守卫、Job 接口、系统提示；每次升级宿主前先跑；结果记进 `hephi/docs/host-compatibility.md`"。

本次重建**可执行部分**（不能改既有脚本，故以子进程串起两个真实入口）：

| # | 入口 | 覆盖内容 | 断言 |
| --- | --- | --- | --- |
| 1 | `node hephi/scripts/check-stage-host.mjs <DSH node_modules>` | 真实安装 DSH rc.5 的 tool dispatch、scoped visibility、`tools/pre-execute` 守卫、progress 事件（脚本自述"fixture Agent/report/jobs, not Worker or Issue E2E"） | exit 0 且 stdout 含 `PASS: real installed DSH tool dispatch/scoped visibility/guard/progress events`（`hephi/tests/host/host-contract.test.ts:87-88`） |
| 2 | `node hephi/scripts/check-binding-host.mjs --self-test` | A2 H1/H2/H4 探针的解析/判定自测（合成 Session 形状，非真实宿主证据） | exit 0 且 stdout 含 `SELF-TEST: PASS`（`hephi/tests/host/host-contract.test.ts:89-90`） |

- 两个入口**先都执行再断言**（`hephi/tests/host/host-contract.test.ts:76-85`），任一失败时断言消息携带双方 `exit`/`timedOut`/`stdout`/`stderr` 关键片段（`detail()`，`:57-67`），便于归档失败证据。
- 测试超时 180s（`hephi/tests/host/host-contract.test.ts:92`），单入口子进程 120s（`hephi/tests/host/host-contract.test.ts:80`、`:84`）。

## 2. 环境门与离线安全

| 规则 | 实现位置 | 行为 |
| --- | --- | --- |
| 仅当 `HEPHI_DSH_FIXTURE_ROOT` 非空、目录存在、且含 `@deepseek-ai/dsh-tools` 时执行 | `hephi/tests/host/host-contract.test.ts:32-37` | 条件不满足 → `it.skipIf`（`hephi/tests/host/host-contract.test.ts:73`） |
| 未设置/条件不满足时打印明确原因 | `:39-42`（模块级 `console.warn`） | 输出 `[A7 host contract] SKIP: …`，区分"未设置"与"目录不含 dsh-tools"两种原因（`hephi/tests/host/host-contract.test.ts:36-37`） |
| 不得让普通 `pnpm test` 因缺外部夹具失败 | 全量 `vitest run` 的 `include: tests/**/*.test.ts`（`hephi/vitest.config.ts:5`）会收集本文件，无 env 时 skip 计为通过 | 已由 §3.2 运行验证 |

## 3. 真实运行记录（两次必需验证 + 一次负面门控）

运行环境：macOS，本机；`cwd=/Users/zm/repos/hephi-review-main/hephi`；vitest `v4.1.12`。
夹具根：`/Users/zm/dsh-instances/runtime/node_modules`，其中 `@deepseek-ai/dsh-tools` = **0.2.1-rc.5**（实读 `package.json`）。

### 3.1 带 env 真跑（通过）

```bash
HEPHI_DSH_FIXTURE_ROOT=/Users/zm/dsh-instances/runtime/node_modules \
  npx vitest run tests/host/host-contract.test.ts
```

| 项 | 值 |
| --- | --- |
| 退出码 | **0** |
| 关键输出 | `✓ tests/host/host-contract.test.ts (1 test) 2406ms`；`✓ stage fixture (real DSH dispatch/scope/guard/progress) + A2 binding self-test 2406ms`；`Test Files 1 passed (1)`、`Tests 1 passed (1)` |
| 耗时 | 测试 2406ms；vitest Duration 2.52s；wall 3.15s |

### 3.2 不带 env（跳过，exit 0）

```bash
npx vitest run tests/host/host-contract.test.ts   # HEPHI_DSH_FIXTURE_ROOT 未设置
```

| 项 | 值 |
| --- | --- |
| 退出码 | **0** |
| 关键输出 | `↓ tests/host/host-contract.test.ts (1 test | 1 skipped)`；`Test Files 1 skipped (1)`；`Tests 1 skipped (1)` |
| stderr（明确原因） | `[A7 host contract] SKIP: HEPHI_DSH_FIXTURE_ROOT is not set (opt-in: point it at the DSH 0.2.1-rc.5 node_modules root, e.g. /Users/zm/dsh-instances/runtime/node_modules)` |
| 耗时 | 100ms |

### 3.3 附加：门控负面验证（env 指向不合规根）

```bash
HEPHI_DSH_FIXTURE_ROOT=/tmp/a7-rebuild-empty npx vitest run tests/host/host-contract.test.ts
```

| 项 | 值 |
| --- | --- |
| 退出码 | **0** |
| 关键输出 | `Tests 1 skipped (1)` |
| stderr | `[A7 host contract] SKIP: HEPHI_DSH_FIXTURE_ROOT=/tmp/a7-rebuild-empty does not contain @deepseek-ai/dsh-tools` |
| 耗时 | 146ms（临时目录运行后已清理） |

## 4. 覆盖边界（能声称 / 不能声称）

| 可以声称 | 不可以声称 |
| --- | --- |
| 在真实安装的 DSH `0.2.1-rc.5` 包上，staged fixture 的 tool dispatch / scoped visibility / `tools/pre-execute` 守卫 / progress 事件契约形状通过 | 宿主升级回归通过（**没有升级事件，也未模拟**） |
| A2 探针（`check-binding-host.mjs`）的 H1/H2/H4 解析与判定自测通过（合成形状） | 真实 A2 宿主证据（H3/H5/H6 仍为 manual/fail；H6 见 §5） |
| 缺外部夹具时套件安全跳过且原因明确 | Worker/Issue E2E（本套件是 fixture 级；A5 仍是历史记录 + E5/E9 blocked） |
| 两个入口在同一 suite 内串行执行、失败时保留双方输出片段 | A6 红队结论（宿主红队未执行） |
| — | DSH 兼容性已通过 / 插件已与宿主契约兼容（本文只固定测试入口，不改变兼容性结论） |

## 5. **H6 检测实现本体缺失报告（需负责人决定）**

> 本任务**未重建**该生产代码。以下为实测缺失事实，供负责人决定。

| 检查项 | 实测结果（2026-11-12，HEAD `d2b5eb1`） |
| --- | --- |
| `hephi/src/control/snapshot-seal.ts`（H6 检测实现本体） | **不存在**；`git log --all -- hephi/src/control/snapshot-seal.ts` = **0 commits** |
| `hephi/tests/control/snapshot-seal.test.ts`（H6 检测测试） | **不存在**；同样 0 commits（本任务按卡未重建） |
| 生产代码是否仍引用该模块 | **无**：`grep -rn "snapshot-seal\|snapshotSeal" hephi/src hephi/tests` 在 src/tests 内无命中（仅历史/重建文档提及）→ 无悬空 import、无构建破坏，但**该检测能力在当前 main 上完全缺失** |
| H6 判据/定案（能力必要性依据） | 判据 `2026-11-07-evidence-chain-host.md:156`（人工一次性实例）；定案 **fail**（`2026-11-07-a2-final.md:59`，`append_exit=0/state_write_exit=0`）；A2 证据表 H6 行仍"待填写"（`2026-11-07-evidence-chain-host.md:93`） |
| 影响 | 当前 main 无 H6 检测层（连 detect-only 都没有）：H6 仍是 fail，强绑定保持关闭、D1 上限 L1 的既有结论不变；若负责人要恢复"检测已列举篡改"的纵深防御，需以**新增生产代码**方式重建 `snapshot-seal.ts`（+测试），本任务未做 |

**结论**：H6 检测（detect-only）实现缺失 → **需负责人决定是否重建**；在决定前，本套件与文档不声称任何 H6 检测能力存在。

## 6. 与 `host-compatibility.md` 的关系

- 本套件是 `hephi/docs/host-compatibility.md:21-39` 回归规则 1 中 **A2 探针 + `check-stage-host.mjs`** 两个入口的可执行封装；该文件 §2b/§2c/§4 的既有结论与未验证项（含"尚无升级事件"`:74-75`）**均不变**。
- 本文件按任务限制**未编辑** `host-compatibility.md`。建议（属另行任务）：把本 suite 与 `HEPHI_DSH_FIXTURE_ROOT` 登记进 §2 回归清单；宿主升级时同时记录夹具根版本与本次 suite 结果；并把 `tests/host` 纳入分层入口（当前 `test:unit`/`test:integration` 未列该目录，只有全量 `pnpm test` 会收集并 skip）。

## 7. 自报：命令、退出码与关键输出

| # | 命令（cwd=`hephi`，除注明外） | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| 1 | `HEPHI_DSH_FIXTURE_ROOT=/Users/zm/dsh-instances/runtime/node_modules npx vitest run tests/host/host-contract.test.ts` | **0** | `Tests 1 passed (1)`；测试 2406ms；wall 3.15s |
| 2 | `npx vitest run tests/host/host-contract.test.ts`（不带 env） | **0** | `Tests 1 skipped (1)`；stderr 打印 `[A7 host contract] SKIP: … is not set …`；100ms |
| 3 | `HEPHI_DSH_FIXTURE_ROOT=/tmp/a7-rebuild-empty npx vitest run tests/host/host-contract.test.ts` | **0** | `Tests 1 skipped (1)`；stderr `… does not contain @deepseek-ai/dsh-tools`；146ms |
| 4 | `npx tsc --noEmit` | **0** | 无输出（类型检查通过，含新测试文件） |
| 5 | `node -e "require('…/dsh-tools/package.json')"` | 0 | `@deepseek-ai/dsh-tools 0.2.1-rc.5` |
| 6 | `git log --all --oneline -- hephi/src/control/snapshot-seal.ts`（仓库根） | 0 | 0 commits（实现缺失确证） |
| 7 | `grep -rn "snapshot-seal" hephi/src hephi/tests`（仓库根） | 1（无命中） | 无输出 → 无引用 |
| 8 | `python3 harness-assets/build-experience-pack.py --tags …`（工作区根） | — | Lead 给定 `pack_sha256=4768c226…` 本地无法复现（experience-log 已 append 至 53 行，内容寻址哈希随日志变化）；按任务卡点名条目执行，不虚构注入 |

## 8. 明确未做与限制

- 未重建 `hephi/src/control/snapshot-seal.ts` 与其测试（生产代码缺失，按卡先报告，见 §5）。
- 未模拟/等待宿主升级事件；未执行真实 A2 探针（真实 Session 输入）、A5 E2E、A6 宿主红队。
- 未改 `hephi/src/`、`package.json`、`vitest.config.ts`、既有测试、`host-compatibility.md`、ROADMAP 或任何既有记录。
- 未执行全量 `pnpm test`（避免与同机其它任务竞争；本套件无 env 时的 skip 行为已单独验证）。
- 夹具根是**本机** `/Users/zm/dsh-instances/runtime/node_modules`；换机/换宿主版本必须重新指定 `HEPHI_DSH_FIXTURE_ROOT`，其版本必须与被验证的宿主一致，否则结论不可外推。
