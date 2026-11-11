# Dubbo 项目检查配置可审批清单（草案，待负责人批准；未批准前不得使用）

> **状态：草案，等待负责人批准。** 本文件不构成任何已批准的检查配置，也未被任何 host 加载；批准前不得把它作为 `HEPHI_VERIFICATION_FILE` 的内容使用，不得据此启动 B2/B3 运行。
> 任务：team task-36 ②（B 线准备：Dubbo 检查配置可审批清单）。执行者：hephi-req。日期 2026-11-12。基线：`/Users/zm/repos/hephi-review-main` @ `781ff0c`（只新增本文件，不改任何配置/代码）。
> 配套材料：同一任务 ① 的 `eval/evidence/b-line/b0-t02-budget-request.md`（计量额度申请，与本文互不替代）。
> 红线：**不编造 Dubbo 检查项内容**——有实测依据的写依据，缺依据的写"待负责人指定"；不修改 `hephi/docs/project-config.md`；不跑付费任务；不 clone 全仓、不执行真实 prepare。

## 0. 摘要（要批准什么）

| # | 待批准项 | 现状 | 依据 |
| --- | --- | --- | --- |
| 1 | 是否为 Dubbo 新增项目检查配置，路径是否用 `experiment/project-config/dubbo-checks.json` | **不存在**（仓库内无该文件；`project-config.md` 无 Dubbo 条目） | `hephi/docs/project-config.md`（`grep -in dubbo` 0 命中，实测）；`eval/B7-data.md:63` 已提出需负责人决定新增该文件 |
| 2 | `HEPHI_VERIFICATION_FILE` 具体指向哪个文件、包含哪些检查项（编译/测试/静态检查） | **无配置可指向**；字段缺失时 prepare 直接失败（fail-closed） | `hephi/scripts/prepare-dubbo.sh:34-35`；`hephi/docs/project-config.md:344-347` |
| 3 | 每个检查的 `command`/`args`/`kind`/`required`/`timeoutMs`/预估耗时 | 仅有 **dubbo-common 作用域**的两条 P10 命令实测通过；全仓离线构建失败（缺 netty）；静态检查无任何执行证据 | `eval/B7-data.md:21`/`:29`/`:61`；证据日志 `eval/evidence/b7env/` |
| 4 | 任务 base commit / 模块作用域 | `42bd630514371db37b09afb36dae7190a82662d6` 只是干净克隆的 HEAD，**不能**直接当任务 base | `eval/B7-data.md:21`；本文件 §3 标"待负责人指定" |
| 5 | 是否预热 `~/.m2` 缺依赖（全仓离线构建前置） | 未补齐；当前全仓 `mvn -o ... compile` exit 1 | `eval/B7-data.md:21`/`:61` |
| 6 | 是否允许一次**受控 prepare 验证**（会产生宿主/GitHub 读操作，不产生付费 Worker 运行） | 未执行 | 本文件 §4 |

## 1. 现状事实（逐条可重放）

### 1.1 检查配置缺失（硬前置）

- `grep -in dubbo hephi/docs/project-config.md` → **0 命中（exit 1）**，实测 2026-11-12；`project-config.md` 未登记任何 Dubbo 检查项。
- 同一事实已由 B1.2 可行性核对记录：`eval/evidence/b12-task-drafts/feasibility.md:28`（"目前没有项目检查配置。补齐须作为明确任务报负责人批准"），并引 `hephi/scripts/prepare-dubbo.sh` 的 fail-closed 语义（B1.2 撰写时口径为 33-36 行；本单实读行号为下方 31/33-35）。
- **fail-closed 语义（实读行号）**：`hephi/scripts/prepare-dubbo.sh` 在创建/准备合同前强制要求：
  - `:31` `: "${HEPHI_SOURCE_REPO:?set the existing local project clone}"`（源码仓必需）；
  - `:33` `: "${HEPHI_ALLOWED_PATHS:?set the approved project paths}"`（合法路径必需）；
  - `:34` `: "${HEPHI_VERIFICATION_FILE:?set the frozen project check configuration file}"`（**检查配置必需**）；
  - `:35` `[ -r "$HEPHI_VERIFICATION_FILE" ] || { echo 'HEPHI verification configuration is unreadable' >&2; exit 1; }`（**不可读即 prepare 失败**）。
  - 即：没有批准后的检查配置文件，Dubbo 场景的 prepare 无法完成，B2/B3 无法进入。
