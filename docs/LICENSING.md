# Licensing

**The libraries in this monorepo are licensed under the GNU Lesser General Public
License v3.0 only (`LGPL-3.0-only`). The one exception is the binary,
`@mcp-abap-adt/llm-agent-server`, which is `GPL-3.0-only` starting with
v22.0.0.**

Copyright © 2025–2026 Oleksii Kyslytsia

> This page describes what the licence says and how it applies to the ways
> people actually use these packages. It is not legal advice. If your situation
> is unusual — you are relicensing, sublicensing, shipping to an app store, or
> statically bundling — talk to your own counsel.

## The short version

| You are… | Do you have to release your own source? |
|---|---|
| Importing these libraries into your program | **No** |
| Running `llm-agent` as a server and calling it over HTTP | **No** — the GPL has no network trigger |
| Shipping a Docker image that installs these packages from npm | **No** — but ship the notices, see below |
| Loading your own skills at runtime via `skillPlugins:` | **No** — your skills stay yours |
| **Modifying a library** and distributing the result | **Yes**, the modifications go back under the LGPL |
| **Modifying the `llm-agent-server` binary** and distributing it | **Yes**, under the GPL, corresponding source and all |
| Bundling a modified/inlined library copy into a binary with no way to swap it | **Yes**, or restructure so it can be swapped |

The line the LGPL draws is not "did you touch the code" but **"can your users
replace this library with their own build of it."** The GPL on the binary draws a
simpler one: **"did you hand someone a modified server."**

## Which package is under which licence

| Package | Licence | Why |
|---|---|---|
| `llm-agent`, `llm-agent-mcp`, `llm-agent-rag`, `llm-agent-libs`, `llm-agent-server-libs` | `LGPL-3.0-only` | libraries you embed |
| `anthropic-llm`, `deepseek-llm`, `openai-llm`, `ollama-llm`, `sap-aicore-llm` | `LGPL-3.0-only` | libraries you embed |
| `openai-embedder`, `ollama-embedder`, `sap-aicore-embedder` | `LGPL-3.0-only` | libraries you embed |
| `qdrant-rag`, `hana-vector-rag`, `pg-vector-rag` | `LGPL-3.0-only` | libraries you embed |
| **`llm-agent-server`** | **`GPL-3.0-only`** | the ready-to-run product — CLI and HTTP server, no library exports |

`llm-agent-server` declares no importable entry point (`exports` carries only
`./package.json`); it ships `bin/` and `dist/` for the `llm-agent`,
`llm-agent-check` and `claude-via-agent` executables. Because nothing can link
against it, the LGPL's distinguishing permission — link and keep your own code
closed — had nothing to apply to, and the full GPL costs embedders nothing while
asking forks of the product to stay open. Everything you would actually build
on, including the whole SmartServer composition runtime in
`llm-agent-server-libs`, stays LGPL.

`test/repo/licensing.test.ts` enforces this split, including that the GPL
package never grows a library export.

## The licence files in each package

An LGPL package ships **both**:

- `LICENSE` — the GNU Lesser General Public License v3.0
- `GPL-3.0.txt` — the GNU General Public License v3.0

Both are required. The LGPL is not a standalone licence: it is a set of
*additional permissions* layered on top of the GPL, and its own text says so in
its first paragraph. `LICENSE` without the GPL text is an incomplete grant.

The `llm-agent-server` package ships `LICENSE` alone, holding the GPL — the GPL
*is* the standalone licence, so there is nothing to layer it onto.

**Why the base text is not called `COPYING`.** The FSF convention names it
`COPYING`, but GitHub's licence detector scans `LICENSE*` and `COPYING*` alike
and, on finding both, reports the repository under the *stricter* of the two.
Real LGPL projects using the canonical layout are misreported as GPL-3.0 for
exactly this reason. Naming the base text `GPL-3.0.txt` keeps it out of that
namespace, so GitHub resolves this repository as LGPL-3.0 — which is what the
libraries actually are. The licence does not prescribe a filename; it requires
only that the text accompany the work, which it does, in every tarball.

Note that npm packs `LICENSE` automatically but not `GPL-3.0.txt`, so the
`files` entry is what carries the base text into the tarball. The test asserts
it.

## What this is not

