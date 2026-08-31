# ARCHITECTURE

The shape of this system and where its decisions live. The block below
INDEXES the ADR log (`adr_dir`); `decisions: inline` is refused — the log owns them.
PROBE (tier: probe, E7): `contracts validate --type architecture-contract` judges it.

```yaml architecture-contract
version: "0.1"
style: library
adr_dir: docs/adr
decisions: adr
```
