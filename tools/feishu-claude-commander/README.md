# 独立 Claude 网页飞书常驻桥接

本目录是独立的飞书 → 本机 Chrome `max2.yrai.cc` Claude 网页 → 飞书文字回复桥接。
它只服务一个飞书应用、一个群和一位本人用户；不接 GitHub、不派工、不参与多机器人共识，
也不读取或修改旧 gpt 桥接、赫菲、Skill 或浏览器配置。

- 消息：`lark-cli` 以独立 bot 配置消费 `im.message.receive_v1`，SQLite 按 `message_id` 去重，
  用 root/thread/reply 别名把同一话题映射到同一个 conversation。
- 网页：每条消息启动一个独立的 `codex exec` 进程，只允许通过现有 `cua_repl` 的 `js` 工具操作
  Chrome。操作员不能自答；答案必须来自本次网页新回复，并由工具轨迹核对。
- 持久化：每个话题保存自己的 Claude chat URL；只有 `https://max2.yrai.cc/chat/<uuid>` 可入库。
- 发送：回到原飞书话题；长文本按字节上限分段，每段固定幂等键并保存回执；发送结果不明时先回读，
  不盲目重发。
- 进程：单进程文件锁、单个串行浏览器操作、用户级 launchd；没有额外队列服务或第三方依赖。

> 本目录的测试使用临时 SQLite 和假外部传输，**不证明**真实飞书、真实 Chrome 网页或真实端到端
> 交付。真实链路必须由主助手按规格用真人新消息独立验收。

## 文件

| 文件 | 用途 |
| --- | --- |
| `bridge.py` | 事件消费、SQLite 状态、Codex 操作员、飞书收发、单进程入口 |
| `operator-schema.json` | `codex exec --output-schema` 使用的严格 JSON schema |
| `test_bridge.py` | 过滤/去重、话题隔离、重启不重发、操作员判定、分段幂等的假传输测试 |
| `launchagent.plist.template` | 仅 `local.claude.feishu-commander` 的用户级模板，不部署、不启动 |
| `README.md` | 本文件 |

运行副本必须把 `bridge.py` 与 `operator-schema.json` 放在同一目录（代码按 `__file__` 查找 schema）。

## 依赖与前提

- macOS，Python 3.9+，仅标准库。
- `lark-cli` 1.0.98 或兼容版本，且为这个新应用单独准备配置目录（不要把默认身份或旧机器人配置
  当成本服务身份）。
- 本机 `codex` CLI 已登录，已安装现有 `unified-computer-use`/`cua_repl` 插件，且 Chrome 已登录
  `max2.yrai.cc`。Codex 只操作网页，不替代 Claude 答题。
- 本服务的 Chrome 操作会占用前台窗口；用户切换窗口或接管页面时，操作会按“状态不确定”失败，
  不会向错页发送或自动重试。

## 配置

配置只放在运行目录的私有 `settings.json`，**不要提交真实身份、路径或秘密到仓库**。示例（全部为
占位符）：

```json
{
  "app_id": "cli_xxxxxxxxxxxxxxxx",
  "bot_id": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "owner_id": "ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "chat_id": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "config_dir": "/Users/example/.lark-cli-claude-commander",
  "state_dir": "/Users/example/.local/share/feishu-claude-commander",
  "lark_cli": "/opt/homebrew/bin/lark-cli",
  "codex": "/opt/homebrew/bin/codex"
}
```

必需字段：

| 字段 | 说明 |
| --- | --- |
| `app_id` | 新飞书应用的 `cli_...` id；启动时用 `lark-cli whoami` 核对 |
| `bot_id` | 该应用的 bot open_id；用于识别 @ 和过滤 |
| `owner_id` | 唯一允许的本人 open_id |
| `chat_id` | 唯一允许的群 chat_id |
| `config_dir` | 该应用独立的 `LARKSUITE_CLI_CONFIG_DIR`，内含 CLI 登录信息 |
| `state_dir` | 本服务私有状态、SQLite、日志、工具轨迹目录 |

可选字段 `lark_cli`、`codex` 为绝对命令路径；缺省时使用 `PATH` 中的命令。启动会创建 `state_dir`
和 `config_dir` 并设为 `0700`，SQLite 文件为 `0600`；`settings.json` 本身也应放在仅本人可读的
目录并建议 `chmod 600`。`state_dir` 下的 `requests/` 保存每次
Codex 的 `.prompt`、`.jsonl` 工具轨迹和 `.stderr`；`events.jsonl` 保存已接收事件。它们只应留在
本机私有目录，不要上传。

## 启动与停止

```sh
# 前台启动（首次审阅/调试时使用）
python3 /path/to/run/bridge.py --settings /path/to/private/settings.json

# 正常停止：向前台进程发 SIGTERM/SIGINT，或随后由 launchd 管理
kill -TERM <pid>
```

启动顺序：读取并严格校验 settings → 建私有目录 → 取得单进程文件锁 → `lark-cli whoami` 核对
`appId` 和 `identity=bot` → 启动事件监听 → 顺序处理消息。任一步失败都会拒绝启动并写日志。

