# Personal HQ life system

This folder brings past notes, current tasks and future plans into one dashboard. It is committed to the public `varunjakkampudi-tech/personal-hq` repository, so every file and its Git history can be read by anyone. It contains task metadata and planning material only. Never add your resume, profile contents, customer records, contact details, identity documents, credentials, health records or banking/tax identifiers.

## Open and use

Open `index.html` in Chrome or use the GitHub Pages site. The dashboard supports task search and filters, status changes, add/edit, project progress, timeline, daily routine check-ins, backup, restore and a current task export. Changes are stored in the current browser's local storage; they do not sync automatically. Use **Encrypted backup** to carry private task data between browsers; choose a unique passphrase and store it separately. The older **Plain JSON backup** remains available but is unencrypted. GitHub Pages does not provide automatic cross-device sync. Use **Export tasks** to make a fresh snapshot for the 9 AM review. The desktop watcher publishes a sanitized task feed. The freshness banner distinguishes a recent merged desktop update from the timestamp of the last full dashboard export. On Pages, **Merge latest task updates** adds unseen desktop tasks and refreshes supported task guidance while preserving local statuses and browser-only tasks; **Load latest tasks** replaces the task list only when the feed is a full dashboard export. Use **Refresh task evidence** to merge current task guidance without replacing browser statuses. When a task has private notes, confirm explicitly before clearing them. Exporting a fresh dashboard snapshot preserves existing private registry notes for blank imported note fields unless you confirm clearing them. Notes added to a newly imported task are appended to any existing private note during sync. Public task snapshots allowlist task metadata; public history contains milestone summaries only and omits free-text supporting evidence. The complete task registry and supporting records stay in ignored local private storage.

## Data quality

`tasks.json` records both the latest task-feed update time and the last full dashboard-export time. A `current-user-export` means the full task list came from a fresh dashboard export. A `merged-desktop-task-update` means desktop task edits were merged after that export; the banner reports that browser statuses may need reconciliation. Statuses are recorded values and still require evidence review before completion claims. Completed work remains in the list; unfinished items carry forward.

## Plans

- [Career transition · February 2027](plans/career-transition.md)
- [Dairy farm launch decision · January 2027](plans/dairy-farm.md)
- [Dairy supplier shortlist and verification plan](plans/supplier-shortlist.md)
- [AI World 360 daily publishing](plans/ai-world-360.md)
- [Weekly routine, gym and food](plans/routine-and-health.md)
- [ValueMela GST readiness](../research/valuemela-gst-registration.md)
- [Life log](../life-log.html)

Resume/profile source files, real farm/site records, customer information and health details belong in a private, access-controlled location, not this public repository.

On GitHub Pages, the dashboard silently merges the latest public task feed when it opens. It adds newly published tasks and refreshes supported task guidance while preserving browser statuses, notes and browser-only tasks. This is a sanitized one-way metadata update; private browser edits still do not synchronize across devices until private sync is configured. Tasks carrying a private cloud revision are excluded from public-feed field updates.

### Private task sync setup

The dashboard includes an optional Supabase email/password sign-in and revision-checked task sync. It does not provide sign-up. Until the owner creates a Supabase project, applies both migrations, disables public sign-ups and fills supabase-config.js with the project URL and browser publishable key, it continues saving locally and uses encrypted file backup. On first sync, matching differences are shown for an explicit per-task choice, and unresolved conflict choices survive refresh; cloud-only tasks are added, while browser-only tasks require an explicit, title-previewed import decision. Task notes are included only after that confirmation. An encrypted-backup shortcut is available before import. Signed-in accounts keep separate task caches in browser localStorage; the cache is not encrypted by Personal HQ. Signing out returns the visible list to public seed tasks but retains that account's local cache. Use the confirmed removal action to erase the local cache and sync metadata without deleting cloud records. Routine check-ins and life-log data are not synced yet. Supabase Auth persists its session in that browser's local storage. The client SDK is vendored at a pinned version under vendor/ with its MIT license and package integrity recorded in vendor/THIRD-PARTY-NOTICES.md.
