# HEPHI：Super Agent 的交付核验插件

只复用 Super Agent 原生 Ticket、Worker、工作区和 PR 流程，不提供第二套交付执行器。

## 当前流程

1. 原生 prepare 冻结任务合同：仓库、base、范围和项目检查命令。
2. Worker 读取合同；配置了知识库时查询对应知识库。
3. Worker 实施，通过 `hephi_check(checkId)` 运行合同中的检查。
4. 检查工具保存真实执行结果、日志及前后代码指纹。
5. Worker 按原生流程推送并创建 PR，调用 `orchestrator_report(ready)`。
6. ready 核对必需检查、证据、代码版本、范围和合同要求的 PR，不重新执行项目测试。

`native` 使用 DSH 原生执行能力；明确选择 `staged` 时，启用原有串行阶段工具，按检查、checkpoint、成功 progress 推进。两种模式使用同一最终核验入口。

全局工具仅有 `hephi_get_contract` 和 `hephi_kb_search`；检查及可选阶段工具挂到当前 Worker。旧 Delivery 工具、Recipe 和项目专用 ready 验证器已删除。

## 检查配置

`scripts/prepare-dubbo.sh` 保留现有入口文件名，内容已改成项目无关：只处理带 `hephi/delivery` 标签的 Issue。宿主必须显式提供 `HEPHI_SOURCE_REPO`（本地 clone）、`HEPHI_STATE_DIR`（与插件一致）、`HEPHI_ALLOWED_PATHS` 和 `HEPHI_VERIFICATION_FILE`。不再内置仓库名单、个人路径或默认验收命令；缺配置直接报错。

通过 prepare 的 `HEPHI_VERIFICATION_FILE` 指向项目检查配置，例如：

```json
{
  "version": 1,
  "checks": [{
    "id": "business-regression",
    "kind": "test",
    "purpose": "执行本项目必需的业务回归",
    "command": "node",
    "args": ["scripts/check-business.cjs"]
  }]
}
```

项目检查入口负责正确选择测试，并在目标测试未执行、断言失败或其他不满足验收条件时非零退出。命令成功不自动证明 Issue 业务正确，更不能把单纯构建成功当作业务验收。GitHub 交付应明确设置 `HEPHI_REQUIRE_PULL_REQUEST=1`。

检查可以是前台命令，也可以是宿主原生后台 Job；HEPHI 等待其终态。取消、超时或未知结果不会放行，这些异常的恢复能力尚未完成。

## 任务卡

`HEPHI_REQUIRE_TASK=1`（prepare 脚本默认开启）时，Issue 正文必须包含任务卡，否则不创建合同：

````text
```hephi-task
{
  "version": 1,
  "goal": "total() 返回两数之和",
  "outOfScope": ["定价规则", "模块结构调整"],
  "acceptance": [
    { "id": "AC1", "text": "total(2, 3) 为 5", "check": "price",
      "paths": ["src/price.js", "tests/price*"] }
  ]
}
```
````

- 合同哈希覆盖整张任务卡。目标、非目标和各验收项每轮都在 Worker 系统提示中。
- 每个验收项指向一个已冻结的项目行为检查（`kind: "test"`；构建检查不能作为验收）。ready 要求所有 required 检查和验收项引用的检查都在当前 HEAD 上通过；多个验收项引用同一检查时只运行、核验一次。HEPHI 不在 base 上重跑检查，复现或行为保持由项目检查本身表达。
- 改动文件必须同时落在 `HEPHI_ALLOWED_PATHS` 和某个验收项的 `paths` 内。直接 `write`/`edit` 的路径按实际检出目录解析（相对路径以 Session cwd 为基准，符号链接解析到真实位置），越界当场拒绝；shell 写入和读不到路径的调用由检查和 ready 时的最终 diff 兜底。
- ready 拒绝删除已有测试（`protect`，默认覆盖常见测试路径）。`budget`（`maxFiles`、`maxChangedLines`）只在 Issue 作者写明时生效。这些都是机械限制，不能识别允许路径内的语义漂移。
- 检查目录不存在等确定未启动的失败记为 `blocked`（原因以 `check not started:` 开头），修正后可重试，历史保留；可能仍在运行的执行记为 `unknown`，保持关闭，需人工处理。
- `HEPHI_REQUIRE_SESSION_BINDING=1` 时，ready 要求每条证据在当前 Worker Session（不含继承事件）中有且仅有一个同 callId 的 `bash` 调用，命令和目录与记录一致，且有一个非错误的结果；结果带退出码时必须与记录一致。默认关闭：内部检查调用在真实宿主 Session 中的事件结构尚未核实。
- 检查命令不接受 `parser`、`reportPaths`、`targetTests`、`expect` 字段；任务卡不接受 `hephi-test` 块；已有此类配置必须明确修订后创建新任务，不能静默忽略。

## 开发和验收

```sh
pnpm install
pnpm check
```

`check` 执行类型检查、自动测试和构建。这些检查不等于原生 GitHub → Worker → 赫菲 → PR 的真实端到端验收。历史运行记录在 `docs/validation/`，只能证明所标明的版本；新改动须重新验收。

构建后通过现有 DSH profile 加载插件，不启动另一套 Super Agent。部署前确认当前任务状态，不用重启宿主中断其他会话。
