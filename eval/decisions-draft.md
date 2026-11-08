# B 线决策草案（待负责人批准）

基线：`9fa8598f2beabe179b28733e484275c3775279d3`。本文件记录决策过程；**终态：PREREG v1.0 已于 2026-11-08 锁定**（`eval/PREREG.lock`），全部 D-1..D-10 已决，锁定值以 `eval/PREREG.md` §10 为准。历史过程条目保留下文，其中出现的"待批准/未决"字样仅描述当时状态，均已被 2026-11-08 锁定取代。

## 编号与批准规则

本文件 D-1..D-10 唯一采用 `eval/PREREG.md` §10 编号。`eval/RUNBOOK.md` §11 的局部 D1..D6 编号含义不同，引用时使用章节和事项名称，禁止混用。§13.1 把删除估算写作 PREREG D-6，也应在后续获批同步时纠正为 D-10。

批准人：实验负责人（用户）；执行 Agent 无权代批。批准记录须包含决定、理由、日期、批准人、适用轮次和版本；批准之后按 PREREG §9 更新相应文件。锁定须待试跑后、正式实验前另行完成，本文件本身不是批准记录。

## D-1 非劣效界值

- status: `approved-by-owner`
- 当前状态：PREREG §3 草案 −5pp，未批准。
- 选项：沿用 −5pp；收紧至负责人指定值；按业务损失另定界值。
- 对样本量、成本和可比性的影响：界值越严通常需要更多样本与成本；变更影响跨轮可比性。
- 推荐及依据：保留 −5pp 为候选，待负责人结合试跑确认；来源是现有 §3，不能把候选当已批准。
- 批准人：实验负责人（用户）；2026-11-08 口头批准“乙包的，我全部批准”（Lead 转述），记录见 `eval/approvals/2026-11-08-owner-approval.md`。PREREG 锁定仍须按 PREREG §9 另行完成。
- 批准后需同步：eval/PREREG.md §3/§9；分析命令参数。

## D-2 主指标联合规则

- status: `approved-by-owner`
- 当前状态：PREREG §4 草案至少两项改善且无显著恶化。
- 选项：沿用草案；要求三项均改善；预先指定单一主指标其余辅助。
- 对样本量、成本和可比性的影响：规则改变样本需求与检出能力，不能观察正式结果后择优。
- 推荐及依据：推荐保留现有草案候选，避免本次准备工作改变结论口径；正式选择由负责人批准。
- 批准人：实验负责人（用户）；2026-11-08 口头批准“乙包的，我全部批准”（Lead 转述），记录见 `eval/approvals/2026-11-08-owner-approval.md`。PREREG 锁定仍须按 PREREG §9 另行完成。
- 批准后需同步：eval/PREREG.md §4/§9；eval/stats/report.py（仅确需实现批准规则时）。

## D-3 成本上限

- status: `approved-by-owner (delegated)`
- 当前状态：PREREG §5 七项成本阈值均为占位。
- 选项：整体保留表中候选；按试跑调整各项；按预定仓库/模型分层制定。
- 对样本量、成本和可比性的影响：更严预算可能减少可完成配对；分层上限影响成本比较，须完整披露。
- 推荐及依据：先列出全部七项候选并用开发集试跑估计，不在无数据时签定数值。
- 批准人：实验负责人（用户）；该数值需试跑后另行批准，当前无本项数值批准记录（见 `eval/approvals/2026-11-08-owner-approval.md` §4）。
- 批准后需同步：eval/PREREG.md §5/§9；分析命令配置。
- 草案引用（2026-11-08，未批准）：`eval/B5-sample-size-draft.md` §5 + `eval/evidence/b5ss/`（由 8 次既有试跑的真实记录汇总）。native usage 可得（4/4 run，含 cacheRead 口径与不含 cache 口径两种数值）；**off usage = unknown/null**（off 实例已清理）；**金额 unknown**（无价目/额度，未折算）。时长资源仅为顺序执行估算（假设每组并发 1，并发上限未验证）。**本项 status 仍为 `pending-trial`，不填成本上限数值。**

## D-4 整体和分层样本量

- status: `approved-by-owner (delegated budget)`
- 当前状态：锁定前为草稿；锁定值 = 67 配对（预算口径），见 PREREG §6。
- 选项：试跑后按配对效能估计；预先预算限定可行样本并标证据限制；缩小首轮范围后重新估计。
- 对样本量、成本和可比性的影响：直接决定总成本与统计精度，各分层不能以整体数量替代。
- 推荐及依据：推荐试跑后按现有 §6 方法给出计算输入和输出，再审批 N；不填凭空数字。
- 批准人：实验负责人（用户）；该数值需试跑后另行批准，当前无本项数值批准记录（见 `eval/approvals/2026-11-08-owner-approval.md` §4）。
- 批准后需同步：eval/PREREG.md §6/§9；正式任务清单和分析命令。
- 草案引用（2026-11-08，未批准）：`eval/B5-sample-size-draft.md` §4 + `eval/evidence/b5ss/sample-grid.json`。8 次试跑只有 4 个配对、1 个 discordant 对，**不足以估效应**；按假设情景（改善 5/10/15/20pp × power 0.8/0.9 × α 0.05/0.10 × discordant 0.2/0.3 × margin −3/−5/−10pp）的 paired Wald 非劣效网格，所需配对数范围 **16–313**，主情景（d=10pp、power 0.8、α=0.05、q=0.2、margin −5pp）为 67 对。该网格是规划辅助、不是 PREREG §6 的 McNemar/bootstrap 正式计算。**本项 status 仍为 `pending-trial`，不填 N、不锁 PREREG。**

