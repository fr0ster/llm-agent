---
'@mcp-abap-adt/llm-agent': patch
---

Fix keyword search to tokenize Unicode letters and digits with NFKC normalization. Previously, tokenization was ASCII-only, leaving non-Latin text unsearchable. Keep words containing internal apostrophes together by removing the apostrophes, and support Unicode case boundaries in identifiers.
