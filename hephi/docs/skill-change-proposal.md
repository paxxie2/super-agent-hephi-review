# 待审批：`hephi-superagent-control` Skill 修改建议

未应用。`skills/hephi-superagent-control/SKILL.md` 保持原始快照 `8e68ec2` 的内容。下面的 diff 只让 Skill 与任务卡行为一致，批准后再应用。

```diff
--- a/hephi/skills/hephi-superagent-control/SKILL.md
+++ b/hephi/skills/hephi-superagent-control/SKILL.md
@@
-5. After integrating and committing the final changes, call `hephi_check(checkId)` for each required check in the frozen `verification.checks` contract.
+5. After integrating and committing the final changes, call `hephi_check(checkId)` for each required check in the frozen `verification.checks` contract and for each check named by a task-card acceptance item (once per check, even if several items name it). Keep changed files inside the acceptance items' `paths`; if an item cannot be met there, report blocked instead of widening the change.
```

理由：任务卡把验收项绑定到项目检查，ready 会要求这些检查的证据；原 Skill 只提到 required 检查，Worker 可能漏跑非 required 的验收检查，直到 ready 才被拒绝。
