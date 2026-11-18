# Verd

**What's the Verd?** One question a day for the whole planet. Answer in ten seconds, then see how the world answered.

- `index.html` is the page: markup and all CSS. GitHub Pages serves it as is, with no build step.
- `app.js` is all the code, loaded as an ES module.
- `setup.sql` creates the Supabase database.
- `build.sh` only makes `app.html`, a single-file copy for the claude.ai preview. The website doesn't need it.