## D-5 环境不可用停止阈值

- status: `approved-by-owner (delegated)`
- 当前状态：锁定前为待定；锁定值 = 每 10 次失败 >20% 或连败 3 次（PREREG §8.3）。
- 选项：固定批次比例阈值；连续批次阈值；预先规定比例及绝对事件数联合条件。
- 对样本量、成本和可比性的影响：提前停止影响样本量与成本；分组或窗口不一致会破坏可比性。
- 推荐及依据：推荐负责人同时确定阈值、分母和观察窗口，沿用保留失败记录的规则；本次不指定数值。
- 批准人：实验负责人（用户）；尚无本项批准记录。
- 批准后需同步：eval/PREREG.md §8/§9；eval/RUNBOOK.md 停止操作说明。

## D-6 成本硬门槛或辅助

- status: `approved-by-owner`
- 当前状态：PREREG §4/§5 当前按硬门槛写草案。
- 选项：保持硬门槛；仅作辅助；分成必守预算与辅助成本指标。
- 对样本量、成本和可比性的影响：硬门槛可能在效果改善时仍判未达标；辅助口径不能保证预算可承受。
- 推荐及依据：推荐保持硬门槛候选，符合现有联合判定；改口径须负责人事先批准。
- 批准人：实验负责人（用户）；2026-11-08 口头批准“乙包的，我全部批准”（Lead 转述），记录见 `eval/approvals/2026-11-08-owner-approval.md`。PREREG 锁定仍须按 PREREG §9 另行完成。
- 批准后需同步：eval/PREREG.md §4/§5/§9；报告判定实现（如批准规则变化）。

## D-7 首轮仓库与模型范围

- status: `approved-by-owner`
- 当前状态：PREREG §10 未定，RUNBOOK §2 先做 Q1 off/native。
- 选项：一个仓库一个模型；一个仓库多个模型；多仓库分层。
- 对样本量、成本和可比性的影响：范围越大配对需求和费用越高；跨仓库结论不能由单仓库外推。
- 推荐及依据：推荐首轮单仓库单模型，完成后另行决定 B7；具体名称仍待负责人选择。
- 负责人选择（2026-11-08）：首轮开发试跑 = `hephi` + `site-pnl-diagnosis` × `deepseek-flash`（off/native 两组）；核心配对任务 = `previous-window-order`（site-pnl，配对仓库 `paxxie2/b5-native-site-pnl`），hephi 任务只作工具/流程验证；B7 多仓库/多模型正式范围另行决定。
- 批准人：实验负责人（用户）；2026-11-08 B5 试跑授权（Lead 转述），记录见 `eval/approvals/2026-11-08-b5-trial-authorization.md`。仅覆盖本轮开发试跑，正式实验前仍须随 PREREG 锁定。
- 批准后需同步：eval/PREREG.md 范围及§6/§9；eval/RUNBOOK.md；任务清单。

## D-8 P4 shadow 可用性

- status: `approved-by-owner (delegated)`
- 当前状态：RUNBOOK §1/§3 只有机制说明，实际宿主可用性未验证。
- 选项：具备真实证据后选 shadow；使用 normal 并披露限制；延后实验待能力确认。
- 对样本量、成本和可比性的影响：执行模式影响成本与可比性；不能预设 shadow 已激活。
- 推荐及依据：推荐维持未验证状态；若正式选择 normal 必须披露差异，真实能力核验不属于本次。
- 批准人：实验负责人（用户）；尚无本项批准记录。
- 批准后需同步：eval/PREREG.md §10；eval/RUNBOOK.md §1/§3；正式运行记录 executionMode。

## D-9 off 任务卡投递

- status: `approved-by-owner`
- 当前状态：RUNBOOK §4 固定 Trigger 文本注入是待批准方案。
- 选项：批准现有固定注入模板；选择已验证原生投递入口；能力不足则暂缓正式实验。
- 对样本量、成本和可比性的影响：额外 off 专属指令会混淆分组；任务卡字节和 sha256 必须一致。
- 推荐及依据：推荐现有固定模板作为候选，批准后真实检查两组 sha256；禁止本次调整宿主或运行时。
- 负责人选择（2026-11-08）：off 组使用独立 off profile 实例（本地端口 3093，不挂载赫菲、不打 `hephi/delivery`）投递同一任务卡；native 组在宿主执行。
- 批准人：实验负责人（用户）；2026-11-08 B5 试跑授权（Lead 转述），记录见 `eval/approvals/2026-11-08-b5-trial-authorization.md`。方案选择已批准，但投递一致性（两组 sha256、off 无赫菲状态）仍需真实校验，正式实验前随 PREREG 锁定。
- 批准后需同步：eval/PREREG.md §10；eval/RUNBOOK.md §4；任务卡投递证据。

