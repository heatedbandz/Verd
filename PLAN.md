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
| 6. Instant first paint | 100 / 100 | 0.63 s / 0.25 s (**LCP 0.63 / 0.25**, the same as first paint) | 100 | 32–40 ms | 0–1 frames over 20 ms | 30.1 + 11.2 KB | blank | no |
| 7. Installable, works offline | 100 / 100 | 0.62 s / 0.25 s (LCP 0.62 / 0.25) | 100, and 0 axe issues on all 6 screens | 32 ms | 1–2 frames over 20 ms, only the tap's own frame | 30.6 + 11.6 KB (+1.2 KB `sw.js`, after load) | **works** | **yes** |
| 8. Return loop | 100 / 100 | 0.62 s / 0.25 s (LCP 0.62 / 0.25) | 100 | 32–40 ms | 0–1 frames over 20 ms | 31.4 + 11.7 KB | works | yes |
| 9. Friends and rivalries | 100 / 100 | 0.67 s / 0.25 s (LCP 0.67 / 0.25) | 100, and 0 axe issues on the board and Me | 40–48 ms | 0–2 frames over 20 ms | 33.5 + 11.9 KB | works | yes |
| 10. Teen safety and the posting gate | 100 / 100 | 0.63 s / 0.25 s (LCP 0.63 / 0.25) | 100, and 0 axe issues on all 3 states of the age question, in both themes | 40–48 ms | 1–2 frames over 20 ms | 34.5 + 12.0 KB | works | yes |

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

### 6. Instant first paint

- **The question is the first paint.** The 40 questions, their topics and the 8 colours moved from `app.js` into one small JSON block in `index.html` (`#verd-data`). A 2 KB inline script reads it and paints today's slide, in today's colour, as the HTML arrives. `app.js` reads the same block, so the questions still live in one place.
- **No redraw.** When `app.js` arrives it fills in the slide around the question instead of rebuilding it, so the words you're reading never leave the screen. This matters for the numbers too: Chrome only keeps a paint as the largest one if its element stays on the page. Before this, the app redrew the question about 10 ms after the first paint, so the measured LCP waited for the code.
- **An early tap counts.** If you tap an answer before the code has arrived (slow 4G), the button rings at once and the app counts that answer as soon as it loads. That one gets no haptic, because a late tick would feel wrong.
- **Returning voters** see their ringed answer and "Your answer is in. Counting the votes…" straight from the HTML, which is what the app shows first anyway, so nothing jumps.
- **Numbers:** LCP now equals first paint: **0.63 s** on the harsh profile and **0.25 s** on the iPhone profile, down from 1.09 s and 0.43 s. Lighthouse normally simulates throttling; with real ("applied") throttling instead, first paint and largest paint are both 0.69 s and the code finishes loading at 1.44 s, so the question is on screen about 0.75 s before the app is ready. If the inline script ever fails, the skeleton from change 5 shows and the app draws as before.
- **Tests:** every suite passes unchanged (`core` 14, `contrast` 5, now reading the palette from `index.html`, device 4, live 7, reveal 3). Also checked by script: posting, tabs and voting with no database; the claude.ai preview build; and an answer tapped while `app.js` was held back is saved once it arrives.
- `app.js` stays a separate file, so the service worker in change 7 can cache it.

### 7. Installable, and works offline

- **Installs like an app.** `manifest.webmanifest` says standalone and portrait, and starts at `./`, so it works under GitHub Pages' `/Verd/` path. Icons: 192 and 512, a maskable one for Android, and a 180 px Apple touch icon with no see-through pixels (iOS would show black behind them). `tools/make-icons.mjs` draws them all from the favicon's V-and-dot mark, so the logo has one source.
- **iPhone launch screens** for all 11 current iPhone screen sizes, from the SE to the 17 Pro Max and the Air: the mark, small and centred on the feed's black.
  - One dark set serves both themes, not a light and a dark set as planned. The first screen you see, the feed, is dark in both themes, so a white launch screen in light mode would flash white right before a black feed.
  - iOS only shows launch screens when the page has the `apple-mobile-web-app-capable` tag, even with a manifest, so it's there. The standard `mobile-web-app-capable` tag sits next to it, because Chrome warns without it.
- **No white flash:** the launch screen, the manifest's background, the page background and the theme colour are all the feed's #0b0b0b. Then the question paints straight from the HTML (change 6).
- **The status bar follows the screen.** Installed on an iPhone, the status bar takes the page's theme colour.
  - It's black over the feed, a past question and a new post.
  - Over Me and Search it's the page's own background: white or black with the phone's theme. It switches live if the phone's theme changes.
