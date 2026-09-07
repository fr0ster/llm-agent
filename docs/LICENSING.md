# Licensing

**Every package in this monorepo is licensed under the GNU Lesser General Public
License v3.0 only (`LGPL-3.0-only`), starting with v21.0.0.**

Copyright © 2025–2026 Oleksii Kyslytsia

> This page describes what the licence says and how it applies to the ways
> people actually use these packages. It is not legal advice. If your situation
> is unusual — you are relicensing, sublicensing, shipping to an app store, or
> statically bundling — talk to your own counsel.

## The short version

| You are… | Do you have to release your own source? |
|---|---|
| Importing these packages into your program | **No** |
| Running `llm-agent` as a server and calling it over HTTP | **No** |
| Shipping a Docker image that installs these packages from npm | **No** — but ship the notices, see below |
| Loading your own skills at runtime via `skillPlugins:` | **No** — your skills stay yours |
| **Modifying these libraries** and distributing the result | **Yes**, the modifications go back under the LGPL |
| Bundling a modified/inlined copy into a binary with no way to swap it | **Yes**, or restructure so it can be swapped |

The line the LGPL draws is not "did you touch the code" but **"can your users
replace this library with their own build of it."**

## Why two licence files

Every package ships **both**:

- `LICENSE` — the GNU Lesser General Public License v3.0
- `COPYING` — the GNU General Public License v3.0

Both are required. The LGPL is not a standalone licence: it is a set of
*additional permissions* layered on top of the GPL, and its own text says so in
its first paragraph. `LICENSE` without `COPYING` is an incomplete grant.

## What this is not

**It is not retroactive.** Every version published up to and including
**v20.9.5** was released under MIT and stays MIT under those terms, permanently.
A copyright holder cannot retract a licence already granted. If you are pinned to
`20.9.5` or earlier, nothing about your obligations changed — you are still on
MIT, and you can stay there.

**It is not an API break.** v21.0.0 removes no export, changes no signature, and
requires no config migration. The major version is reserved for the licence
precisely because it is the part that requires a decision.

## Migrating from the MIT releases

If you are on v20.9.5 or earlier and want to move to v21.0.0:

1. **Decide whether LGPL works for you at all.** For the overwhelming majority of
   consumers — importing the packages, or running the server and talking to it
   over HTTP — the answer is yes and nothing else on this list applies. Read the
   table above first.
2. **Upgrade normally.** `npm install @mcp-abap-adt/llm-agent-server@21` (and any
   peers). There is no code change, no config change, no import rewrite.
3. **If you redistribute the packages** — in a Docker image, an installer, a
   bundled artifact — include with your distribution:
   - a notice that your product uses these libraries and that they are covered
     by the LGPL,
   - a copy of both `LICENSE` and `COPYING` (they are already inside each
     package's tarball, under `node_modules/@mcp-abap-adt/<pkg>/`),
   - the copyright notice above.
4. **If you modified these libraries**, publish those modifications under the
   LGPL, and make sure your users can relink or substitute their own build.
   Contributing the change back upstream is the easiest way to satisfy this.
5. **If you cannot accept the LGPL**, pin to `20.9.5`. It remains MIT forever and
   is not going anywhere. It will not receive further fixes, so treat this as a
   deliberate freeze rather than a long-term plan, and get in touch if you need
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

Because these packages are `LGPL-3.0-only`, **GPL-3.0 content cannot be vendored
into this repository.** Doing so would pull the combined work up to the GPL and
strip the additional permissions that make the libraries embeddable. This is why
third-party GPL skill sets are consumed at runtime and never copied into the
tree.

## Contributions

Contributions are accepted under the same licence as the project
(`LGPL-3.0-only`) — inbound matches outbound. By opening a pull request you
confirm you have the right to contribute the code under those terms.

## Machine-readable

Every published `package.json` declares:

```json
"license": "LGPL-3.0-only"
```

This is the SPDX identifier, so SBOM and licence-scanning tools pick it up
without special handling. `test/repo/licensing.test.ts` enforces that this stays
true, and that both licence texts are actually present in every package tarball.
