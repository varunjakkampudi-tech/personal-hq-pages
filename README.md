# Personal HQ · GitHub Pages edition

A public, static Personal HQ template for GitHub Pages. It contains generic categories and no personal tasks or profile information.

## Privacy and storage

GitHub Pages sites are public. The template contains only generic categories and no personal tasks. Tasks and check-ins entered after loading are stored in that visitor’s browser local storage; the site itself does not upload or synchronize them. Do not enter secrets, credentials, sensitive identifiers, or records that should not be stored in the browser.

This is a client-only dashboard. It has no account system, server-side database, or authentication. **Backup** downloads a full local copy. **Sync tasks** downloads a task-registry export; it does not send data to the Pages host. The downloaded export contains the personal task details you entered, so keep it private. On the configured desktop, a separate local watcher can transfer a recent export from Downloads into a private registry. That watcher is not part of this public website, and the site does not confirm whether it processed the file. Browser storage remains specific to that browser and device; use the export/restore controls to move data.

## Publish

Create a public GitHub repository containing only `index.html`, `life-log.html`, this `README.md`, and `.nojekyll`. Then set **Settings → Pages → Deploy from a branch**, select `main` and `/(root)`. The public website URL will appear in the Pages settings after deployment completes. Do not push the private desktop Personal HQ folder into this repository.

## Local use

Open `index.html` directly in a browser. Browser storage is local to that browser and device.
