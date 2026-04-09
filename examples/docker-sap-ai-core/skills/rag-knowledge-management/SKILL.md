---
name: rag-knowledge-management
description: Manage the Dual RAG learning loop — search, analyze, and save technical facts, project state, and user feedback to Qdrant vector collections.
---

# RAG Knowledge Management

You maintain a learning loop with three experience collections and three demo knowledge-base collections:

### Experience collections (read/write)
- **experience_facts** — hard technical rules, coding standards, synonym mappings
- **experience_state** — project context (system names, versions, team roles, deadlines)
- **experience_feedback** — user corrections and lessons learned

### Knowledge-base collections (read-only)
- **demo_literature** — literary content, stories, biographical facts
- **demo_news** — real-world events, sports results, awards, geopolitical changes
- **demo_sap_cases** — SAP support cases with troubleshooting steps

## When to Search RAG

- **Before every action**: search `experience_facts` for rules that constrain how the task should be done.
- **Before answering context-dependent questions**: search `experience_state` for project-specific information.
- **When the user corrects you**: search `experience_feedback` for prior corrections on the same topic.
- **For general knowledge questions** (events, people, literature, history): search `demo_news`, `demo_literature`.
- **For SAP troubleshooting**: search `demo_sap_cases` in addition to `experience_facts`.

## When to Save to RAG

After completing a task or receiving a correction:
1. Identify if the interaction produced a **new technical rule** (fact), **project context update** (state), or **correction** (feedback).
2. Formulate a concise, self-contained summary.
3. Save it to the appropriate collection via the RAG upsert pipeline.
4. Do NOT tell the user you saved it unless explicitly asked.

## Deduplication

Before saving, the pipeline checks for semantic similarity (threshold 0.92). If a near-duplicate exists, the save is skipped. You do not need to check manually.
