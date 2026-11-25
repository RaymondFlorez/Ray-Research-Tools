# Release and deploy (Profile 2+)

- [ ] Tagged commit; CI green including security workflow; SBOM attached.
- [ ] Images built in CI from the tag; digests recorded.
- [ ] Migrations reviewed; backward compatible for one release; down-migration tested.
- [ ] Fresh backup taken and verified before deploy.
- [ ] Deploy per docs/runbooks/deploy.md; health and smoke checks pass.
- [ ] Rollback command prepared (previous tag).
- [ ] Audit chain verification passes after deploy.
- [ ] Deploy recorded in the audit log by a human identity.