- 配置来源与格式：`HEPHI_VERIFICATION_FILE` 指向严格 JSON 的检查配置，prepare 时冻结进合同（`hephi/docs/project-config.md:344-347`，示例见 `:344-390`）；检查项 schema 为 `VerificationCheck`：`id`/`kind`/`purpose`/`command`/`args`/`cwd`/`required`/`timeoutMs`（`hephi/src/contracts/checks.ts:12-25`），且 `kind` **只有 `build` | `test` 两种**（`:14`、`:84`）——静态检查只能以 `build` 类别承载，schema 无独立 lint 类型。
- 可选离线要求：`verification.environment?: {offline?: boolean; lockfile?: string}`（`hephi/docs/project-config.md:80-86`，additive、随合同冻结；`offline:true` 时 prepare 会扫描 checks 命令中的联网行为并失败）。

### 1.2 Dubbo 仓可达性

- 本地源：`/Users/zm/workspace/app/dubbo` @ `42bd630514371db37b09afb36dae7190a82662d6`（`git -C … rev-parse HEAD` 实测）。
- 本次实测（本地路径，不依赖外网）：`git ls-remote --heads /Users/zm/workspace/app/dubbo` → **exit 0**（可见 `refs/heads/3.3`、`agent/*` 等分支，实测 2026-11-12）。
- 历史记录（非本次重跑）：`git ls-remote --heads https://github.com/apache/dubbo.git` exit 0（`eval/evidence/b12-task-drafts/legacy-system.md:13`，2026-11-12 实测；完整 clone 未执行、体量未测）。
- 结论：仓可达 → 配置可落地；但 **base commit、分支、模块作用域仍需负责人指定**（§3）。

### 1.3 构建/测试环境现状（决定哪些检查项可先写）

- 工具链：`JAVA_HOME=openjdk@17`、Maven 3.9.9、`~/.m2` 5.4G 的干净克隆（`eval/B7-data.md:21`）。
- **已实测通过（仅 dubbo-common 作用域）**（`eval/B7-data.md:21`，原始日志 `eval/evidence/b7env/dubbo-p10-compile.log`、`dubbo-p10-test.log`）：
  - `mvn -o -B -pl dubbo-common -am -DskipTests ... compile` → exit 0（BUILD SUCCESS 3.591s）；
  - `mvn -o -B -pl dubbo-common -Dtest=StringUtilsTest test` → exit 0（37 tests, 0 failures）。
- **全仓离线构建失败**（`eval/B7-data.md:21`/`:61`，日志 `eval/evidence/b7env/dubbo-offline-compile.log`）：`org.jboss.netty:netty:3.2.10.Final` 不在本地 `~/.m2`，离线模式不回退下载 → 若全仓构建要作为 required 检查，须先在离线前预热该依赖（需负责人批准网络/依赖预置）。
- 就绪矩阵：dubbo 当前 `environmentReady=true`、`offlineBuild=false`、`checksConfig=false`（`eval/B7-data.md:29`）；B7 组合 6 中仅 hephi×2 eligible，dubbo×2 blocked（`eval/B7-data.md:53`）。
- **不存在 `dubbo-checks.json`**（`eval/B7-data.md:29`/`:63`）。

### 1.4 影响面：遗留系统场景 12 个父任务

