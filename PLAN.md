# Verd plan

There are 10 changes, ranked by impact on the first 30 seconds and on day-2 return. The real backend is ranked first because every other number in the app depends on it.

Before change 1 there is one preparation commit with no behaviour change. It splits the single 81 KB file into `index.html` (markup and CSS) and `app.js` (code), so every later change has a readable diff. Changes are built in this order, one commit each. Before and after numbers are added under each change as it lands.

Sizes: **S** is under 2 hours, **M** is half a day, **L** is a day or more.

---

## 1. Real backend: Supabase with airtight RLS · L

- **Problem:** votes live only in `localStorage`, so the reveal is fiction (audit findings 1–3). The old `setup.sql` would allow unlimited votes and leak individual answers.
- **Change:** a new `setup.sql` for Supabase.
  - **Sign-in:** anonymous auth, so there's no signup wall.
  - **Votes:** a `votes` table with `primary key (day, user_id)`, so the database itself allows one vote per person per question. `user_id` always comes from `auth.uid()`, never from the browser.
  - **Locked tables:** RLS is on for every table with no client policies, and `anon` and `authenticated` have every table privilege revoked. All reads and writes go through `security definer` functions.
  - **Reads:** `get_results` returns totals only. City, state and country splits need **n ≥ 30**, the world needs **n ≥ 10**, and both thresholds live in the `app_config` table so they can be changed. Today's counts come back only if the caller has already voted, so peeking is blocked in the database, not just the UI.
  - **Location:** only country, state and city are stored.
  - **Migration:** `import_votes` copies existing local votes once.
  - **Sync:** the client is a ~3 KB `fetch` wrapper, not the 40 KB SDK. It has an outbox, so a vote made offline syncs later.
- **Implementation:** write `setup.sql`, a `supabase` backend in `app.js` (anonymous sign-in, token refresh, `rpc()`, outbox), and `tests/db.test.mjs`. The test loads `setup.sql` into a real local Postgres 16 behind a stub of Supabase's `auth` schema and roles, then attacks it as a client the way PostgREST would. `tests/live-rls.mjs` repeats the attack over HTTPS against the real project once keys exist.
- **Verify:** as `anon` and `authenticated`, the tests check that:
  - `select * from votes` is denied;
  - direct insert, update and delete are denied;
  - a second vote doesn't change the count;
  - another user's vote is never visible;
  - splits under the threshold come back as `null`;
  - today's counts stay hidden until you vote;
  - a friend match needs 3 shared answers.

## 2. Honest numbers and cold start · M

- **Problem:** "100% · You're the first voice on Earth today" from one device vote (audit finding 1). Splits are shown at any n.
- **Change:**
  - **No connection:** with no database, the app says so plainly: your answer is saved on this phone and live results start soon.
  - **Small samples:** below a threshold the reveal shows the count and when the verdict unlocks ("You're voter #7. The verdict unlocks at 10 votes."). It never shows a percentage.
  - **Local splits:** these roll up from city to state, then country, then world, until one meets its threshold. A level that doesn't is described honestly ("Your city doesn't have enough votes yet, you're early").
  - **Early voters:** they see "Be one of the first 50 to vote".
  - **Questions:** curated seed questions only. No seeded votes or invented counts.
- **Implementation:** one `results` model (world, country, state and city counts, with thresholds) shared by all three backends, plus `pickTeaser()`, which only phrases numbers that pass the threshold.
- **Verify:** a Playwright test in device-only mode checks that no `%` appears in the reveal. A unit check feeds `pickTeaser()` counts below and above each threshold.

## 3. Feel system: tokens, contrast, iPhone fit · M

- **Problem:** one-off values everywhere, contrast failures, safe-area and tap-target gaps, haptics on every tap, non-composited animations (audit findings 8, 14–18).
- **Change:**
  - **Tokens:** CSS custom properties for colour, 4 pt spacing, radius, shadow, blur, type scale and motion, used everywhere.
  - **Type:** the system font stack (SF Pro on iPhone) with tabular numerals.
  - **Colour:** a palette darkened until white text passes AA 4.5:1, including the gradient highlight.
  - **Safe areas:** applied on all four edges.
  - **Touch:** 44 pt minimum tap targets, `touch-action: manipulation`, and no text selection or callouts on controls.
  - **Motion:** one shared spring (`--spring`, a CSS `linear()` curve generated from a damped spring) with a 0.96 squish on press.
  - **Haptics:** one helper for vote, reveal, streak and badge only, with no global click haptics.
- **Implementation:** rewrite the `<style>` block on top of tokens. `tests/contrast.mjs` computes WCAG ratios for every colour pair.
- **Verify:** the contrast script passes. Lighthouse Accessibility is ≥ 95 with no contrast failures. A grep finds no `transition`/`animation` on anything except `transform` and `opacity`.

## 4. The reveal: the best 3 seconds · L

