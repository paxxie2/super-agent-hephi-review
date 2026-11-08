# T21 D-9 投递一致性校验（off 实例 3093 短窗口）

- 日期/时间窗（UTC）：**2026-11-08T16:05:19Z 启动 3093 → 16:11:25Z 停止**（窗口 6m06s）；本机 Asia/Shanghai 为 2026-11-09 00:05–00:11。
- 对象仓库：`/Users/zm/repos/hephi-dev-base`（分支 `integration`，HEAD `e0a81e4`）。本记录**未 commit、未改产品代码**，只在 `eval/evidence/t21-prep/` 新增证据（untracked）。
- 任务卡：`eval/tasks/site-pnl-diagnosis/previous-window-order/issue.md`，**sha256 `f91d1b6afb6e1d97c6132c7537afd06b548c058886248b01405e0e095b0d3497`，657 bytes**；对应 base `1e166fbe2217ac378e5bb7062cd34a2da1e75e6f`。
- 依据：`eval/PREREG.md` §9 D-9（已锁定 v1.0）——off 组独立 profile、不挂载赫菲、不打 `hephi/delivery`；两组 `taskCard.sha256` 相同且 `verifiedEqual=true`；`eval/RUNBOOK.md` §4.3/§4.4。
- **GitHub API 调用总数：4**（§7）；未访问 3082/3083 的 API；未 merge 任何 PR；未跑测试套件。

## 1. off 实例（一次性，复用 B5 试跑存档）

考古依据：`eval/B5-off-entry.md` §2、`eval/evidence/b5off/`（README/isolation-snapshot/commands.log/off-settings-final.json）。本次按同一形态重建，**不修改** B5 存档路径下的文件。

| 项 | 值 |
| --- | --- |
| DSH_HOME | `/tmp/hephi-off-b5`（一次性，用后删除） |
| profile | `b5off`；bundles = `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`dsh-superagent`（**无 hephi 插件/skill/tools**） |
| webserver | `127.0.0.1:3093`（未占用 3082/3083） |
| provider/model | `deepseek-account` / `deepseek-flash` |
| stateDir | `/tmp/hephi-off-b5/state` |
| executor | directory=`/tmp/hephi-off-b5/work`，prepare=`/tmp/hephi-off-b5/prepare-off.sh`（复用 B5 形态：clone off 仓库 + checkout base `1e166fb` + `agent/<name>` 分支；不导出/不调用 hephi） |
| GitHub Source | `paxxie2/b5-off-site-pnl`，cli=`/Users/zm/.local/bin/gh-agent`，`pollSeconds=60`、`observeIssues=true`、`allowSelfAuthoredIssues=true`、`observePulls/Comments/Ci=false` |
| policy | 默认 copy/visual + `b5-off-task`（B5 试跑同款规则）；allowed senders `paxxie2`、`monsterhunterw2` |
| eval | `mode=auto`（B5 试跑同款；本次 Issue 因显式 @ 为 `strength=explicit`，不依赖推断） |
| pid / 启动 / 停止 | pid `33806`；启动 `16:05:19Z`；停止 `16:11:25Z`（`stop-off.sh`） |

启动命令与设置保存（均为本机 HTTP，不涉及 GitHub API）：

```sh
/tmp/hephi-off-b5/start-off.sh        # nohup node dsh/bin.js --profile b5off --no-open；写 host.pid/log
# 面板 API（同 origin，需头）：
# GET  /orchestrator/api/settings
# PUT  /orchestrator/api/settings/{policy,eval,executor,source:github}  body={value,revision}
#      4 次均 HTTP 200 saved=true revision=1（输出见 settings-put-*.json）
# POST /orchestrator/api/executor/pause 未使用（默认 paused=false）
```

健康快照（`state-ready.json`）：`setup.problem=null`；`accounts={repository: paxxie2/b5-off-site-pnl, agent: paxxie2}`；`paused=false`；health 10 项全部 `ready`；`load={running:0,queued:0}`。`start-off.sh` 第 10 行显式 `unset HEPHI_*`。

## 2. 投递机制（RUNBOOK §4.3 A：同文 Issue body）

- off Issue：**https://github.com/paxxie2/b5-off-site-pnl/issues/15**（`#15`，标题 `[B5] previous-window-order`，**无任何 label**，comments=0）。
- body = `@paxxie2 ` + `issue.md` 逐字节（UNIX 换行为原文件内容）＝**666 bytes，sha256 `a54c17e945e6543ea40170c8bbc766c6dfba1571216f896db0d292fce356ed15`**；与本地提交 body 完全一致（`submitted_body_sha256` == `stored_body_sha256`）。
- 对照 native 侧（只读既有真实投递）：**https://github.com/paxxie2/b5-native-site-pnl/issues/2**（label `hephi/delivery`），body = `@paxxie2 ` + `issue.md` + **670 bytes 的 `hephi-task` 处理组合同块**，共 1336 bytes，sha256 `47eb70026a0cd4fa8f6ce1a65980d21385059e94586ff14ffdbf1c2bda02b772`；**其任务卡部分（657 bytes）sha256 与 canonical 相同**。
- **未采用 §4.3 B（固定 Trigger 评论）的原因（事实依据）**：本宿主的 `dsh-superagent` 对 **self-authored 评论永远不接收**（`/Users/zm/dsh-instances/experiment/superagent/src/sources/github.ts`：comments 流 `if (sameName(item.user.login, login)) continue`；`allowSelfAuthoredIssues` 只对“正文显式 @ 智能体的新 Issue”生效），而本机唯一可写私有仓库的账号就是 agent 自己（paxxie2）；B5 试跑已记录 reviewer 账号（monsterhunterw2）对私有仓库 HTTP 404、无法代发（`eval/B5-off-entry.md` §3）。因此固定 Trigger 评论无法由可用账号触发，按 `eval/RUNBOOK.md` §4.3 **默认/首选的 A 方案**投递，`deliveryMechanism=issue-body`。
- 组别痕迹扫描：对 off body 做 regex `(对照组|实验组|赫菲|hephi|\[off\]|\[native\])`（忽略大小写）→ **0 命中**；Issue 标题 `[B5] previous-window-order` 为中性批次标记，不含组别/赫菲字样。