**It is not retroactive.** Every version published up to and including
**v20.9.5** was released under MIT and stays MIT under those terms, permanently.
v21.0.0 published every package, `llm-agent-server` included, under
`LGPL-3.0-only`, and that grant stands for v21.0.0 forever. A copyright holder
cannot retract a licence already granted. If you are pinned to either, nothing
about your obligations changed.

**It is not an API break.** Neither v21.0.0 nor v22.0.0 removes an export,
changes a signature, or requires a config migration. The major version is
reserved for the licence precisely because it is the part that requires a
decision.

## Migrating

### From v21.0.0 (everything LGPL) to v22.0.0

Only one thing changed: `@mcp-abap-adt/llm-agent-server` moved from
`LGPL-3.0-only` to `GPL-3.0-only`. Every other package is unchanged.

1. **If you run the server** — as a container, a service, a CLI, behind an HTTP
   endpoint — nothing changes. The GPL has no network trigger, and running a
   program is not distributing it. Your clients, your prompts and your data are
   unaffected.
2. **If you embed the libraries**, nothing changes: they are still LGPL, and
   `llm-agent-server-libs` gives you the entire SmartServer composition without
   touching the GPL package.
3. **If you redistribute a modified `llm-agent-server`**, you now owe recipients
   the corresponding source under the GPL. If that does not work for you, build
   your own binary on `llm-agent-server-libs` — that is what it is for — or pin
   `llm-agent-server` to `21.0.0`, which stays LGPL.

### From the MIT releases (v20.9.5 or earlier)

1. **Decide whether the LGPL works for you at all.** For the overwhelming
   majority of consumers — importing the packages, or running the server and
   talking to it over HTTP — the answer is yes and nothing else on this list
   applies. Read the tables above first.
2. **Upgrade normally.** `npm install @mcp-abap-adt/llm-agent-server@22` (and any
   peers). There is no code change, no config change, no import rewrite.
3. **If you redistribute the packages** — in a Docker image, an installer, a
   bundled artifact — include with your distribution:
   - a notice that your product uses these libraries and that they are covered
     by the LGPL (and the server binary, if you ship it, by the GPL),
   - a copy of the licence texts (they are already inside each package's
     tarball, under `node_modules/@mcp-abap-adt/<pkg>/`),
   - the copyright notice above.
4. **If you modified a library**, publish those modifications under the LGPL, and
   make sure your users can relink or substitute their own build. Contributing
   the change back upstream is the easiest way to satisfy this.
5. **If you cannot accept these terms**, pin to `20.9.5`. It remains MIT forever
   and is not going anywhere. It will not receive further fixes, so treat this as
   a deliberate freeze rather than a long-term plan, and get in touch if you need
   another arrangement.

## Your own content stays yours

**Runtime skills are not derivative works of the engine.** Domain skills loaded
through `skillPlugins:` are fetched at runtime into a separate skills-RAG; the
engine never vendors them, never links them, and ships none of them. They stay
under whatever licence you hold them under. This is by design — it is the same
property that lets the engine remain domain-agnostic (see
[ARCHITECTURE.md](ARCHITECTURE.md#skill-plugin-host-runtime-gnostification--skillplugins)).

The same holds for your `smart-server.yaml`, your prompts, your plugin modules
written against the public interfaces, and the data flowing through the server.

## The reverse direction: GPL content

Because the libraries are `LGPL-3.0-only`, **GPL-3.0 content cannot be vendored
into them.** Doing so would pull the combined work up to the GPL and strip the
additional permissions that make them embeddable. This is why third-party GPL
skill sets are consumed at runtime and never copied into the tree.

The `llm-agent-server` package is the one place where GPL code could live, since
it is already GPL — but keep it out anyway unless there is a strong reason: the
package is meant to stay a thin composition over the libraries, and anything
worth having there is worth having in `llm-agent-server-libs`, where it cannot
go under the GPL.

## Contributions

Contributions are accepted under the licence of the package they touch —
`LGPL-3.0-only` for the libraries, `GPL-3.0-only` for `llm-agent-server`.
Inbound matches outbound. By opening a pull request you confirm you have the
right to contribute the code under those terms.

## Machine-readable

Every published `package.json` declares an SPDX identifier:

```json
"license": "LGPL-3.0-only"   // 16 library packages
"license": "GPL-3.0-only"    // @mcp-abap-adt/llm-agent-server
```

SBOM and licence-scanning tools pick these up without special handling.
`test/repo/licensing.test.ts` enforces that this stays true, and that the
licence texts each package needs are actually present in its tarball.
