# Verd

**What's the Verd?** One question a day for the whole planet. Answer in ten seconds, then see how the world answered.

- `index.html` is the page: markup and all CSS, built on design tokens at the top of the stylesheet. GitHub Pages serves it as is, with no build step.
- `app.js` is the app, loaded as an ES module.
- `core.js` holds the rules for what the numbers allow Verd to say (minimum sample sizes, roll-up, every verdict line). It has no screen code, so `tests/core.test.mjs` runs it in Node.
- `tests/` has the database attack tests, the browser tests and the live security check. See `PLAN.md` for what each proves.
- `setup.sql` creates the Supabase database.
- `build.sh` only makes `app.html`, a single-file copy for the claude.ai preview. The website doesn't need it.
