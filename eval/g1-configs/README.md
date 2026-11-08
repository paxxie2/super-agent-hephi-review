# G1 暂存项目检查配置（T09）

状态：**暂存配置（staged）**。本目录只存放 T15 一次性实验实例将使用的 project 检查配置副本，
**没有修改 `/Users/zm/dsh-instances/experiment/project-config/` 或任何实例文件**，也尚未在任何实例上生效。
部署时由运维把本目录文件复制到各实例的 `project-config/`（见 §4）。本任务唯一的自检是 `JSON.parse`（见 §6），
它只证明 JSON 语法合法，**不证明这些检查在实例上可运行，也不构成任何验收通过**。

## 1. 目的与边界

- 为 T15 一次性实验实例准备 G1 版项目配置：
  1. `requirePlan: true`：开启 C4.2 变更计划 fail-closed（依据 `hephi/docs/project-config.md` §6；
     未启用时 C4.2 是 optional，本配置把它显式打开）；
  2. `protectedAssets`：声明项目级受保护验收资产 glob（C1，依据 `project-config.md` §3）；
  3. 按 `project-config.md` §8（T08）模式新增**独立 acceptance 检查**：只跑 acceptance 目录、JUnit 写
     `$HEPHI_RUN_DIR/junit.xml`、`kind:"test"`、`required:true`、`assertionFailureTypes:["AssertionError"]`；
     并让原回归检查排除 acceptance 目录（无法安全排除的配置在 §3 说明）。
- **不在此文件控制范围**：prepare 侧环境变量 `HEPHI_REQUIRE_PULL_REQUEST=1`（→ 合同 `requirePullRequest:true`，
  ready 需要 PR 且 base/head 与冻结合同一致）由实例启动/prepare 环境提供，**不由 project-config JSON 控制**；
  同样，审批人 `approvers` 按 `eval/RUNBOOK.md` §15 第 2 条本期**不配置**。
- 配置唯一事实源（只读参考，未修改）：`/Users/zm/dsh-instances/experiment/project-config/` 下 4 个同名 JSON。
  本目录文件以它们为底，只做 §3 列出的改动。

## 2. 文件对照

| G1 暂存文件（本目录） | 实例原文件（只读参考） |
| --- | --- |
| `b5-generic-checks.g1.json` | `/Users/zm/dsh-instances/experiment/project-config/b5-generic-checks.json` |
| `b5-site-pnl-checks.g1.json` | `/Users/zm/dsh-instances/experiment/project-config/b5-site-pnl-checks.json` |
| `hephi-checks.g1.json` | `/Users/zm/dsh-instances/experiment/project-config/hephi-checks.json` |
| `site-pnl-checks.g1.json` | `/Users/zm/dsh-instances/experiment/project-config/site-pnl-checks.json` |

## 3. 逐配置改动说明（diff 表）

JSON 不支持注释，因此「每处修改的来源」统一记录在本节表格里（对应任务要求的“注释字段说明来源”）。

**四个配置的共同改动**

| 字段 | 原值 | G1 值 | 依据 / 来源 |
| --- | --- | --- | --- |
| `requirePlan` | 无（默认 optional） | `true` | T09 任务；`project-config.md` §6（C4.2 fail-closed） |
| `protectedAssets` | 无 | `["**/test/**", "**/tests/**"]`（site-pnl 另加 `acceptance/**`） | T09 任务；`project-config.md` §3（C1） |
| `checks[].id = "acceptance"` | 无 | 新增检查（见各文件） | T09 任务；`project-config.md` §8（T08 模式） |
| `checks[].assertionFailureTypes` | 无 | 仅 acceptance 检查写 `["AssertionError"]` | T08 §8.1（additive 字段；当前只被 schema 接受并冻结，T18 才消费） |
| `approvers` | 无 | 仍然不配置 | `eval/RUNBOOK.md` §15 第 2 条（本期不配置审批人） |

### 3.1 `b5-generic-checks.g1.json`

