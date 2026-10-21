<!-- External pull requests aren't being sought; see CONTRIBUTING.md. -->

## Summary

## Checks

- [ ] `npx tsc --noEmit` passes
- [ ] `npx jest` passes
- [ ] No real notes, transcripts, recordings or personal data in code, tests or fixtures (synthetic only)
- [ ] No secrets, keystores or credentials added
- [ ] `release-gate.json` still has `productionBlocked: true` and no build-window exception

## Touches a sensitive area?

- [ ] RAG / grounding (Grounding v1 is frozen without a release blocker)
- [ ] Vault, encryption keys or backup format
- [ ] Reminders / notifications
- [ ] Native modules or `patches/` (needs a native build)
- [ ] None of these