## D-10 机械指标中的估算字段

- status: `approved-by-owner`
- 当前状态：当前 ab-metrics.mjs 已删除格式化/重命名估算，PREREG §10“未改”为历史滞后。
- 选项：确认现有删除；保留为显式非结论辅助估计；要求人工盲评承接分类。
- 对样本量、成本和可比性的影响：估算混入效果会损害可比性；人工盲评增加成本但可留可核查依据。
- 推荐及依据：推荐确认现有删除，由既有盲评 rubric 承接语义分类；代码已实现不等于负责人批准。
- 批准人：实验负责人（用户）；2026-11-08 口头批准“乙包的，我全部批准”（Lead 转述），记录见 `eval/approvals/2026-11-08-owner-approval.md`。PREREG 锁定仍须按 PREREG §9 另行完成。
- 批准后需同步：eval/PREREG.md §10 状态；eval/RUNBOOK.md §13.1 错引 D-6 应对应此 D-10；若选择保留估算才另行批准代码变更。

## 范围与未完成事项

本次不修改策略、不填写 N/seed/阈值的正式值、不运行真实实验、不修改宿主。

## 2026-11-08 负责人口头批准（更新）

- 负责人原话：“乙包的，我全部批准”（2026-11-08 06:36 Asia/Shanghai，经 Lead 转述；完整范围与边界见 `eval/approvals/2026-11-08-owner-approval.md`）。
- 本文件 status 变更（历史时点记录）：D-1、D-2、D-6、D-10 → `approved-by-owner`；D-3、D-4 → `pending-trial`；D-5、D-8 当时仍未批准——该历史状态已被后续委托代定与 v1.0 锁定全部取代。
- 同日稍后：负责人选择 A（单人+agent）并授权搭 off profile 试跑，D-7、D-9 改为 `approved-by-owner`（仅限本轮开发试跑范围，见 `eval/approvals/2026-11-08-b5-trial-authorization.md`）。
- 2026-11-08 委托 AI 代定参数后：D-3/D-4/D-5/D-8 已有 delegated 决策（见 `eval/approvals/2026-11-08-delegated-b5-parameters.md`）；仍未完成：PREREG §9 锁定、D-9 真实投递一致性校验、D-4 任务池/合格任务数核对、成本 100 元预算与 token 上限的可行性预检、真人评审者为 1 人+agent 降级。
- 本节不改变 `eval/PREREG.md` 的任何数值/占位；PREREG 仍未锁定，`prereg-lock --check` 仍应失败。

D-8/D-9 的真实可用性及任务卡投递仍需实际入口证据；当前真实端到端未验证通过。上述推荐不是实验结论，也不能代替试跑结果。

## 2026-11-08 委托 AI 代定参数（D-3/D-4/D-5/D-8）

负责人要求“另一个模型代替处理”并由该模型推送决策记录（原提交 `fe8c6cb`，其远端分支不可达，本仓库按文件内容恢复并保留引用）。完整记录见 `eval/approvals/2026-11-08-delegated-b5-parameters.md`；要点：

- **D-3**（成本/资源口径，`approved-by-owner (delegated)`）：主 token 指标 = input+output+cacheRead+cacheWrite（去重，另报不含 cache 的 input+output）；native 有效运行 token 中位数上限 1,000,000、P90 上限 2,000,000；耗时中位数 30 分钟/P90 60 分钟、超时率 10%、人工介入中位数 1 次/运行；本轮模型费用总上限 **100 元人民币**；单次 60 分钟或 3,000,000 token 停止；每组并发最多 1。价格/汇率以实际计费为准，未虚构价格。
- **D-4**（规模，`approved-by-owner (delegated budget)`）：固定预算 **67 个不同任务的配对**（每任务 off/native 各一次），随机 13 个任务两组各重复一次，最多 160 runs；**67 是资源预算，不是统计效能验证**；单仓库 site-pnl-diagnosis、单模型 deepseek-flash、seed=20261108；历史 8 次开发试跑不混入新批主分析。
- **D-5**（环境停止，`approved-by-owner (delegated)`）：任一组每 10 次环境失败超过 20%，或连续失败 3 次，暂停。
- **D-8**（P4 shadow，`approved-by-owner (delegated)`）：使用现有 normal 模式，不等 shadow、不新增开发；须在记录中披露差异。

**仍未锁 PREREG**：`eval/PREREG.md` 的数值占位仍需按 §9 同步并锁定；D-9 的真实投递一致性校验、D-4 的“67 对从何而来/实际合格任务数”仍需执行前核对；本轮不启动实验。
