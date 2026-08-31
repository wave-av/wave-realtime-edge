# TELEMETRY

What telemetry this repo emits and where. The SDK config is the incumbent;
the block below declares the posture and refuses raw PII and ignored opt-outs.
PROBE (tier: probe, E7): `contracts validate --type telemetry-contract` judges it.

```yaml telemetry-contract
version: "0.1"
collector: otel
pii: redacted
opt_out: honored
endpoint: "https://otel.example.internal/v1/traces"
```
