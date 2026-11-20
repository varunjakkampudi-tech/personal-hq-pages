# Personal HQ life system

This folder brings past notes, current tasks and future plans into one dashboard. It is committed to the public `varunjakkampudi-tech/personal-hq` repository, so every file and its Git history can be read by anyone. It contains task metadata and planning material only. Never add your resume, profile contents, customer records, contact details, identity documents, credentials, health records or banking/tax identifiers.

## Open and use

Open `index.html` in Chrome or use the GitHub Pages site. The dashboard supports task search and filters, status changes, add/edit, project progress, timeline, daily routine check-ins, backup, restore and a current task export. Changes are stored in the current browser's local storage; they do not sync automatically. Use **Encrypted backup** to carry private task data between browsers; choose a unique passphrase and store it separately. The older **Plain JSON backup** remains available but is unencrypted. GitHub Pages does not provide automatic cross-device sync. Use **Export tasks** to make a fresh snapshot for the 9 AM review. The desktop watcher publishes a sanitized task feed. The freshness banner distinguishes a recent merged desktop update from the timestamp of the last full dashboard export. On Pages, **Merge latest task updates** adds unseen desktop tasks and refreshes supported task guidance while preserving local statuses and browser-only tasks; **Load latest tasks** replaces the task list only when the feed is a full dashboard export. Use **Refresh task evidence** to merge current task guidance without replacing browser statuses. When a task has private notes, confirm explicitly before clearing them. Exporting a fresh dashboard snapshot preserves existing private registry notes for blank imported note fields unless you confirm clearing them. Notes added to a newly imported task are appended to any existing private note during sync. Public task snapshots allowlist task metadata; public history contains milestone summaries only and omits free-text supporting evidence. The complete task registry and supporting records stay in ignored local private storage.

## Data quality

`tasks.json` records both the latest task-feed update time and the last full dashboard-export time. A `current-user-export` means the full task list came from a fresh dashboard export. A `merged-desktop-task-update` means desktop task edits were merged after that export; the banner reports that browser statuses may need reconciliation. Statuses are recorded values and still require evidence review before completion claims. Completed work remains in the list; unfinished items carry forward. The Timeline records new task creations, edits and status transitions in private browser-local activity history; signed-in activity is partitioned by account and merged with owner-scoped cloud events when configured. Older changes are not reconstructed. It records task title/area, changed field names and status transitions, never private-context or next-action values. The history is included in private task exports and backups; restore merges event IDs so an older backup cannot erase events already in this browser. Public feed generation omits the activity history. On sign-in, activity is partitioned by account in this browser and merged with owner-scoped cloud events when the third migration is installed. A failed cloud event read preserves the account cache locally; signed-out browser activity remains separate.

## Plans

- [Career transition · February 2027](plans/career-transition.md)
- [Dairy farm launch decision · January 2027](plans/dairy-farm.md)
- [Dairy supplier shortlist and verification plan](plans/supplier-shortlist.md)
- [AI World 360 daily publishing](plans/ai-world-360.md)
- [Weekly routine, gym and food](plans/routine-and-health.md)
- [ValueMela GST readiness](../research/valuemela-gst-registration.md)
- [ValueMela storefront operational readiness](plans/valuemela-operations-readiness.md)
- [Life log](../life-log.html)

Resume/profile source files, real farm/site records, customer information and health details belong in a private, access-controlled location, not this public repository.

On GitHub Pages, the dashboard silently merges the latest public task feed when it opens. It adds newly published tasks and refreshes supported task guidance while preserving browser statuses, notes and browser-only tasks. This is a sanitized one-way metadata update; private browser edits still do not synchronize across devices until private sync is configured. Tasks carrying a private cloud revision are excluded from public-feed field updates.

### Private task sync setup

Private sync is **not connected** in the published dashboard: `supabase-config.js` contains no project URL or key. The dashboard therefore saves task data only in the current browser, and encrypted backup is the manual transfer option. The optional Supabase path in this repository is preparation, not a live or independently verified service. Before enabling it, the owner must create a private project, review its region and retention, apply all three migrations, disable public sign-ups, create the owner account, configure the project URL and browser publishable key, and verify owner-only access using a separate test account. Never expose a service-role or secret key. Routine check-ins and life-log data are not synced. Account task caches and Supabase Auth sessions remain in browser localStorage and are not encrypted by Personal HQ. The client SDK is vendored at a pinned version under vendor/ with its MIT license and package integrity recorded in vendor/THIRD-PARTY-NOTICES.md.
