# Verd

**What's the Verd?** One question a day for the whole planet. Answer in ten seconds, then see how the world and your country answered.

- `index.html` is the whole website (served by GitHub Pages).
- `app.html` is the same app without the page wrapper; `sh build.sh` rebuilds `index.html` from it.
- `setup.sql` creates the free Supabase database. Paste the project URL and anon key into `CONFIG` at the top of the script in `app.html`, then run `sh build.sh`.
