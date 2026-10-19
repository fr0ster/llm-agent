# @mcp-abap-adt/typesafe-decision

## 30.3.0

Lockstep release with the 30.3.0 line: `IRagScanner.scan`, `IRagFilteredDeleter.deleteWhere` and `IRagCatalogUpdater.updateCollection` on the RAG stores and catalog providers. No change in this package — see the root CHANGELOG.

## 30.2.0

Lockstep release with the 30.2.0 line: an opt-in shared table layout for the SQL vector stores (`hana-vector-rag`, `pg-vector-rag` — one documents table plus the catalog, no runtime DDL, works in a SAP HANA HDI container) and HANA fixes. No change in this package — see the root CHANGELOG.

## 30.1.0

- New package: `TypeSafeDecisionModel`, an `IDecisionModel` over TypeSafe AI's Jev.