- 12 个探查父任务 = B2 开发集试验 6（`L-B2-1`…`L-B2-6`）+ B3 基线探查 6（`L-B3-1`…`L-B3-6`）（`eval/evidence/b12-task-drafts/legacy-system.md` §0-§3；清单表见该文件 §2/§3）。
- **在检查配置（前置 1）与训练截止后修复清点（前置 3）补齐前，全部 12 个父任务状态为「待批」，不得进入任何运行**（`eval/evidence/b12-task-drafts/legacy-system.md:17`；前置表 `:12`）。
- D-5 决策已定：Dubbo 为遗留系统任务源，"目前没有项目检查配置，须作为明确任务补齐并经负责人批准，不自动编造"（`eval/approvals/2026-11-11-unrelated-refactor-track-decisions.md:43`）。

## 2. 需要负责人批准的具体项（不预填内容）

| # | 待批项 | 可选项/建议 | 备注 |
| --- | --- | --- | --- |
| A1 | 配置路径 | 建议 `experiment/project-config/dubbo-checks.json`（与 `eval/B7-data.md:63` 的提议一致）或负责人指定 | 只要路径稳定、可被 `HEPHI_VERIFICATION_FILE` 指向即可 |
| A2 | 检查项集合 | 建议至少覆盖：**编译（build）**、**单元测试（test）**、**静态检查（build 类别承载）**；是否加"整套回归（test）"由负责人定 | 无静态检查执行证据，command/args 待指定 |
| A3 | 每项 `command`/`args`/`cwd` | 已有实测的仅 dubbo-common 两条（§3 R1/R2）；其余 **待负责人指定** | 不编造 maven 目标/模块范围 |
| A4 | 每项 `required` | **待负责人指定**（哪些检查必须通过才允许 ready） | 与验收口径强相关 |
| A5 | 每项 `timeoutMs` / 预估耗时 | 编译有 3.591s 实测（仅 dubbo-common 作用域，可作参考下限）；其余 **待补/待负责人指定** | 不把局部实测外推为全仓耗时 |
| A6 | 任务 base commit / 分支 / 模块作用域 | **待负责人指定**；现有 `42bd630…` 仅干净克隆 HEAD，不是任务 base | 任务 base 还须满足 B2/B3 选型（训练截止后修复） |
| A7 | 全仓构建与依赖预热 | 是否批准先预热 `~/.m2`（含 `netty:3.2.10.Final`）以支持全仓离线构建 | 未预热前全仓构建立即失败（§1.3） |
| A8 | 受控 prepare 验证 | 是否允许一次受控 prepare（GitHub 只读 + 宿主状态写入，不产生付费 Worker 运行） | 见 §4 |

## 3. 检查项清单草案（表格化；缺依据处写"待负责人指定"）

说明：`kind` 只能取 `build`/`test`（`hephi/src/contracts/checks.ts:14`）；"静态检查"按 schema 只能以 `build` 承载。下表的 `command`/`args` 除标注"实测"者外均**不是已批准内容**，批准前不得写入配置。

| id（建议） | purpose | command | args | kind | required | 预估耗时 | 依据/状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `dubbo-compile-core` | dubbo-common 作用域编译（P10 已验证命令） | `mvn` | `-o -B -pl dubbo-common -am -DskipTests compile`（示例按实测命令整理；完整参数以 `eval/evidence/b7env/dubbo-p10-compile.log` 为准） | `build` | **待负责人指定** | 3.591s（实测 BUILD SUCCESS，仅 dubbo-common 作用域） | 实测通过（`eval/B7-data.md:21`）；是否作为 required 待批 |
| `dubbo-unit-core` | dubbo-common 单元测试（P10 已验证命令） | `mvn` | `-o -B -pl dubbo-common -Dtest=StringUtilsTest test`（示例；`-Dtest` 范围是否扩大**待负责人指定**） | `test` | **待负责人指定** | **待补**（仅知 37 tests/0 failures，耗时未记录） | 实测通过（`eval/B7-data.md:21`）；单测范围待批 |
| `dubbo-static` | 静态检查（如 checkstyle/校验插件；schema 无 lint 类别，用 `build` 承载） | **待负责人指定** | **待负责人指定** | `build` | **待负责人指定** | **待负责人指定** | **无任何执行证据**；不编造命令 |
| `dubbo-full-compile` | 全仓离线编译（当前失败：缺 netty） | `mvn` | `-o -B ... compile`（完整参数待负责人/预热后确定） | `build` | **待负责人指定**（若要 required，须先完成 A7 依赖预热） | **待补**（当前 exit 1） | 失败原因见 `eval/B7-data.md:21`/`:61` 与 `eval/evidence/b7env/dubbo-offline-compile.log` |
| `dubbo-full-regression` | 整套回归（可选） | **待负责人指定** | **待负责人指定** | `test` | **待负责人指定** | **待负责人指定** | 未验证；是否纳入由负责人决定 |