| 字段 / 检查 | 原值 | G1 值 | 依据 / 来源 |
| --- | --- | --- | --- |
| `requirePlan` | 无 | `true` | 共同改动 |
| `protectedAssets` | 无 | `["**/test/**","**/tests/**"]` | 共同改动 |
| `project-regression`（compileall） | `python3 -m compileall -q backend/app` | **命令不变**，purpose 追加 G1 说明 | 任务允许：compileall 类检查不扫描测试目录，故保持原检查为 regression，无需排除 |
| `acceptance`（新增） | 无 | `python3 -m pytest backend/tests/acceptance -q --junitxml="$HEPHI_RUN_DIR/junit.xml"` | T08 §8；acceptance 目录按项目结构假设为 `backend/tests/acceptance`（见 §5） |

### 3.2 `b5-site-pnl-checks.g1.json`

| 字段 / 检查 | 原值 | G1 值 | 依据 / 来源 |
| --- | --- | --- | --- |
| `requirePlan` | 无 | `true` | 共同改动 |
| `protectedAssets` | 无 | `["**/test/**","**/tests/**"]` | 共同改动 |
| `project-regression`（money 测试） | `uv run pytest backend/tests/test_money.py -q` | **命令不变**，purpose 追加 G1 说明 | 原检查只跑单个文件、不扫描目录，天然不含 acceptance（等价于排除），不需要改命令 |
| `acceptance`（新增） | 无 | `uv run pytest backend/tests/acceptance -q --junitxml="$HEPHI_RUN_DIR/junit.xml"` | T08 §8；acceptance 目录假设为 `backend/tests/acceptance`（见 §5） |

### 3.3 `hephi-checks.g1.json`

| 字段 / 检查 | 原值 | G1 值 | 依据 / 来源 |
| --- | --- | --- | --- |
| `requirePlan` | 无 | `true` | 共同改动 |
| `protectedAssets` | 无 | `["**/test/**","**/tests/**"]` | 共同改动 |
| `project-regression` | `cd hephi && pnpm install --frozen-lockfile && pnpm check` | `cd hephi && pnpm install --frozen-lockfile && pnpm typecheck && pnpm exec vitest run --exclude 'tests/acceptance/**' && pnpm build`（显式复刻 `pnpm check` 并排除 acceptance） | 任务：原回归检查会跑全部 `tests/**`，必须排除 acceptance；purpose 同步更新 |
| `acceptance`（新增） | 无 | `cd hephi && pnpm install --frozen-lockfile && pnpm exec vitest run tests/acceptance --reporter=junit --outputFile="$HEPHI_RUN_DIR/junit.xml"` | T08 §8；acceptance 目录为 `hephi/tests/acceptance`（见 §5）；先装依赖，使该检查可独立于回归检查先跑 |

### 3.4 `site-pnl-checks.g1.json`

| 字段 / 检查 | 原值 | G1 值 | 依据 / 来源 |
| --- | --- | --- | --- |
| `requirePlan` | 无 | `true` | 共同改动 |
| `protectedAssets` | 无 | `["**/test/**","**/tests/**","acceptance/**"]` | 共同改动；额外含仓库根 `acceptance/**` |
| `project-regression` | `npm --prefix web ci --no-audit --no-fund && bash scripts/check.sh` | **命令不变**，purpose 追加 G1 说明 | 原检查是项目脚本 `scripts/check.sh`（不透明，不能安全注入排除参数）；改为把 acceptance 放在**仓库根 `acceptance/`**（backend/、web/ 之外），使回归脚本天然不包含它 |
| `acceptance`（新增） | 无 | `uv run pytest acceptance -q --junitxml="$HEPHI_RUN_DIR/junit.xml"` | T08 §8；acceptance 目录为仓库根 `acceptance/`（见 §5） |

## 4. 部署方式（T15/T20 由运维执行；本任务不执行、不改实例）

1. 选定实例（一次性实验实例），把本目录对应文件复制为其 `project-config/` 中的原文件名，例如：
   ```sh
   cp eval/g1-configs/b5-generic-checks.g1.json <instance>/project-config/b5-generic-checks.json
   ```
   （也可让 `HEPHI_VERIFICATION_FILE` 直接指向 `.g1.json`，二选一，由运维在 T15/T20 决定。）
