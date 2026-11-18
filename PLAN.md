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

How these were measured: Lighthouse 13.6, median of 3 runs, in two profiles. "Default" is Lighthouse's harsh mobile profile (slow 4G, 4× CPU slowdown). "iPhone" is an iPhone-class profile (60 ms round trip, 9 Mbps, no CPU slowdown, 390 × 844 at 3×). INP and frame numbers come from a Playwright run at 390 px with a 4× CPU slowdown that votes, reveals and switches tabs. Sizes are gzip -9.

| After | Perf default / iPhone | FCP default / iPhone | A11y | INP (4× CPU) | Worst reveal frame | JS + HTML/CSS gz | Offline | Install |
|---|---|---|---|---|---|---|---|---|
| Baseline | 99 / 100 | 1.57 s / 0.64 s | 96 | 80–120 ms | 33 ms | 18.8 + 5.0 KB (+30 KB font) | blank | no |
| 1. Real backend | 100 / 100 | 1.40 s / 0.59 s | 96 | 56–72 ms | 17–33 ms | 21.0 + 7.2 KB (+30 KB font) | blank | no |
| 2. Honest numbers | 100 / 100 | 1.40 s / 0.59 s | 96 | 56 ms | 33–50 ms | 23.3 + 7.2 KB (+30 KB font) | blank | no |
| 3. Feel system | 100 / 100 | **0.62 s / 0.24 s** (LCP 1.12 / 0.43) | **100** | 64 ms | 33 ms | 23.6 + 8.1 KB, no font | blank | no |
| 4. The reveal | 100 / 100 | 0.61 s / 0.25 s (LCP 1.09 / 0.43) | 100 | **40–56 ms** (live reveal: 16 ms vote, 32–40 ms guess) | **0–1 frames over 20 ms**, only the tap's own frame | 27.1 + 8.4 KB | blank | no |
| 5. Calm first 30 seconds | 100 / 100 | 0.61 s / 0.25 s (LCP 1.10 / 0.43) | 100, and 0 axe issues on all 6 screens | 32 ms | 1–2 frames over 20 ms, only the tap's own frame | 30.8 + 9.0 KB | blank | no |

### 1. Real backend