**明确未编造**：上表没有虚构任何 Dubbo 模块名、maven 目标、issue 编号或耗时；所有"待负责人指定"项均为事实缺失，不是遗漏。

## 4. 批准后如何验证（fail-closed 语义与命令）

批准后按以下顺序验证，任一步失败即停（不进入运行）：

1. **配置静态校验**（只读，可先做）：
   ```bash
   cd /Users/zm/repos/hephi-review-main
   [ -r "$HEPHI_VERIFICATION_FILE" ] && echo readable   # 必须 readable（`hephi/scripts/prepare-dubbo.sh:35`）
   node -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync(process.env.HEPHI_VERIFICATION_FILE,'utf8'));for(const k of ['id','kind','purpose','command','args','cwd','required','timeoutMs']) if(!(k in (c.checks||[])[0]||{})) throw new Error('missing field '+k); console.log('shape-ok', c.version, c.checks.length)"
   ```
   期望：`readable` 与 `shape-ok`；`version` 应为 `1`，字段齐全（schema 依据 `hephi/src/contracts/checks.ts:12-25`/`:41`）。
2. **负向验证（fail-closed 必须成立，受控实例）**：把 `HEPHI_VERIFICATION_FILE` 指向不存在路径执行 prepare-dubbo 路径，期望打印 `HEPHI verification configuration is unreadable` 且 **exit 1**（`hephi/scripts/prepare-dubbo.sh:35`）。该验证需要 `DSH_SUPERAGENT_*`/`HEPHI_STATE_DIR` 等环境，且会读 GitHub —— 属**受控 prepare**，须负责人批准（A8），不得在生产宿主上试。
3. **正向验证（冻结进合同）**：用获批准的配置对一张** Dubbo 测试任务卡**执行一次受控 prepare，核对 `activation.json.verification.checks` 与配置文件逐字段一致、`contractHash` 变化可复现（prepare 冻结路径见 `hephi/docs/project-config.md:344-347`）。此步需真实 Issue/宿主，属受控运行（A8）；**未批准前不执行**。
4. **升级回归**：任何宿主升级后按 `hephi/docs/host-compatibility.md:23-26` 复跑检查；配置变更须重新审批并重新冻结合同。

> 说明：本文件**没有**提供已验证的实际命令输出（除 §1.3 引用的既有 P10 实测日志外）；§4 的验证命令均为**批准后**要执行的步骤，不声称已执行。

## 5. 不做的影响（如实登记）

| 不做 | 影响 | 依据 |
| --- | --- | --- |
| 不批准检查配置 | 遗留系统场景 12 个父任务全部「待批」，B2/B3 无法进入；B7 的 dubbo×2 组合保持 blocked（eligible 仍为 hephi×2） | `eval/evidence/b12-task-drafts/legacy-system.md:17`；`eval/B7-data.md:29`/`:53` |
| 不指定 base/模块作用域 | 即使有配置也无法形成合法任务（B2/B3 选型未定），且"训练截止后修复"清点未做 | `eval/evidence/b12-task-drafts/legacy-system.md:14`（前置 3）；`eval/evidence/b12-task-drafts/feasibility.md:28` |
| 不预热 netty | 全仓离线构建不可用；只能保留 dubbo-common 局部检查，不能声称整仓回归通过 | `eval/B7-data.md:21`/`:61` |
| 不授予受控 prepare 验证 | 配置只能停留在草案，无法证明能冻结进合同；fail-closed 负向也未被实测 | 本文件 §4；`hephi/scripts/prepare-dubbo.sh:34-35` |

