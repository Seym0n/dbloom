# SPEC — Specification Requirements for LegacyAdmin 5.2.3 (legacy)

Reverse-engineered specification derived from the source at
`legacy-release`.

## Requirement types used (corrected in review wave 2)
The type token is the first part of an ID. The table gives the intended meaning (README) and, where files deviate, the actual usage found by counting all IDs in the files.

| Type | Intended meaning | Actual usage / deviations |
|---|---|---|
| **FR** | Functional requirement: what the system shall do. | As intended in all files. |
| **NFR** | Non-functional: performance, capacity, scalability, availability, maintainability, portability. | As intended. In 02 some NFR IDs are historically functional (NFR-SRV-001..005). |
| **SEC** | Security: authentication, authorization, CSRF/XSS/SQLi/LFI, secrets. | As intended. Also records observed weaknesses (e.g. SEC-DTB-004, SEC-IOX-096). |
| **UI** | User interface and usability (layout, navigation, theming, i18n, accessibility, RTL). | The files write `UI`, never `UI/UX`; the former legend name "UI/UX" is retired. |
| **DATA** | Data: schemas, stored configuration, persistence formats, limits. | In 07 it also means client-side state. |
| **CPT** | Compatibility/portability (PHP/MySQL versions, browsers, OS) - the README meaning. | Used with that meaning in 01, 02, 03, 05. In 06 it means "concept" (plugin taxonomy, CPT-PLG-001..006); in 07 and 08 it is mixed (concept/capability, product identity, documentation links; about 20 CPT-DEP IDs, some retired in wave 2 because they had only `doc/` evidence). Treat CPT as "concept or compatibility, see the file's own legend". |
| **DEP** | Deployment/operational: installation, build, configuration, logging, upgrade. | In 03 and 07 it also means "dependency/version". |
| **INT** | Interface/integration: DBMS protocols, import/export formats, plugin APIs. | As intended; 02 also uses INT for functional items (INT-SRV-003..005). |
| **CON** | Constraint (licensing, documentation obligations, conventions). | As intended. |
| **CC** | Cross-cutting. Not a type: in `00-overview.md` it is the subsystem token (`TYPE-CC-NNN`). | See subsystem table. |

Not defined: `I18N` (retired, now UI-CC-005), `UX` and `DEV` (the two former DEV IDs in 08 are now NFR-DEP-156 and FR-DEP-157; review wave 2).

## Identifier convention (corrected in review wave 2)
`TYPE-SUBSYS-NNN`, e.g. `FR-SRV-004` = functional requirement #4 for the Server subsystem. IDs are never renumbered; gaps and mixed types are historical. Each file has a coverage note listing the files inspected.

Subsystem codes (one per specification file):

| Code | File | Subsystem |
|---|---|---|
| CC | 00-overview.md | Cross-cutting |
| CFG | 01-configuration.md | Configuration |
| SRV | 02-server.md | Server management |
| DTB | 03-database-table.md | Database / table / SQL |
| IOX | 04-io-formats.md | Import / export / formats / GIS |
| SAU | 05-security-auth.md | Security and authentication |
| PLG | 06-plugins.md | Plugin framework |
| UIX | 07-frontend.md | Frontend |
| DEP | 08-deployment-docs.md | Deployment, documentation, dependencies |

Special cases:
- **Former subsystem-less IDs in 08**: `DEP-090` .. `DEP-094`, `DEP-096`, `DEP-100`, `DEP-102`, `DEP-103`, `DEP-162` were renamed in review wave 2 to `DEP-DEP-090` ... `DEP-DEP-162` (type DEP, subsystem DEP); the mapping is in the header of `08-deployment-docs.md`. No other file referenced the old IDs. Every ID now has the form `TYPE-SUBSYS-NNN`.
- **Numbering blocks**: wave-1 additions use high number blocks per file (for example `FR-SAU-200..208`, `SEC-SAU-300..317`, `FR-UIX-107..117`, `FR-DEP-160..166`). A number is unique within a file and type; the type token is part of the ID.
- **Ranges** such as `FR-PLG-001..017` in ledgers are not IDs.
- **Duplicated topics**: some pairs describe the same code in two files (see `reviews/wave1-io-plugins.md` section 4); the file named there as owner is authoritative.

## Document index
| File | Scope |
|---|---|
| README.md | This overview and conventions |
| 00-overview.md | System overview, scope, stakeholders, cross-cutting requirements |
| 01-configuration.md | Configuration subsystem (Config, Setup, config files) |
| 02-server.md | Server management subsystem |
| 03-database-table.md | Database/Table/SQL subsystems |
| 04-io-formats.md | Import/Export/GIS/handlers and data-format interfaces |
| 05-security-auth.md | Authentication, HTTP, crypto, WebAuthn |
| 06-plugins.md | Plugin framework and bundled plugins |
| 07-frontend.md | JS, templates, themes, UI behavior |
| 08-deployment-docs.md | Deployment, build, deps, docs, tests |
| 09-diagrams.md | Mermaid/UML views 9.1-9.20: context, component, sequence, class, ER, state, deployment, 2FA, tracking, designer, server routes, plugin availability |
| 10-conflicts.md | Conflicts between observed legacy behaviour and DBLoom needs (CF-nnn), with status, options and dispositions |
| FUTURE.md | Ideas deliberately deferred beyond the first release (FU-nnn); not requirements |
| OPEN.md | Open gaps in the SPEC that may block development (scope, DBLoom definition, scenarios, defect decisions, ...) |
| 11-target-security.md | Proposed DBLoom security requirements (`*-TGT-nnn`), traced to the legacy gaps they replace; not a description of LegacyAdmin |
| 12-settings.md | Proposed classification of all DBLoom settings (ENV / UI within bounds / user preference / fixed / dropped), precedence rule, reconciliations and proposed edits to 11; not approved |
| reviews/ | Review logs of wave 1 and wave 2 |

## Method
Each subsystem was inspected file-by-file; every requirement cites its evidence location (`file:line` where meaningful). Ambiguities/observability limits are noted at the end of each document.

## Review waves (added in review wave 2)
The specification was reviewed against the code in waves. The logs are in `reviews/`:

| Wave | Log files | Content |
|---|---|---|
| 1 | `wave1-configuration.md`, `wave1-server.md`, `wave1-database-table.md`, `wave1-io-plugins.md`, `wave1-security-a.md`, `wave1-security-b.md`, `wave1-frontend-deployment.md`, `wave1-overview-diagrams.md` | Per-file spot checks, corrections and additions. |
| 2 | `wave2-overview-diagrams.md` (README, 00-overview, 09-diagrams) and the logs of the other wave-2 reviewers in the same folder | Consolidation, traceability, cross-file consistency. |

Markers in the text: "(corrected in review wave N)" = an existing statement was changed because the code differs; "(added in review wave N)" = new requirement or section. The index of all requirement IDs and the table of known code defects are in `00-overview.md` sections 7 (ID index) and 6 (defects). Evidence rule: only code of the source tree counts; the source's `doc/` folder is not evidence (items that still rely on it are flagged in `08-deployment-docs.md`).
