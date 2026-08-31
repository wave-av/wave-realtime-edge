# SAFETY

How autonomous actors in this repo are gated. The guardrail config is the
incumbent; auto-approved irreversible ops and no human override are refused.
PROBE (tier: probe, E7): `contracts validate --type safety-contract` judges it.

```yaml safety-contract
version: "0.1"
guardrail: prompt-guard
irreversible_ops: confirm
confidence_floor: 0.85
override: human
```