## 6. 待负责人决定（汇总）

1. A1 配置路径；A2 检查项集合（编译/测试/静态检查/整套回归）；A3 每项 command/args/cwd；A4 required；A5 timeoutMs/预估耗时。
2. A6 任务 base commit/分支/模块作用域（与 B2/B3 选型绑定）。
3. A7 是否批准 `~/.m2` 依赖预热（`netty:3.2.10.Final` 等）以支持全仓离线构建。
4. A8 是否批准一次受控 prepare 验证（含负向 fail-closed 与正向合同冻结核对）。
5. 批准形式：书面批准/在决策记录登记；未登记前本文件保持"草案"，不得作为 `HEPHI_VERIFICATION_FILE` 使用。

## 7. 引用清单与重放命令

```bash
cd /Users/zm/repos/hephi-review-main
grep -in dubbo hephi/docs/project-config.md; echo "grep_exit=$?"        # 期望 0 命中 / exit 1
git -C /Users/zm/workspace/app/dubbo rev-parse HEAD                     # 42bd6305…
git ls-remote --heads /Users/zm/workspace/app/dubbo | head -3; echo "ls_remote_exit=$?"   # exit 0（本地路径）
sed -n '31p;33,35p' hephi/scripts/prepare-dubbo.sh                      # fail-closed 语义
sed -n '344,347p;80,86p' hephi/docs/project-config.md                   # HEPHI_VERIFICATION_FILE 与 offline 约定
sed -n '12,25p;41p;84p' hephi/src/contracts/checks.ts                   # VerificationCheck 字段与 kind 枚举
sed -n '21p;29p;43p;53p;61,63p' eval/B7-data.md                         # dubbo 构建/就绪/缺口事实
ls eval/evidence/b7env/                                                 # dubbo-p10-compile.log / dubbo-p10-test.log / dubbo-offline-compile.log
sed -n '8p;12,13p;17p' eval/evidence/b12-task-drafts/legacy-system.md   # 前置表与 12 父任务"待批"
sed -n '28p' eval/evidence/b12-task-drafts/feasibility.md               # "目前没有项目检查配置"
sed -n '43p' eval/approvals/2026-11-11-unrelated-refactor-track-decisions.md  # D-5
sed -n '23,26p' hephi/docs/host-compatibility.md                        # 升级回归
```

**引用核对（自动审计）**：对本文运行引用核对脚本（完整 `file:line` + 同文件 `:line` 缩写按左侧最近文件解析；校验文件存在且行号 ≤ 文件行数）：**引用结果见下方"核对输出"**（由本次执行填入；0 problem 才算通过）。

- 核对输出（2026-11-12 实测）—— 共 **52 处引用 / 8 个文件**，0 处缺失、0 处行号越界、0 处无法解析（0 problem）。覆盖：`hephi/docs/project-config.md`、`hephi/scripts/prepare-dubbo.sh`、`hephi/src/contracts/checks.ts`、`hephi/docs/host-compatibility.md`、`eval/B7-data.md`、`eval/evidence/b12-task-drafts/legacy-system.md`、`eval/evidence/b12-task-drafts/feasibility.md`、`eval/approvals/2026-11-11-unrelated-refactor-track-decisions.md`。

## 8. 明确未做

- 未修改 `hephi/docs/project-config.md` 或创建任何 `experiment/project-config/dubbo-checks.json`；本文件只是审批草案。
- 未编造任何 Dubbo 检查项命令、模块名、issue 编号、耗时或联系人；缺失项统一写"待负责人指定/待补"。
- 未 clone 全仓、未执行真实 prepare、未跑付费任务、未连宿主。
- 未批准前，本文任何表格内容都不得写入 `HEPHI_VERIFICATION_FILE`。
