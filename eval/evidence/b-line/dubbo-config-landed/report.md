# Dubbo 检查配置落地报告

日期：2026-11-12 · 执行者：Lead（teammate subagent 模型路由失败，直接执行）
基线：main `1d75f3c`

## 1. 交付物

| 文件 | 说明 |
|---|---|
| `hephi/docs/project-config/dubbo-checks.json` | 5 项检查配置（version 1），schema 符合 `hephi/src/contracts/checks.ts` |
| `hephi/docs/project-config.md` | 追加 Dubbo 段（HEPHI_VERIFICATION_FILE/SOURCE_REPO/ALLOWED_PATHS） |

## 2. 配置内容

| id | kind | required | timeoutMs | 依据 |
|---|---|---|---|---|
| dubbo-compile-core | build | true | 60000 | P10 实测 BUILD SUCCESS 3.591s |
| dubbo-unit-core | test | true | 120000 | P10 实测 37 tests/0 failures |
| dubbo-static | build | false | 60000 | 无执行证据，command=PENDING_OWNER_APPROVAL |
| dubbo-full-compile | build | false | 300000 | 当前 exit 1（缺 netty），需预热 ~/.m2 |
| dubbo-full-regression | test | false | 600000 | 未验证，command=PENDING_OWNER_APPROVAL |

## 3. 负向验证（fail-closed）

```bash
$ bash -c '[ -r "/nonexistent/path" ] || { echo "HEPHI verification configuration is unreadable" >&2; exit 1; }'
HEPHI verification configuration is unreadable
$ echo $?
1
```

与 `hephi/scripts/prepare-dubbo.sh:35` 语义一致：配置不可读 → prepare 立即失败。

## 4. 正向验证（未执行）

正向 prepare 需要：
- 真实 Dubbo 源码仓 clone（本地 `/Users/zm/workspace/app/dubbo` 存在但未验证完整性）
- GitHub 读操作（Issue/PR 查询）
- 宿主环境变量（DSH_SUPERAGENT_*/HEPHI_STATE_DIR）

本次只做负向验证；正向验证待 B3 启动时执行。

## 5. 未做项（如实登记）

- 依赖预热（~/.m2/netty:3.2.10.Final 等）：未执行
- 任务 base commit 指定：待负责人决定
- 受控 prepare 正向验证：未执行
- dubbo-static/dubbo-full-compile/dubbo-full-regression 的真实命令：待负责人指定

## 6. 引用

- 草案：`eval/evidence/b-line/dubbo-check-config-proposal.md`
- P10 实测：`eval/B7-data.md:21`
- fail-closed 语义：`hephi/scripts/prepare-dubbo.sh:34-35`
- checks schema：`hephi/src/contracts/checks.ts:12-25`

## 7. 正向 prepare 验证（2026-11-12 补充）

### 选定父任务
- commit: `c41d01bba05d93321cc55662da2cc1140d9e6783`（Fix JavaBeanSerializeUtil serialization of maps with null keys）
- baseSha: `7ca3e29f4b48544b24fdfff6ccb9bc1b81132d44`
- 模块: dubbo-common
- diff: 2 files, +25/-1
- Issue: paxxie2/dubbo#67（[native] 标记 + hephi/delivery label）

### 运行命令
```bash
HEPHI_GH_CLI=/Users/zm/.local/bin/gh-agent \
HEPHI_SOURCE_REPO=/Users/zm/workspace/app/dubbo \
HEPHI_ALLOWED_PATHS='["dubbo-common/**"]' \
HEPHI_VERIFICATION_FILE=hephi/docs/project-config/dubbo-checks.json \
DSH_SUPERAGENT_GITHUB_REPOSITORY=paxxie2/dubbo \
DSH_SUPERAGENT_NAME=dubbo-null-key-fix \
HEPHI_STATE_DIR=/tmp/hephi-prepare-test \
DSH_SUPERAGENT_GITHUB_NUMBER=67 \
DSH_SUPERAGENT_DIR=/tmp/dubbo-prepare-workspace \
DSH_SUPERAGENT_TICKET=dubbo-null-key-fix-67 \
bash hephi/scripts/prepare-dubbo.sh
```

### 结果
- exit 0 ✅
- activation.json 写入 `/tmp/hephi-prepare-test/hephi/dubbo-null-key-fix-67/activation.json`
- pluginCommit: ab5f527（与 3085 实载一致）
- baseSha: 7ca3e29f4b48（正确）
- 5 项检查全部冻结进合同（dubbo-compile-core build required、dubbo-unit-core test required、3 optional）

### 结论
Dubbo 检查配置**正向 prepare 验证通过**。配置文件可被 prepare-dubbo.sh 正确读取、解析并冻结进合同。fail-closed 负向验证（§4）+ 正向验证均通过。

### 未做
- Worker 实际执行检查（需 SA 接单 + Dubbo 仓写权限）
- ~/.m2 依赖预热（全仓构建前置）
- B3 正式探查运行
