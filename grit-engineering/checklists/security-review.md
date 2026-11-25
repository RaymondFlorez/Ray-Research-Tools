# Security review

For prompts with `review: security`.

- [ ] No eval/exec/pickle/unsafe YAML/shell=True; `torch.load` only with `weights_only=True`.
- [ ] User input validated at the boundary with size limits.
- [ ] File paths: artifacts by hash only; any path normalized against an allowed root.
- [ ] Authorization checked, deny by default; denials audited.
- [ ] Secrets: none in code, configs, logs, tests or errors.
- [ ] New trust boundary crossings documented in docs/security/threat-model.md.
- [ ] Layer rules respected; evaluator independence intact.
- [ ] Tests include at least one negative (attack) case per new boundary.
