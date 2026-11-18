# Verd

**What's the Verd?** One question a day for the whole planet. Answer in ten seconds, then see how the world answered.

- `index.html` is the page: markup, all the CSS (built on design tokens at the top of the stylesheet), and the questions and colours in one JSON block (`#verd-data`). A tiny inline script uses that block to paint today's question before the code arrives. GitHub Pages serves it as is, with no build step.
- `app.js` is the app, loaded as an ES module.
- `sw.js` is the service worker. After one visit Verd opens with no connection, and it updates itself in the background.
- `manifest.webmanifest`, `icons/` and `splash/` make Verd installable, with launch screens for every current iPhone. If the logo changes, `node tools/make-icons.mjs` redraws them all.
- `core.js` holds the rules for what the numbers allow Verd to say (minimum sample sizes, roll-up, every verdict line). It has no screen code, so `tests/core.test.mjs` runs it in Node.
- `tests/` has the database attack tests, the browser tests and the live checks. See `PLAN.md` for what each proves.
  - The local tests never reach the real database: `tests/serve.mjs` blanks its settings, and the claude.ai preview keeps its own votes.
  - `node tests/live-rls.mjs` attacks the real database with the public key, and every attack must be denied. `node tests/live-smoke.mjs` opens the app against it without answering. Neither stores anything.
  - `.github/workflows/live-check.yml` runs both on GitHub after every change to the app, the database or the checks.
- `setup.sql` creates the Supabase database.
- `build.sh` only makes `app.html`, a single-file copy for the claude.ai preview. The website doesn't need it.