- **Works offline.** `sw.js` keeps the page, the code, the manifest and the icons in one cache.
  - Every launch is served from that cache at once, online or not.
  - Then it checks the page and code in the background. If any of them changed, it downloads the whole set and swaps it in together. So a new page never runs with old code, and nothing needs a version number bumped by hand.
  - A new release shows from the second launch after it's deployed, or at the reload when a new question drops.
- **Leaves the rest alone.** It only answers for the app's own address.
  - Requests to the database are never touched. Answers made offline wait in the outbox from change 1 and are sent when the signal is back.
  - The site's other pages, like this plan and the audit, load normally.
  - The claude.ai preview has no manifest, so it never registers the worker.
- **Tests:** `tests/pwa.mjs` adds 6, and needs only Playwright:
  - Chrome reports no installability errors, and the manifest parses clean.
  - Every icon and launch screen the page names exists at its exact pixel size.
  - After one visit, with the network off: the app opens, the question shows, an answer is saved, and it survives another offline launch.
  - Offline, `PLAN.md` fails like any web page instead of turning into the app.
  - A changed `app.js` is fetched in the background on one launch and runs on the next.
  - The status bar colour over the feed and Me, in both themes, and when the phone switches theme.
  - `tests/e2e-live.mjs` gained one (8 now): installed, opened with no signal, in live mode, the answer waits and reaches the database when the signal returns. All 54 tests pass.
- **Numbers:** Lighthouse is 100 / 100 / 100 on both profiles, and first and largest paint are unchanged at 0.62 s and 0.25 s. The worker registers after the page has loaded, so it costs the first visit nothing. Code is 30.6 KB and the page 11.6 KB gzipped, plus 1.2 KB for `sw.js`.
- **To check on your phone:** that the status bar turns white on Me in light mode. Apple has used the theme colour for the status bar since iOS 15, but I can't run iOS here.

### 8. Return loop within the guardrails

- **Streak freezes are easy to get.** Everyone starts with one, and every 5 days you answer earns another, in a row or not, up to 3. Before, they came only every 7 days in a row, up to 2. A freeze covers a missed day by itself, so there's nothing to remember.
- **A lost streak is a fresh start.**
  - It says "Fresh start. Your best is 9 days." Your best is kept, and so are your freezes.
  - No streak line says lost, broke or don't. A unit test checks every one of them for guilt words.
- **The line under your streak says what helps next,** like "Answer today to make it 4 days. If you can't, a freeze covers it." or "Answer 2 more days to earn a streak freeze."
- **The streak rules moved to `core.js`,** so they're unit-tested: missed days, freezes used and earned, the cap, answering twice in a day, and your best. Streaks saved under the old rules get the starting freeze too.
- **Badges: only the ones you have.** No greyed-out list to collect, and none for posting or comments, which are off on the public site. Before your first answer, it says "Answer today's question to earn your first badge."
- **The payoff for coming back.** If you answered yesterday, yesterday's final verdict now says how your answer did: "You said Be invisible. 36% are on your side." A past question in search uses the same line.
- **Why there's no "verdict unlocks tonight" line:** early on, with few people, a day might never reach the minimum, so "tonight" could be untrue. Instead:
  - The locked slide says exactly how many more votes the verdict needs, and keeps your guess.
  - The reveal plays the first time you see that day's verdict.
  - The next day, yesterday's slide tells you how your answer did.