## 3. off 侧真实接收证据（实例侧）

- Trigger `e14fae7ac6141be7354aef089c602228`：`at=2026-11-08T16:06:07Z`，`actor=paxxie2`，`addressed=mention`；trigger text 以 `[B5] previous-window-order` 标题开头，随后为 `@paxxie2 # previous-window-order …` 全文（见 `off-trigger.json`）。
- Decision `5720be34cfa990ec9989ce77ee5ae449`：`kind=accept`，`reason=[{code:"explicitRouted"}]`，`strength=explicit`，`threadKey=github:15`。
- Ticket `7dfffe7ab3d6b2aaf7404bbbbea833e2`：`createdAt=16:06:48.193Z`，assignment `startedAt=16:07:09.794Z`；Worker 于停实例前已 `report.state=ready`，创建 **PR #16**（`https://github.com/paxxie2/b5-off-site-pnl/pull/16`，branch `agent/previous-window-order-7dfffe7ab3d6`，base `main`，head `0ec55f8b63bc507fcda0a86c53c51f4dc2b3dbdc`，state=open，**merged=false**）。
- 实例在 Worker 完成（person/review）后按任务要求立即停止（16:11:25Z），未等待人工合并。

## 4. D-9 一致性判定（全部真实验证，原始输出在本目录）

| # | 检查 | 方法与证据 | 结果 |
| --- | --- | --- | --- |
| 1 | canonical 任务卡 sha256 | `canonical-issue-md.sha256`：`f91d1b6a…d3497`，657B | PASS |
| 2 | native 组任务卡部分 sha256 | `native-issue-2.json` → body 前缀切片（`d9-comparison.json`） | PASS（`f91d1b6a…`） |
| 3 | off 组任务卡部分 sha256 | `off-issue-15.json` → body 前缀切片 | PASS（`f91d1b6a…`） |
| 4 | **taskCard.sha256 相同 / verifiedEqual** | 1–3 相等；`d9-comparison.json.verifiedEqual=true` | **PASS** |
| 5 | off Issue 无 `hephi/delivery` | `#15.labels=[]` | PASS |
| 6 | off 无赫菲合同 | `state/hephi` 不存在；`activation.json` 计数=0 | PASS |
| 7 | off 无检查记录 | `checks` 目录计数=0 | PASS |
| 8 | off 无赫菲决策日志 | `decisions.jsonl` 计数=0 | PASS |
| 9 | hephi 目录数不变 | 投递前 0 → 停止后 0（`state/hephi` 始终不存在） | PASS |
| 10 | off 未挂载赫菲 | profile bundles 仅 3 个（无 hephi）；worker 注入 env 仅 `DSH_SUPERAGENT_*`，`HEPHI_*`=[]；`host.log` 中 hephi 提及=0；DSH_HOME 下无 hephi 产物（仅 2 个由实例路径 `/tmp/hephi-off-b5/…` 派生的 session 目录名，见 `isolation-snapshot.txt`） | PASS |
| 11 | 任务卡/注入文本无组别痕迹 | regex 扫描 off body → 0 命中 | PASS |
| 12 | 注入评论唯一 | Issue `#15` comments=0；body 本身即任务卡（机制 A，无额外指令评论） | PASS |

> 注意：off 侧**确实生成 1 个 Super Agent 原生 ticket**（`7dfff…`）——这是 off 组“原生 Issue→Ticket→Worker”路径的**预期产物**（与 B5 试跑同口径），不是赫菲合同/检查/Ticket。off 侧赫菲产物为零。

## 5. 停止与残留检查（硬要求）

