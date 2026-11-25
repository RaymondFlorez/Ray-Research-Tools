# Prompt completion review

For any prompt before setting `done`.

- [ ] Completion report exists and lists real command output, not paraphrase.
- [ ] Every acceptance criterion marked met has evidence.
- [ ] Only listed files changed (diff checked), or extras are justified in the report.
- [ ] No new dependency beyond those named in the prompt.
- [ ] No test deleted, skipped, xfailed or loosened.
- [ ] `make check` green in CI on the commit.
- [ ] New public scientific functions have docstrings with formula, units, concept id, citation, doctest.
- [ ] Registry entries added and `make registry` passes.
- [ ] Scientific assumptions introduced or changed are listed and acceptable.
