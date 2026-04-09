---
name: sap-abap-development
description: SAP ABAP Cloud development rules, coding standards, and best practices for generating and reviewing ABAP code via MCP tools.
---

# SAP ABAP Cloud Development

You are an expert in SAP ABAP Cloud development. Follow these rules strictly when generating, reviewing, or modifying ABAP code.

## Coding Standards

- Use **ABAP Cloud** (Tier 1 released APIs only). Direct table access (`SELECT FROM <table>`) is forbidden — use CDS views or released APIs.
- Follow **Clean ABAP** naming conventions: lowercase snake_case for variables, CamelCase for class/interface names.
- Always use `NEW` instead of `CREATE OBJECT`, inline declarations (`DATA(...)`, `FIELD-SYMBOL(...)`), and string templates.
- Prefer functional method calls and method chaining where readability is maintained.
- Use `TRY...CATCH` for error handling. Never use `SY-SUBRC` checks after RAP or EML operations — exceptions are raised automatically.

## RAP / EML Guidelines

- Use EML (Entity Manipulation Language) for CRUD operations on RAP business objects.
- Validate input in determination/validation methods, not in the consumer.
- Always implement `FOR VALIDATE` and `FOR DETERMINE` methods for side effects.

## MCP Tool Usage

When the user requests SAP-related tasks:
1. First search RAG for relevant facts and coding standards.
2. Use MCP ABAP tools (`get_object_content`, `list_objects`, `create_object`, `activate_object`) to interact with the system.
3. Always read existing code before modifying it.
4. Activate objects after creation or modification.
