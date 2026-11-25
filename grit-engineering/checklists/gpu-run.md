# GPU run

Before:
- [ ] Experiment AUTHORIZED with nonzero GPU budget by an approver who isn't the author.
- [ ] grit-cost estimate attached; price table dated within 30 days.
- [ ] Image digest and bundle signature verified.
- [ ] Deadline timer installed on the instance (`systemctl list-timers grit-deadline.timer`).
- [ ] No credentials on the instance other than the one-job token and pre-signed URLs.

During:
- [ ] Heartbeats arriving; ledger alerts configured at 50/80/100%.
- [ ] Checkpoints appearing in object storage every 30 min and verifying.

After:
- [ ] Final checkpoint uploaded and verified.
- [ ] Instance terminated: confirmed in the provider console by a human (until 10 clean runs).
- [ ] Ledger GPU-hours vs provider bill within 10%.
- [ ] Run record complete; evaluation requested.