- **Database attack tests** (`tests/db.test.mjs`, real Postgres 16 with `setup.sql` loaded twice): **14 of 14 pass.** As `anon` and as a signed-in user, every table read and write is denied; RLS returns 0 rows even if a grant slips in; private helpers can't be called; a second vote is rejected by the primary key; today's counts stay hidden until you vote; splits under the minimum come back empty and roll up; results contain no user ids; friend match, import, rivalry board and suggestion rules hold.
- **App tests** (`tests/e2e-live.mjs`, the real `index.html` + `app.js` in Chromium against a stand-in for Supabase's HTTP API): **5 of 5 pass.** Looking creates no account; the first vote signs in anonymously and stores exactly one row; the app's own token is refused on every raw table; an offline vote waits in the outbox and syncs when the signal returns; old answers on the phone are copied once; percentages appear only after 10 votes; the friend code comes from the server.
- **The public-key attack** (`tests/live-rls.mjs`, the test you asked for): it signs in with only the public anon key and tries to read, insert, change and delete raw votes, read every other table, call private helpers, call personal functions without a session, and peek at today's results. Against the stand-in API it makes **35 of 35 checks pass**. It is ready to run against the real project the moment keys exist.
- **Lighthouse and size:** unchanged in practice. `app.js` grew 2.2 KB gz for the database client, outbox and import. The default profile's FCP improved because the code now loads as a deferred module.

### 2. Honest numbers and cold start

- **The rules now live in `core.js`**, a small module with no screen code, so they can be tested on their own. Today's question is always in one of seven states: open, loading, device (no database), offline (saved, not sent), counting, locked (under the minimum) and revealed. Each state has its own true copy.
- **No database (the public site today):** "Your answer is saved. Live results aren't switched on yet, so there's no verdict to show." No percentage, count or verdict appears anywhere on the page. Your answer also locks in: before, the buttons stayed tappable when there were no numbers, so you could change your answer.
- **Under the minimum:** "You're one of the first 7 voters. 3 more votes until the verdict unlocks." Before you answer: "7 people so far. Be one of the first 50 to vote."
- **Local splits roll up** from city to state to country. "Plot twist" needs both sides over their minimum. When nothing local is big enough yet: "Austin doesn't have enough votes yet. You're early."
- **Small fixes found on the way:** percentages always add up to exactly 100; "with the majority" in Your week only counts days whose real count is known (it used to count unknown days as misses); the share text says "I'm with 64% of the 212 people who answered" instead of "of Earth"; posts made with no database say "Only you can see your posts until Verd goes live."
- **Tests:** `tests/core.test.mjs`, **11 of 11 pass**, including a check that feeds 3,000 random results and confirms every percentage in a teaser comes from a level over its minimum. `tests/e2e-device.mjs`, **2 of 2 pass**: with no database, no `%` appears anywhere after voting, and the answer can't be changed. The live app tests (now 5 of 5 with checks for the locked and offline copy) still pass.
- **Numbers:** unchanged within noise. `core.js` adds 2.0 KB gz and is preloaded, so it doesn't add a round trip.

### 3. Feel system: tokens, contrast, iPhone fit

- **Tokens first.** The stylesheet was rewritten on one set of custom properties: colour (light and dark), a 4 pt spacing scale, radius, shadow, blur, a 9-step type scale and motion. Every remaining raw number is a component size (an icon, a tile) or a hairline.
- **Type:** the system font stack, so iPhones get SF Pro, with tabular numerals on every number. The 30 KB Google font and its render-blocking request are gone.
- **Contrast:** the slide palette is deeper (crimson, green, rust, teal and pink all failed with white text before) and the white sheen went from 20% to 10%. Text on slides no longer uses opacity for hierarchy. `tests/contrast.mjs` reads the real palette and tokens and checks 5 groups: white text on both ends of every gradient under the sheen, labels and percentages on the glass and result bars, page text in light and dark, the floating bar over a white photo, and the bar on pages. **5 of 5 pass.** Lighthouse Accessibility went from 96 to **100** in both profiles, with no contrast failures (the top bar used to fail).
- **iPhone fit:** safe areas are applied per element (top bar, slides, pages, compose, sheet, toast and the capsule), so colour runs edge to edge while text clears the notch and home indicator. Every tap target is at least 44 × 44 pt (checked with a script on every screen). No 300 ms delay, no text selection or callouts on controls, no rubber-band on the page, and `:active` works on Safari.
- **Motion:** one shared spring (stiffness 380, damping 26, 6% overshoot, settles in about 500 ms) written as a CSS `linear()` curve. Buttons squish to 0.96 on press and spring back on release. Result bars now animate `transform` instead of `height`/`width`, and nothing animates colour, shadow or size any more.
- **Haptics:** one helper with four named moments: vote, reveal, streak milestone and new badge. The haptic on every button tap is gone.
- **Numbers:** FCP fell from 1.40 s to **0.62 s** on the harsh profile and from 0.59 s to **0.24 s** on the iPhone profile, almost all from dropping the font. Page weight fell from 60 KB to 32 KB.

### 4. The reveal

- **The moment, in order:** you tap an answer and it squishes, rings white and ticks in the same frame (16 ms at 4× CPU), before anything is saved. Then one quick guess: "How many people picked Cats? Most · About half · Few". Then the reveal on one timeline: bars grow on `transform` and the percentages count up with an ease-out for 0.8 s and land exactly on the database's numbers; the headline arrives at 420 ms ("You called it. 69% are with you." or "You guessed only a few. It's 69%."), then one true teaser at 700 ms.
- **When there's nothing to check the guess against** (no database), there's no guess step. Under the minimum the guess is kept: "You're one of the first 7 voters. 3 more votes until the verdict unlocks. Your guess is saved." The first time you see an unlocked verdict, even on a later visit, it plays the full reveal.
- **Share:** one tap opens the share sheet with a 1080 × 1350 image card: "What's the Verd?", the question, "I'm with 69% of 13 people. Which side are you on?", the answers without numbers, the link and your friend code. It never says which side won, so friends still have to answer. The card is drawn ahead of time while you read, so the share sheet opens straight away on iPhone. Where there's no share sheet (most computers) the card is saved and the text copied.
- **Speed:** a vote or a new count redraws only today's slide, and keeps the slide itself so its full-screen gradient isn't repainted. Nothing redraws when nothing visible changed, so a button is never swapped out under your finger (this was a real race: a count arriving mid-guess replaced the guess buttons). Slides use CSS containment.
- **View Transitions** cross-fade the tabs and each step of the reveal on Safari 18+ and Chrome. Older browsers get the existing slide-up animation. Reduced motion turns both off and shows final numbers straight away.
- **Tests:** `tests/reveal.mjs` runs the whole moment against the real `setup.sql` in light and dark: answer, guess, reveal, share. It checks the count-up's final text equals the database's split, the guess line, the answer count, that the card is a 1080 × 1350 PNG with the branding, and that no text drawn on the card names the winning side. **3 of 3 pass.** It also measures taps (16 ms answer, 32–40 ms guess) and frames: over 1.8 s of reveal at 4× CPU, 0 or 1 frames run over 20 ms, and the only one is the tap's own response frame (33–50 ms at 4×, about a quarter of that on a phone at full speed).

### 5. A calm first 30 seconds, with designed states

- **No dead controls.** The five tabs over the feed only filter people's posts, so they now appear only when there are posts to filter. On the public site the first screen is just today's question. The post button also starts hidden and only appears where posting exists, so it can never flash on the public site. *Removed:* the feed used to reopen on the last tab you picked. It now always opens on today's question, because a remembered "City" tab hid today's question behind "Where are you?" (audit finding 6).
- **A real end.** The feed ends with "You're caught up. Tomorrow's question drops in 6h 12m." and a sneak peek, "Tomorrow's topic: Food", which comes from a topic now tagged on every daily question. If you haven't answered, one button takes you back to today; once you have, there's nothing to do but come back. The countdowns tick every 30 seconds, and an app left open over the day change reloads for the new question (before, it showed yesterday's question with a negative countdown).
- **Loading.** The page arrives with a skeleton of the first slide, so there's never a blank screen while the code loads. While the count loads, the line under the question is a placeholder bar instead of a line that changes a moment later. After you answer, your pick stays ringed and the answers breathe while the count comes in. Friend matches on Me show placeholder rows.
- **Errors.** A small pill in the top bar says "Offline" or "Can't connect · Retry". When the count can't be loaded the slide says so ("Your answer is in. Couldn't load the count right now.") with a Try again button. Before, it said "Counting the votes…" forever. A count saved earlier still shows while the network is down. A footer line that changes now updates in place, so a button is never replaced under your finger while the count arrives.
- **Search works on the public site.** It finds daily questions that are already out. Tap today's to answer it, or an older one for its final verdict from the database: "Most people said Fly. 64% / 36%, 14 answers", or "Not enough answers for a verdict. 7 people answered. A verdict needs 10." Topic tiles count real questions and debates ("2 questions") or say when the next one drops ("Next one tomorrow"). They're no longer ranked as "Trending" unless there's real activity. A search that matches a question that hasn't dropped yet says "Something on “pizza” is coming up. The next one drops in 5 days." without showing it. With no match, the button on the public site is "Suggest it as a daily question", which fills in the suggestion form, instead of "Start a debate", which led to "Posting opens soon". Also fixed: today's answer count never showed in search, because a variable named `res` hid the real results.
- **Me.** "Answer today's question to start your streak." on day one. Copy no longer copies "······" before your code exists: it says the code shows up after your first answer. Opening Me no longer creates an account just to look up friend matches.
- **Tests:** 2 new device-mode tests (no tabs, the end state and its button, search finds today's question, a past question shows no verdict and no `%`) and 2 new live tests (a cached count shows offline, the error state, Try again recovers; a past question shows the database's own numbers). `tests/e2e-device.mjs` **4 of 4**, `tests/e2e-live.mjs` **7 of 7**, `tests/core.test.mjs` **14 of 14** (new: the error state and the countdown wording), and `reveal.mjs`, `db.test.mjs` and `contrast.mjs` all still pass. axe-core finds **0 WCAG A/AA issues** on the first screen, the end of the feed, search, an empty search, a past question and Me, in light and dark, and every tap target there is at least 44 × 44.
- **Numbers:** unchanged within noise. CLS is 0.003 in this no-database copy, because the post button appears once the code runs; with the database switched on it stays hidden and CLS is 0. `app.js` grew 3.2 KB gz.

## Next single step

*(written at the end of the session)*
