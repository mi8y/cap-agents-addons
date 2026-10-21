# Reports Assistant with SAP Document Management

<video src="docs/images/demo-cap-agent-sdm-backend.mp4" width="100%" controls autoplay loop muted></video>

A CAP agent that turns notes into business reports in a shared SAP Document
Management workspace. Built with `@cap-js/agents`, Deep Agents, and
[`@mi8y/cap-agents-sdm-backend`](../../packages/cap-agents-sdm-backend/README.md).

The agent copies a controlled template, fills it, and saves a `.txt` report that
people can view in the embedded Document Management UI. Business teams maintain
guidance and skills in SDM. Weekly reports build on the previous period's open items. Editing an existing report requires confirmation.

| Skill                                                               | Output                                             |
| ------------------------------------------------------------------- | -------------------------------------------------- |
| [Project Status Report](seed/skills/project-status-report/SKILL.md) | Progress, RAG status, risks, and actions           |
| [Incident Report](seed/skills/incident-report/SKILL.md)             | Impact, timeline, recovery, and corrective actions |
| [Executive Briefing](seed/skills/executive-briefing/SKILL.md)       | Findings, recommendation, and next steps           |

## Setup

Requires a SAP BTP Cloud Foundry environment with AI Core, Document Management,
Destination, XSUAA, and HTML5 Application Repository runtime services.

1. From the monorepo root:

   ```sh
   pnpm install
   pnpm build
   cd examples/cap-agents-sdm-backend
   ```

2. Configure:
   - [package.json](package.json): set `cds.requires.llm.destinationName` and model.
   - [Onboard an internal repository](https://help.sap.com/docs/document-management-service/sap-document-management-service-f6e70dd4bffa4b65965b43feed4c9429/internal-repository),
     then set `cds.requires.sdm.settings.repositoryId` in `package.json`.
   - [manifest.json](app/reports/webapp/manifest.json): set
     `sap.ui5.componentUsages.documentTable.settings.repositoryId` to the same
     repository and `objectId` to its root folder ID.
   - [mta.yaml](mta.yaml): review service plans for your environment.

3. Target your Cloud Foundry org/space, deploy, bind, and start CAP:

   ```sh
   cds up
   cds bind -2 ca-sdm-auth,ca-sdm-destination,ca-sdm-html5-rt,ca-sdm-sdm
   pnpm setup:sdm
   cds watch --profile hybrid
   ```

4. In another terminal, from this example directory:

   ```sh
   cds bind --exec -- npm start --prefix .deploy/app-router
   ```

Open [localhost:5001](http://localhost:5001), sign in, and open the reports app.
Select **Open agent chat**, or open [the preview](http://localhost:5001/a2a/reports-agent/preview/).
Refresh the document browser to see saved reports.

The setup command resolves `.cdsrc-private.json` through `cds bind --exec`, creates
`/report` and `/skills`, and uploads the local `seed/` content. Existing files are
skipped; use `pnpm setup:sdm --overwrite` to reset seeded files. Setup uses the SDM
service key's client credentials; agent requests use the signed-in user's JWT.

## Try it

These fictional examples create `.txt` files in your connected repository.
Run each pair of prompts in order.

### Weekly status: carry open items forward

```text
Create a Project Status Report for Northstar, 2026-10-05 to 2026-10-09.

Owner: Maya Chen.

Updates:
- Design review completed on 2026-10-08
- Pilot due 2026-10-23
- Status Amber because environment access is pending. John owns access approval, due 2026-10-14
```

```text
Create Northstar's status report for 2026-10-12 to 2026-10-16.

Updates:
- Integration tests completed on 2026-10-15.
- No update on access approval or current RAG status.
```

Look for two reports: new accomplishments, the overdue action carried forward,
and missing updates clearly marked.

### Incident: reuse the report for a leadership briefing

```text
Create Incident Report INC-1042 for Atlas Order Portal, 2026-10-19.

Timezone: Asia/Kolkata.

Owner: Priya Shah

Severity: SEV-2

Events:
- 09:10: order submission failed for 18 users.
- 09:35: configuration rollback restored service.

Status:
- Root cause is unconfirmed
- Priya's review is due 2026-10-21
```

```text
Create an Executive Briefing about INC-1042 dated 2026-10-20 for the
Operations Director. For information; no decision requested.
```

Look for a concise briefing based on the saved incident report, with recovery
clearly distinguished from confirmed root cause.

## Customize

- [AGENTS.md](seed/AGENTS.md): starter guidance, seeded to `/AGENTS.md` at the repository root.
- [Skills](seed/skills/): starter skills and `templates/*.txt`, seeded to `/skills/`.
- `/report/` maps to SDM `/report`; `/skills/` maps to SDM `/skills`.

Edit the SDM copies to change behavior; start a **new chat** to load updated
guidance and skills. Keep `SKILL.md` filenames for discovery. Markdown instructions
can be downloaded, edited, and replaced; report templates remain `.txt`.
The local `seed/` directory is starter content, not a runtime fallback.
Existing reports are not moved by setup.

Template protection and confirmation are prompt instructions, not locks or access
controls. Live cloud behavior depends on your bindings; local checks cover skill
discovery and template file operations.