- **Problem:** instant, flat, no guess, text-only share (audit finding 5).
- **Change:**
  - **Vote:** squish and tick in under 16 ms.
  - **Guess:** one tap, "How much of Earth is with you? Most · About half · Few".
  - **Reveal:** bars spring in on `transform`, and the percentages count up and land exactly on the real number.
  - **Payoff:** the guess against reality ("You said Few. 64% are with you."), then one true teaser line.
  - **Share:** one tap makes a 1080 × 1350 image card with "What's the Verd?" branding through the Web Share API. The card never says which side won, so friends still have to vote to find out.
  - **Transitions:** View Transitions where supported.
- **Implementation:** render only the daily slide on a vote, not the whole feed. A `reveal()` sequence on one timeline. `shareCard()` draws on canvas, then uses `navigator.share({files})`, falling back to download plus copied text.
- **Verify:** INP < 100 ms at 4× CPU, zero frames over 20 ms during the reveal, and the count-up's final text equals the server number. Screenshot every state.

## 5. A calm first 30 seconds, with designed states · M

- **Problem:** dead scope tabs, an end of feed with no hook, no loading or error states, a dead-end search (audit findings 6, 11, 19, 20).
- **Change:**
  - **Scope tabs:** they appear only when there are posts to filter.
  - **End of feed:** "You're caught up. Tomorrow's question drops in 6h 12m", with a sneak peek of tomorrow's topic.
  - **Loading:** skeletons for the first paint, results and friends.
  - **Errors:** an offline pill and a retry state.
  - **Search:** on the public site it finds aired daily questions instead of dead "Be the first" tiles.
- **Verify:** screenshots of every screen's empty, loading and error states at 390 px in light and dark.

## 6. Instant first paint · S

- **Problem:** the web font blocks render, and LCP waits for all the JS (audit findings 7, 21).
- **Change:**
  - **Fonts:** no third-party fonts.
  - **Inline paint:** a 3 KB inline script paints today's question into the skeleton from the HTML itself, so LCP comes with the HTML.
  - **Caching:** `app.js` is a separate module, cached by the service worker.
- **Verify:** Lighthouse FCP < 1.0 s and LCP < 1.5 s (iPhone-class), and report the harsh default profile too.

## 7. Installable PWA that works offline · M

- **Problem:** not installable and blank offline (audit finding 10).
- **Change:**
  - **Install:** `manifest.webmanifest` (standalone), icons at 180, 192 and 512 plus a maskable one, and Apple splash screens for current iPhones in light and dark.
  - **Launch colour:** `theme-color` for both schemes and dark-first `color-scheme`, so there's no white flash.
  - **Offline:** `sw.js` precaches the shell and serves stale-while-revalidate. Votes queue in the outbox.
- **Verify:** Chrome's `Page.getInstallabilityErrors` returns none. Playwright loads the site, goes offline, reloads, and the question still renders. A vote made offline syncs when the network returns.

## 8. Return loop within the guardrails · S

- **Change:**
  - **Badges:** only earned ones show, with a friendly empty state.
  - **Streaks:** freezes are easy, with 1 to start and 1 every 5 answered days (max 3). A lost streak gets "Fresh start. Your best is 9 days." and never guilt.
  - **Tomorrow:** a sneak peek and an honest "verdict unlocks tonight" hook when today is under the threshold.
  - **Recap:** the weekly recap stays.
  - **Never:** no notifications of any kind.
- **Verify:** streak unit checks (missed days, freezes, best). Grep shows no Notification or Push API anywhere.

## 9. The first 1,000 users: friends and rivalries · M

- **Change:**
  - **Invites:** a one-tap invite link `?f=CODE&n=Name` adds you as their friend instantly, with an optional first name that's stored only on the phone.
  - **Friend match:** "You and Jay agree 78%" is computed in the database, needs 3+ shared answers, and never sends a raw vote.
  - **Rivalries:** country and city rivalries appear only above n = 30. Below that: "No city has 30 votes yet. Share to put yours on the board."
  - **Share card:** it carries the invite code.
- **Verify:** DB tests for friend match thresholds. A Playwright test opens an invite link and sees the friend added.

## 10. Teen safety and moderation gate · L (most of it next sessions)

- **Already true:** posting is off on the public site.
- **This session:**
  - Suggestions go through `suggest_question`: signed-in users only, 3 a day, a server-side blocklist, and a `pending` status in a moderation queue.
  - A client test proves the post button is hidden when the database is connected.
- **Before posting can open (needs accounts):**
  - a 13+ age gate (under-13s get no posting and no city-level location);
  - reports stored server-side;
  - a server-side blocklist;
  - per-user rate limits;
  - every first post held for review;
  - friends-only by default for minors;
  - no DMs and no public profiles.
- **Verify:** DB tests for the suggestion rate limit and blocklist. A Playwright check finds no post button on the public build.

---

## Results

*(filled in as each change lands)*

## Next single step

*(written at the end of the session)*
