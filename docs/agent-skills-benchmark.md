# IdeaHub Project Skills Benchmark

这是项目 skills 的确定性契约对照，不冒充模型能力跑分。baseline 只加载精简后的 `AGENTS.md`，with-skill 额外加载任务命中的 skills，再检查该任务所需规则是否明确进入上下文。

## Summary

- 激活 skills 后契约通过率：100.0%
- 仅全局规则通过率：15.0%
- 常驻规则：175 → 65 行，减少 62.9%
- 行为 eval 提示：14 条
- 确定性对照场景：6 条

| 场景 | 激活 skills | with-skill | global only | 上下文行数（with / baseline） |
|---|---|---:|---:|---:|
| frontend-mobile-async | ideahub-frontend<br>ideahub-ui-qa | 100.0% | 0.0% | 216 / 65 |
| ui-qa-runtime | ideahub-ui-qa | 100.0% | 0.0% | 143 / 65 |
| backend-permission-dto | ideahub-backend | 100.0% | 25.0% | 124 / 65 |
| database-production-migration | ideahub-database | 100.0% | 25.0% | 118 / 65 |
| collector-trust-resource-gates | ideahub-collector | 100.0% | 0.0% | 117 / 65 |
| release-push-vps-handoff | ideahub-release | 100.0% | 40.0% | 131 / 65 |

## Interpretation

拆分后的全局文件只保留始终有效的安全规则。具体任务激活 skill 后会上下文更多，但这些内容与当前任务直接相关，并补齐原全局规则没有覆盖的架构、审美、验收、权限、迁移、Collector 和发布决策。

完整逐项证据见 `docs/agent-skills-benchmark.json`。真实模型 A/B 可直接使用各 skill 的 `evals/evals.json` 扩展，不应把本确定性检查解释成模型质量结论。