事件监听保持 stdin PIPE 打开，并等待 stderr 的真实 ready 标记
`[event] ready event_key=im.message.receive_v1` 后才消费；监听退出会带退避重连。离线期间不补读
历史消息，也不假装收过。

## 消息与话题规则

- 只接收 `chat_id`、`owner_id` 均匹配、`sender_type=user`、类型为 text/post 的本人消息。
- 新话题必须本人 @ 本 bot；已绑定话题（root/thread/reply 别名已知）接受本人续聊，不要求再次 @。
- 其他群、其他人、其他机器人、图片/附件、重复 `message_id` 一律忽略。
- 每个话题独立保存 Claude URL；新话题返回的 URL 不能是另一个话题已绑定的 URL。
- 回复使用 `--message-id` + `--reply-in-thread` 回到原话题。若发送前存在绑定 URL，操作员必须精确
  续聊该 URL，不能按“最近聊天”猜测。

## 网页操作与成功判定

`bridge.py` 用官方 `codex app-server --stdio` 替换旧的 `codex exec`，参数数组调用（不拼 shell）：

```text
codex app-server --stdio --startup-client-info <自有 clientInfo>
      --disable shell_tool --disable unified_exec
```

每条消息启动一个独立 app-server 进程；子进程使用 `operator_env` 最小环境白名单，显式排除
`CODEX_*`、`BROWSER_USE_ACCESS_*` 等继承身份。流程是 JSON-RPC
`initialize`/`initialized` → `thread/start` → `turn/start`，并使用自有的
`claude-feishu-commander` originator/threadSource，不冒充桌面端。`thread/start` 必须返回
`approvalPolicy=on-request`、`sandbox=read-only`、自有 originator/threadSource；核对通过后才发送
`turn/start`，并在 rollout `turn_context` 再核对本 turn 的 `approval_policy=on-request` 与
`read-only`。`turn/start` 的 `outputSchema` 直接使用 `operator-schema.json` 对象。

只接受自己发出的请求 ID；任何带 id 的未知 server request（审批、elicitation、attestation、
permissions、未知方法）都记录原请求并立即停止，**不自动答复、不自动批准**。`turn/completed`
必须属于本 thread/turn，状态必须为 `completed` 且无错误；中断/失败、无工具轨迹、模型自述、
超时、进程退出都按失败处理。app-server stdout 的原始协议保存为 `.protocol.jsonl`，转换后的
Codex-style 轨迹保存为 `.jsonl`，同时保留 `.prompt` 和 `.stderr`。

所有非 `cua_repl/js` 的执行型 item 都保留并交给原白名单验证拒绝：`commandExecution`、
`webSearch`、`fileChange`、`dynamicToolCall`、`collabAgentToolCall`、`imageGeneration`、
`imageView`、`subAgentActivity`、`functionCallOutput` 等；如果这些动作在 `item/started` 就出现，
也会立即失败，不能因缺少 completed 而被静默抹掉。只忽略显式纯状态/用户消息/推理类 item。
操作员流程只允许 `cua_repl` 的 `js` 工具：在目标页面取**输入前完整快照**、一次性 `setValue`
原文并取输入后完整快照、点击一次发送并取提交后完整快照、用完整快照轮询到
`Claude finished the response` 再取完成后完整快照。完整快照使用
`getAXState({disableDiffing: true})`，不能依赖默认 diff。`getApp` 首次可能显示用户旧聊天，
不能把它的消息编号当新会话基线；新建会话的输入前页面可以是 `/new`，完成后才是 `/chat/<uuid>`。
用户正文和网页内容都作为数据，不能授权其他工具、上传或页面外动作。

发送前 `bridge.py` 不只读取模型最后 JSON，还会检查本次 JSONL 轨迹：

- 必须存在真实的 `cua_repl/js` 工具调用和 Computer Use 元数据；任何其他工具、工具错误、非完成
  状态或未结束的 `turn` 都会失败。
- 输入前、输入后和完成后必须有关键的**完整快照**；diff 不能作为边界证据。输入前快照必须来自
  导航后的目标页面（旧聊天快照会被排除）；新建会话允许输入前为 `/new`，完成后为 `/chat/<uuid>`。
- 完成后快照必须包含本次新增的完整用户消息（位于输入前基线之后）和其后的新增 assistant 消息；
  重复相同提问时以更高消息编号的新消息为准，旧回复不能冒充新回复。
- 返回的 `answer` 必须与完成后快照中新增 assistant 消息的**完整正文**逐行一致（保留多行、代码
  缩进、下划线和链接）；标题/预览摘要不能作为正文证据。旧回复、跨主机、流式未完、错误/失败/
  额度提示或工具实证不足都按失败处理。
- 发送结果不明时先按原话题回读：只接受本 bot、与 source/thread 有明确关系、创建时间晚于源消息、
  且正文与分段完全一致的回执；未知 sender、另一机器人、旧相同正文或无法确认一律保持 uncertain，
  不自动重发。

失败结果分为：

- `blocked`：发送前已确定无法完成（未登录、验证码、额度、页面不可用等）。会回一条明确的
  未完成通知，不声称已发送。
