# Post-merge release checklist — v11.0.0

All 12 packages are at version `11.0.0` in their `package.json` files already. No `changeset version` run is needed — the release flow just publishes.

## Pre-release verification

1. `git checkout main && git pull`
2. Confirm each `packages/*/package.json` is at `11.0.0`:
   ```bash
   jq -r '.name + " " + .version' packages/*/package.json | sort
   ```
3. `npm install` and `npm run build` (full clean build).
4. `npm test` — expect the full suite green (~833 tests at merge time).

## Publish

5. `npm run release:publish`
   - Runs `scripts/publish-all.sh` — sequential `npm publish` for all 12 packages in dependency order (core → providers → embedders → RAG backends → server).
   - On the first publish, browser opens for WebAuthn 2FA; tap YubiKey and check "trust this device for 5 minutes" — subsequent publishes in the same run go through without further prompts.
   - Requires `npm login` with publish rights on the `@mcp-abap-adt` scope.
6. `git tag -a v11.0.0 -m "Release 11.0.0"`
7. `git push --tags` — triggers the GitHub release workflow.

## Post-release cleanup (retention policy)

Once npm reports all 12 packages at 11.0.0 and `v11.0.0` tag is pushed:

8. Delete the retention-scoped design artifacts:
   - `docs/superpowers/specs/2026-04-24-v11-hana-pgvector-design.md`
   - `docs/superpowers/specs/2026-04-22-v11-full-extraction-design.md` (if still present)
   - `docs/superpowers/plans/2026-04-23-v11-full-extraction.md` (if still present)
   - `docs/superpowers/plans/2026-04-24-v11-hana-pgvector.md`
   - `POST_MERGE_CHECKLIST-v11.md` (this file)
9. `git commit -m "chore: remove v11 retention artifacts post-release"`
10. `git push`

## Notes

- Do NOT run `npx changeset version` at any point — there are no pending changesets and any bump would move versions away from 11.0.0.
- Peer-dependency version ranges in `packages/llm-agent-server/package.json` were already normalized to `^11.0.0` as part of the v11 final fix commit.
