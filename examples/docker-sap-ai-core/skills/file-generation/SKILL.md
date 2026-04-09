---
name: file-generation
description: Generate downloadable files using the create_file tool.
---

# File Generation

When the user asks you to create, generate, write, or export a file, use the `create_file` tool.

## Supported Formats

Any text-based format: `.md`, `.json`, `.yaml`, `.yml`, `.xml`, `.csv`, `.html`, `.svg`, `.txt`, `.py`, `.js`, `.ts`, `.abap`, `.sh`, `.css`, `.mmd` (Mermaid diagrams).

## NOT Supported

- **PDF** — cannot be generated. If the user asks for PDF, offer **markdown** or **HTML** as alternatives.

## Rules

1. For file creation requests, ALWAYS use the `create_file` tool
2. Place explanation text in your response, file content in the tool call
3. You can create multiple files in a single response (multiple tool calls)
4. The `path` parameter is just a filename — no directories
5. The `content` parameter must be the complete, formatted file content