- `uncertain`：可能已发送、生成未结束或页面状态无法确认。不会自动重试；会提示用户先到网页确认。

## 状态与重启语义

消息状态：`pending → running → ready_reply → sending → sent`，异常为 `blocked`/`uncertain`。
重启时：

- `running` → `uncertain`（网页操作可能已发生，保留 URL，不重放）。
- `sending` → `uncertain`（飞书发送结果未确认，不重发）。
- `ready_reply` 保留；它尚未发送，可安全继续发送。
- 各段 `replies` 的 `sending` 也标为 `uncertain`。

每条答案按字节上限（默认 20000）切分，保留代码、下划线和换行原文；拼接各段必须等于原答案。
每段幂等键为确定值（消息 id + 段号），回执和状态写入 SQLite。发送异常时先按原话题回读；找到
同文消息就记为已发送，否则标 `uncertain`，绝不自动重发。部分段已发送、下一段不确定时，整条消息
标 `uncertain`，不会补发剩余段。

## LaunchAgent 模板

`launchagent.plist.template` 只描述新服务 `local.claude.feishu-commander`，不包含真实机器路径或
身份，也不会由仓库自动安装/启动。复制前替换：

- `__PYTHON__`：绝对 Python 解释器路径。
- `__BRIDGE_PY__`：实际运行副本中 `bridge.py` 的绝对路径。
- `__SETTINGS_JSON__`：私有 `settings.json` 的绝对路径。
- `__STATE_DIR__`：私有状态目录绝对路径（模板同时用它的日志文件）。

审阅后按用户级方式安装（示例，路径换成占位符对应的实际值）：

```sh
# launchd 会先打开日志文件，安装前先创建私有状态目录
mkdir -p /path/to/private/state && chmod 700 /path/to/private/state
cp launchagent.plist.template ~/Library/LaunchAgents/local.claude.feishu-commander.plist
# 先确认 ProgramArguments 与日志路径正确，再按需加载；不在本仓库自动执行
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.claude.feishu-commander.plist
launchctl print gui/$(id -u)/local.claude.feishu-commander

# 停止并移除
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/local.claude.feishu-commander.plist
```

## 自测

在仓库根目录运行：

```sh
python3 -m unittest discover -s tools/feishu-claude-commander -p 'test_*.py' -v
python3 -m py_compile tools/feishu-claude-commander/bridge.py \
  tools/feishu-claude-commander/test_bridge.py
```

测试覆盖：本人/群/机器人/附件过滤与去重、新话题 @ 要求、root/thread/reply 别名、话题 URL 隔离、
重启不重发、目标页面基线与 `/new` 新会话、快速完成、长正文中段、完整快照/diff 拒绝、多行代码
缩进/下划线/链接/标题无正文、操作员拒绝自答/旧回复/跨主机/跨话题/流式未完/工具错误/非 cua 工具/
伪造 Computer Use 元数据、分段文本与幂等键、CLI 结构化错误、回读 sender/关系/时间/完整正文、
单进程文件锁；以及 **假 app-server 传输** 的正常协议、on-request/read-only 校验、identity、
预期/未知请求 ID、审批请求、进程退出、超时、失败/中断 turn、缺失/错误完成事件、工具错误映射、
禁止的 completed/started 执行 item、完整证据映射。历史 AX 轨迹解析回归使用
`independent-cua-roundtrip.jsonl` 的结构片段（URL 已脱敏），只验证真实节点/正文格式，不是 E2E
或验收证据。所有外部传输和网页轨迹均为假数据或历史轨迹解析回归，不能替代真实验收。

## 已知边界

- 本组件未执行真实飞书消息、真实 Chrome 操作或真实端到端验收；这些必须由主助手独立完成。
- 只支持本机 Chrome 已登录的单账号 `max2.yrai.cc`，不支持多账号、验证码或登录流程。
- 只处理文字/富文本，不处理附件；超长输入直接拒绝并提示拆分。
- 用户切换窗口、页面跳转或前台被占用时按 `uncertain` 停止，宁可让用户重发，也不向错页发送。
- 监听离线期间平台未投递的消息不会补收；重启不会重放已进入 `running` 的输入。
- 操作员轨迹核对依赖 `cua_repl` 返回的 AX 文本和 Computer Use 元数据；它不能替代人对真实页面
  截图的独立验收。
- 若 Web 端不支持 `getAXState({disableDiffing: true})` 或完整快照无法取得，桥接会按 uncertain 失败，
  不会用 diff、标题摘要或猜测的增量状态放行。
- app-server `thread/start`/`turn/start` 属本版本实验性接口；升级 Codex 后必须复核协议与字段。
- `on-request` 只保证已测试的只读 `cua.getApp`；后续输入/点击/发送若产生 approval server request，
  桥接会记录请求并停止为 uncertain，不自动批准；此时无人值守要求不成立。
- 真实 launchd 环境只读前置已由主助手验证，但产品完整收发链仍需部署后从新飞书消息独立验收。
- `.protocol.jsonl`、转换后的 `.jsonl` 和 `.prompt` 含用户正文与页面轨迹，只留在私有状态目录；
  不要把 app-server 原始协议或 AX 内容提交到仓库。