- **Kept as they were:** the end of the feed shows when tomorrow's question drops and its topic (change 5), and the weekly recap is unchanged.
- **No notifications, ever.** `tests/guardrails.mjs` reads every shipped file and fails if it finds a notification, push or app-icon badge API.
- **Tests:** 4 new, and all 59 pass.
  - `core`: 16 (+2, the streak rules and their wording).
  - `device`: 5 (+1, Me with no locked badges and a streak line that helps).
  - `live`: 9 (+1, yesterday's slide says how your answer did).
  - `guardrails`: 1 (new).
- **Numbers:** unchanged. Lighthouse 100 / 100 / 100, and the largest paint is 0.62 s / 0.25 s.

### 9. The first 1,000 users: friends and rivalries

- **Invite links.** Me → Friends has an Invite button. It opens the share sheet with your link: the site plus `#f=YOURCODE&n=Name`.
  - Nothing after the `#` ever reaches a server, GitHub's included. The first name is optional, letters only, and kept only on the phones that open the link.
  - Opening a friend's link adds them on your phone and clears it from the address bar. It doesn't make an account: that still waits for your first answer, and then your friend list is copied to the database.
  - Opening your own link is caught. The share card and every share link carry your invite too.
- **A friend match now needs both people to add each other.** Before, anyone who knew your code could compare themselves with you, and with only 3 shared answers a 100% or 0% match gave away exactly how you answered those days. Now:
  - A new `friend_adds` table holds each person's list, locked like votes (RLS on, no browser access). `set_friends` replaces your list, up to 50 codes, so removing someone ends the match for both of you.
  - `friend_match` only returns friends who added you too. It still uses past days only, and shows agreement only after 3 shared answers.
  - Each friend's line says where things stand: "Matches start after your first answer.", "Shows once they add you too.", "2 shared answers so far", or "67% match".
- **Today's board.** After you answer (live only), a slide under today's asks "Who said Cats?". It lists countries, and cities in your state, with the share in each that picked your answer, and marks yours "You".
  - A place shows only at 30 answers, the database's minimum. Until then it says so: "No country has 30 answers yet. Share today's question to put yours on the board."
  - It loads once your answer is counted and draws after the reveal, so the reveal stays smooth.
- **Codes are kept apart by mode.** The stand-in code a phone makes before the database exists never goes into an invite once Verd is live, because it wouldn't work there.
- **Tests:** 7 new, and all 63 pass.
  - `db`: 15. Matches need both people; removing someone ends it for both; lists are capped at 50 and can't be read or written directly.
  - `device`: 6. An invite link adds the friend by name and clears itself, your own link is refused, and your invite carries your code and name.
  - `live`: 11. Opening an invite makes no account. The match goes from "after your first answer" to "once they add you too" to "67% match". The board shows its empty state, then France and the US once they reach 30 answers, with yours marked.
  - `live-rls.mjs`, the check you run on the real project, now covers `friend_adds` too.
- **Numbers:** Lighthouse 100 / 100 / 100. The code grew 2.1 KB gzipped.

### 10. Teen safety and the posting gate

- **Posting stays off on the public site, and a test proves it.** With the database connected there's no post button, no feed tabs, no "Post something" at the end of the feed, no "Start a debate" in search, and nothing opens the composer.
  - Until the database is switched on, the site keeps its old post-on-your-phone feature. Those posts never leave the phone, and the composer says so: "Only you can see your posts until Verd goes live."
- **One neutral age question before state and city.** Under COPPA, the US children's privacy law, a child's city counts as personal information. So Me → Your place now asks for the month and year you were born before it shows State and City.
  - Nothing is picked for you, the years go back to 1920, and the question doesn't say where the line is.
  - The answer stays on the phone. Once given it isn't asked again, so it can't be changed to get past it.
  - **Under 13:**
    - State and City are hidden, and anything already saved there is deleted.
    - Votes and results send only the country.
    - The State and City tabs and audiences go away.
    - The box for suggesting a question goes too. It's the one place where words someone writes reach Verd's server.
  - **13 and older:** State and City show as before.
  - **Saved before this change:** a state or city isn't sent until the question is answered. Nobody loses anything today: the public site isn't live yet, so no one has seen state or city results.
- **Suggestions were already moderated:** signed in only, 3 a day, a blocklist on the server, and every one held for review (`suggest_question`, tested in `db`).
- **Still needed before posting can open.** All of these need accounts, which need a parent-owned sign-in setup, or someone to review posts:
  - reports, a blocklist and rate limits on the server;
  - every first post held for review;
  - friends-only by default for minors;
  - no DMs and no public profiles;
  - an age kept with the account, not only on the phone.
- **Hardening for later.** Neither of these exposes raw votes today.
  - **Exact counts at city size.** Someone who refreshes just before and just after a friend answers could see which way the count moved. That tells nothing at world scale, but a city with 30 to 100 answers is small enough to matter. The fix: move city and state counts only in steps of 10 answers. Every number stays true, just a little less fresh.
  - **The age answer lives on the phone,** so clearing the app's data asks again. That's as far as a neutral age question can go. Real protection for posting needs the age kept on the server with the account.
- **Tests:** 3 new, and all 66 pass.
  - `device`: 7.
    - The age question starts empty and doesn't hint at the line.
    - Under 13 deletes a saved state and city and drops the State and City audiences.
    - 13 and older keeps them.
    - The question isn't asked again.
  - `live`: 13.
    - Posting stays off with the database connected.
    - A vote from someone under 13 stores no state or city, and they get no suggestion box. Someone older stores both.
- **Numbers:** Lighthouse 100 / 100 / 100. The code grew 1.1 KB gzipped.

## Next single step

*(written at the end of the session)*
