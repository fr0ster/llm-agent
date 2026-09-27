# @mcp-abap-adt/sap-aicore-auth

## [Unreleased]

New package. `serviceKeyCredential(raw)` turns a raw SAP AI Core service-key JSON string into
`{ credential: IBearerCredential; apiBaseUrl: string }`. The credential runs the OAuth client-
credentials exchange and caches and refreshes its token; `parseServiceKey` is exported for callers
that need the fields. Both moved here from `sap-aicore-embedder`, with their tests, so the two SAP
packages and a composition root share one implementation.

`parseServiceKey`'s errors say "service key is not valid JSON" / "service key is missing required
fields" and name no environment variable: the parser cannot know which variable held the key, so
naming one (it used to say `AICORE_SERVICE_KEY`) misled whoever set another.
