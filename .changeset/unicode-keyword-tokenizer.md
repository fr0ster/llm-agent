---
'@mcp-abap-adt/llm-agent': patch
---

Fix keyword search to tokenize Unicode letters and digits with NFKC normalization. Previously, tokenization was ASCII-only, leaving non-Latin text unsearchable. Remove a single apostrophe between non-apostrophe letters to keep words together, treat consecutive apostrophes as separators, and support Unicode case boundaries in identifiers. Drop one-code-point tokens, including characters outside the BMP, from words and identifier parts.