2. 确认该实例 prepare 环境设置 `HEPHI_VERIFICATION_FILE=<instance>/project-config/<name>.json`，
   且 `HEPHI_REQUIRE_PULL_REQUEST=1`（合同 `requirePullRequest:true`；此项不在本 JSON 内）。
3. 回滚：恢复部署前的 `project-config/<name>.json` 备份（实例原文件保持原样，本任务未改）。
4. 部署后需真实 prepare 一次，确认冻结进合同的 `verification` 含 `requirePlan`/`protectedAssets`/`acceptance`；
   T11 下同 ticket 的 re-prepare 复用旧合同，**切换配置需要新合同**（新 ticket 或人工移除合同后重新 prepare）。

## 5. 假设与未验证项

- **acceptance 目录在 staging 时尚不存在**，均由 T15 任务创建：
  - `b5-generic-checks`、`b5-site-pnl-checks`：`backend/tests/acceptance/`；
  - `hephi-checks`：`hephi/tests/acceptance/`（项目根为插件仓库，检查内 `cd hephi`）；
  - `site-pnl-checks`：仓库根 `acceptance/`（为与不透明的 `scripts/check.sh` 隔离；前提是脚本只扫描
    `backend/` 与 `web/`，**未验证**；若它也扫描仓库根，需要实例侧改 acceptance 目录或项目脚本）。
- **工具假设**：`python3 -m pytest` / `uv run pytest` 可用；vitest 4 内置 junit reporter（`--reporter=junit --outputFile`）；
  pnpm 11 + Node 22.19（hephi 仓库 engines）。vite/vitest 的 `--exclude` CLI 语义按 vitest 4 假设，
  **未在实例上执行验证**（本任务不跑测试）。
- **`$HEPHI_RUN_DIR` 展开**：check 以单条 argv 启动，变量只在 `sh -c` payload 内展开；四个 acceptance 检查都按此写
  （`HEPHI_RUN_DIR` = `<stateDir>/hephi/<ticketId>/checks/<runId>`，见 `hephi/docs/project-config.md` §8.3）。
- **hephi 回归命令**是对 `pnpm check` 的显式复刻（typecheck + vitest + build），假定与 `pnpm check` 等价且
  `--exclude 'tests/acceptance/**'` 生效；需在 T15/T20 实例上核对。
- **`assertionFailureTypes` 目前无消费方**（T08 只做 schema/冻结；T18 才用于离线红态判定），
  因此本目录配置不声称“红态可判定”。
- 所有内容**未做实例部署、未做 prepare 冻结验证、未运行任何检查**；JSON 合法是唯一已验证项（§6）。

## 6. 自检（唯一“测试”）

```sh
cd /Users/zm/repos/hephi-dev-t09
node -e '
  const fs = require("fs");
  for (const name of ["b5-generic-checks", "b5-site-pnl-checks", "hephi-checks", "site-pnl-checks"]) {
    const file = `eval/g1-configs/${name}.g1.json`;
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    const acceptance = cfg.checks.filter(c => c.id === "acceptance");
    console.log(name, "JSON ok", `checks=${cfg.checks.length}`, `requirePlan=${cfg.requirePlan}`,
      `protectedAssets=${cfg.protectedAssets.length}`, `acceptance=${acceptance.length}`,
      `acceptanceRequired=${acceptance.every(c => c.required === true)}`,
      `acceptanceFailureTypes=${JSON.stringify(acceptance.map(c => c.assertionFailureTypes))}`);
  }
'
```

2026-11-08 实测输出（真实，未修饰）：

```
b5-generic-checks JSON ok checks=2 requirePlan=true protectedAssets=2 acceptance=1 acceptanceRequired=true acceptanceFailureTypes=[["AssertionError"]]
b5-site-pnl-checks JSON ok checks=2 requirePlan=true protectedAssets=2 acceptance=1 acceptanceRequired=true acceptanceFailureTypes=[["AssertionError"]]
hephi-checks JSON ok checks=2 requirePlan=true protectedAssets=2 acceptance=1 acceptanceRequired=true acceptanceFailureTypes=[["AssertionError"]]
site-pnl-checks JSON ok checks=2 requirePlan=true protectedAssets=3 acceptance=1 acceptanceRequired=true acceptanceFailureTypes=[["AssertionError"]]
```