- `stop-off.sh` 于 `16:11:25Z` 终止 pid `33806`；`ps -p 33806` 无输出（进程不存在）；`lsof -nP -iTCP:3093 -sTCP:LISTEN` 空；`ps aux | grep 'profile b5off'` 无残留；端口 3093 listen 计数=0。
- 对照宿主未受影响：3083 pid `51558` 存活且监听；3082（daily）pid `96013` 存活且监听（`ps-audit.txt`）。
- 临时凭据 `.credentials.yaml`（0600，仅 `deepseek-account-platform/device`、`.../default` 两条记录，`refs` 清空）在证据复制后删除；整个 `/tmp/hephi-off-b5` 随后删除（`cleanup-audit.txt`）。
- 证据/日志中**无任何凭据值**：`host.log` 的本机 web token 已替换为 `<redacted>`（`host.log.redacted`）；未导出 credentials 内容。

## 6. 与 B5 试跑的关系

- 复用 B5 存档的 profile 结构、prepare-off.sh 语义与 settings 形态；任务卡未变，因此 off body 哈希与 B5 off run1 完全一致（`a54c17e9…`）。
- base 同为 `1e166fb`；off 仓库（`b5-off-site-pnl`）≠ native 仓库（`b5-native-site-pnl`），B5 已记录的**弱配对**限制不因本次校验改变；D-9 只校验任务卡投递一致性，不改变配对性结论。

## 7. GitHub API 调用清单（共 4 次，均在窗口内，单数级）

1. `GET repos/paxxie2/b5-native-site-pnl/issues/2`（native 卡只读对照）
2. `POST repos/paxxie2/b5-off-site-pnl/issues`（创建 off Issue #15）
3. `GET repos/paxxie2/b5-off-site-pnl/issues/15`（校验存储 body/labels/state）
4. `GET repos/paxxie2/b5-off-site-pnl/pulls/16`（确认 PR open、merged=false）

未访问 3082/3083 的 API；未新建 native Issue（避免触发宿主 B 的 ticket/Worker）；未合并 PR。

## 8. 复现命令

```sh
# 0) 任务卡哈希
shasum -a 256 eval/tasks/site-pnl-diagnosis/previous-window-order/issue.md
#    -> f91d1b6a…d3497  657
# 1) native 对照（1 次 API）
gh-agent api repos/paxxie2/b5-native-site-pnl/issues/2 --jq .body > native-body.json
# 2) off 投递（1 次 API；body = "@paxxie2 " + issue.md，666 bytes）
gh-agent api -X POST repos/paxxie2/b5-off-site-pnl/issues --input off-issue-create-payload.json
# 3) off 实例接收（本地 API）
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3093/orchestrator/api/tickets
# 4) 停止并检查
/tmp/hephi-off-b5/stop-off.sh
lsof -nP -iTCP:3093 -sTCP:LISTEN ; ps -p <pid>
```

## 9. 产物与清理

- 本目录：`d9-consistency-20261108T1605Z.md`（本文件）、`d9-comparison.json`、`canonical-issue-md.sha256`、`native-issue-2*.json/txt`、`off-issue-15*.json/txt`、`off-issue-body.md`、`off-issue-create-payload.json`、`off-trigger.json`、`off-decision.json`、`off-disposition.json`、`off-threads.json`、`off-ticket*.json`、`pr-16*.json`、`no-hephi.txt`、`isolation-snapshot.txt`、`ps-audit.txt`、`cleanup-audit.txt`、`timeline.log`、`host.log.redacted`、`settings-*.json`；`SHA256SUMS` 覆盖本目录文件。
- 清理审计（`cleanup-audit.txt`）：credentials 已删；`/tmp/hephi-off-b5` 已删；port3093 listen=0；b5off 进程=0；宿主 3083/3082 仍存活。
- 未 commit（按纪律）；仓库仅新增本目录（untracked），未改 `eval/tasks/`、未改实例目录、未动 3082/3083。

## 10. 限制与未验证

1. **native 对照是既有真实投递（B5 trial #2）的只读读取**，未在本次窗口新建 native Issue（否则会触发 3083 宿主 B 的 ticket/Worker，违反“不动 3083”）；因此本次不是“同批次新投递”的 native/off 对照，但 `taskCard.sha256` 一致性判定成立。
2. off Issue 标题 `[B5] previous-window-order`（中性）与 native #2 标题 `[native][B5-native] previous-window-order run1` 不同；**标题不属于 taskCard 哈希**（RUNBOOK §4.1 只定义任务卡为 `issue.md` 逐字节内容）。若正式实验要求标题也逐字节一致，需要另行规定。
3. 机制 B 未执行（原因见 §2）；本次 `deliveryMechanism=issue-body`（RUNBOOK §4.3 A）。正式 B5 若坚持 B，需要第二个可写账号或宿主支持非 self-authored Issue。
4. off Worker 在停实例前已完成并创建 PR #16（open，**未合并**、未评审）；本任务不涉及合并。
5. 本文件只是 **D-9 投递一致性校验证据**，不是 B5 效果/收益结论；正式运行记录仍按 `eval/schema/run.schema.json` 与 PREREG 口径另行录入。
