# PLAXUS M25 — Deploy guide (shared cloud version)

## What changed
Before: every browser kept its own private copy of the data, so CR edits never reached the class link.
Now: one master copy lives on Netlify (Netlify Functions + Blobs). Both links read it; only the CR link can change it.

- Class link  `https://plaxusdb26.netlify.app/`          -> view + likes, suggestions, replies, own blood group / phone / photo. No CR controls exist on this page.
- CR link     `https://plaxusdb26.netlify.app/?role=cr`   -> passcode-protected, edit everything directly (see below).

## Project layout
    public/index.html              the dashboard (published)
    netlify/functions/api.mjs      the shared backend (not publicly downloadable)
    netlify.toml, package.json     Netlify config

## Deploy (one time)
index.html alone can no longer be dropped on Netlify, because the backend function must be deployed with it.

Option A — Netlify CLI (most reliable)
    npm install -g netlify-cli
    netlify login
    netlify link            # choose your existing site "plaxusdb26"
    netlify deploy --prod

Option B — GitHub: push this folder to a repo, then in Netlify use "Add new project -> Import from Git"
(or connect it to the existing site). Netlify installs the dependency and deploys the function automatically.

## First run (do this in order)
1. Open the CR link in the SAME browser you used to edit before. Enter the passcode.
   If the cloud is empty, that browser's previously saved edits are uploaded as the starting data.
2. Settings tab -> set a new CR passcode (default is `m25nitc` until you change it).
   Optional: set an environment variable PLAXUS_CR_PASSCODE in Netlify to choose the initial passcode.
3. Share the class link. It always shows the latest data. No re-sharing needed after edits.

## What the CR can edit directly (on the CR link)
- Timetable: click any cell and type
- Notices, Deadlines, Dossiers, Creative sheets, Blogs: ✏ and 🗑 on every card
- Scholars: ✏ on each card, "+ Add Scholar" (name, roll, DOB, email; remove)
- Suggestions: delete suggestions and individual replies
- Class portrait, marquee text, wallpaper, passcode (Settings / Update Portrait)
