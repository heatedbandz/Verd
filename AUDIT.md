# Verd audit

Audited 2026-11-18 on commit `09a2b74`. I read every file in the repo (`index.html`, `app.html`, `build.sh`, `setup.sql`, `README.md`), ran Lighthouse, and drove the app with Playwright on a 390 × 844 viewport in light and dark mode.

## How it was measured

- **Server:** a local copy of the site served under `/verd/` with gzip and `Cache-Control: max-age=600`, the same as GitHub Pages. I can't reach `heatedbandz.github.io` from this sandbox, so every number below is from this local copy.
- **Lighthouse 13.6.0 profiles.** Each result is the median of 3 runs.
  - *Mobile default*: the harsh one, slow 4G at 150 ms RTT and 1.6 Mbps, with the CPU slowed 4×.
  - *iPhone-class*: 4G at 60 ms RTT and 9 Mbps, no CPU slowdown, 390 × 844 at 3× scale.
- **Interaction:** Playwright on Chromium at 390 × 844 with touch and the CPU slowed 4×. INP is the worst Event Timing duration across a vote and three tab switches. Smoothness is the gap between `requestAnimationFrame` frames over 1.6 s after a vote.

## Baseline numbers

| Metric | Budget | Mobile default | iPhone-class |
|---|---|---|---|
| First contentful paint | < 1.0 s | **1.57 s** ✗ | 0.64 s ✓ |
| Largest contentful paint | < 1.5 s | **1.57 s** ✗ | 0.64 s ✓ |
| Total blocking time | — | 0 ms | 0 ms |
| Layout shift | — | 0 | 0 |
| Lighthouse Performance | ≥ 95 | 99 ✓ | 100 ✓ |
| Lighthouse Accessibility | ≥ 95 | 96 ✓ (fails colour contrast) | 96 ✓ |
| Lighthouse Best Practices | 100 | 100 ✓ | 100 ✓ |
| Bytes on first load | — | 55 KB (30 KB of it is a Google font) | same |

| Metric | Budget | Measured |
|---|---|---|
| JS + CSS, gzipped | < 120 KB | 18.8 KB JS + 5.0 KB CSS ✓ (all inline in `index.html`) |
| INP, worst tap at 4× CPU | < 100 ms | **80–120 ms** ✗ (a vote rebuilds every slide in the feed) |
| Frames over 20 ms during the reveal | 0 | 1 (worst 33 ms) |
| Animations on transform and opacity only | all | **no**: result bars animate `height`/`width`, and buttons animate `background-color`, `box-shadow` and `color` |
| Works offline after first load | yes | **no**: reload fails with `ERR_INTERNET_DISCONNECTED` |
| Installable PWA | yes | **no**: no manifest, icons, splash or service worker |
| Console errors | 0 | 0 ✓ |

## What's already good (keep it)

- The core loop is tap-only, one full-screen question with two big targets, and the result stays hidden until you vote.
- The guardrails hold. The feed has a real end. There are no notifications, follower counts or like counts on people, and posting stays off on the public site.
- The design direction is right: full-bleed colour, big type and a quiet floating bar.

## Findings, ranked by impact on the first 30 seconds and day-2 return

### Critical: honesty and integrity

1. **The numbers aren't real yet, and the app says they are.** No database is connected, so every reveal is worked out from this phone's own votes. A first-time visitor taps "Cats" and is told **"100% Cats · You're the first voice on Earth today."** That's false, and it breaks the "no fake data, ever" rule in the first 10 seconds.
2. **`setup.sql` would allow ballot stuffing if it were deployed.** The `voter` id is picked by the browser, and anyone can insert straight into `votes` (`with check (true)`). One script could cast unlimited votes, on any `day` string.
3. **`setup.sql` leaks individual votes.**
   - `friend_votes(codes)` returns a person's raw day-by-day answers to anyone who knows or guesses their 6-letter code.
   - `tally()` returns counts per country with no minimum. A country with one voter shows that person's answer.
   - Nothing stops people peeking: `tally()` returns today's results whether or not you've voted.
4. **Question suggestions are wide open.** Anyone can insert unlimited rows, with no rate limit and no review status. This is the only user-written content on the public site, and it has no moderation queue.

### High: first 30 seconds

5. **The reveal is flat.** Tapping swaps the buttons for bars straight away. There's no guess, no build-up and no payoff line. The guess-the-split step from the first version was lost in the full-screen rebuild. Teaser lines can be technically true but meaningless: "Plot twist: United States went the other way" can appear with 2 votes. Sharing copies text to the clipboard, with no image and no share sheet.
6. **The first screen has dead controls.** Five scope tabs (World, Country, State, City, Friends) sit above the daily question, but they only filter user posts, which are off on the public site. Tapping City hides today's question and asks "Where are you?". That's clutter and a dead end in the first 30 seconds.
7. **A web font blocks the first paint.** Geist comes from Google Fonts: 30 KB, plus an 840 ms render-blocking request on slow 4G (Lighthouse's estimate). This alone puts first paint over budget on the harsh profile.
8. **Contrast fails AA.** White text on the red (`#ff4d4d`), orange (`#f2730a`) and green (`#0fa968`) screens and topic tiles is about 3:1. Small text like the kicker, footer and tile counts needs 4.5:1. Lighthouse also flags the top bar text.
9. **Tap feedback is slow.** A vote rebuilds every slide in the feed in one go, so the worst tap takes 80–120 ms at 4× CPU, over the 100 ms budget. The vote itself feels instant, because `:active` paints first, but the reveal starts late. The result bars animate `height` and `width`, which forces layout on every frame.

### High: day-2 return

10. **It can't go on the Home Screen properly, and it's useless offline.** There's no manifest, apple-touch-icon, splash screen, light and dark theme colour, or service worker. On the Supabase path, a vote made with no signal is lost: the `fetch` fails and only a toast says so.
11. **There's no reason to come back at the end of the feed.** "You're all caught up. Come back later" has no countdown and no sneak peek. The tomorrow sneak peek from the first version is gone.
12. **Badges show the ones you haven't earned, greyed out.** That's clutter, and the spec says earned only. A lost streak quietly resets to 0 with no kind message.
13. **Friends are bare codes.** You can't invite with one tap, a friend has no name, and friend match needs friends' raw votes (see finding 3).

### Medium: iPhone polish

14. **Safe areas:** the top bar ignores `safe-area-inset-top`. Installed with a translucent status bar, it would sit under the clock and the Dynamic Island.
15. **Tap targets under 44 pt:** the scope tabs (about 30 px tall), the comment "Report" links (about 20 px), the search clear "×" (20 px) and the remove-recent "×" (about 26 px).
16. **Haptics fire on every button tap** through a global click listener, including Cancel, Close and tabs. The spec says meaningful moments only.
17. **Touch details are missing:**
    - `:active` doesn't fire on iOS without a `touchstart` listener.
    - There's no `touch-action: manipulation`.
    - Long-press on a button or slide selects text or shows the callout menu.
    - There's no protection against rubber-band scrolling on fixed elements.
18. **Motion has no system.** There are 10+ different durations and curves (0.12 s ease, .2 s, .25 s, .28 s, .3 s, .5 s, .9 s cubic-bezier and others). There's no shared spring and no View Transitions; tab switches are hard cuts.
19. **No loading or error states.** Before results arrive, the reveal shows 0%. A failed fetch is swallowed by `catch{}`. The toast covers the top bar.
20. **Search on the public site is a dead end.** Every topic tile says "Be the first" and leads to "Posting opens soon".

### Low

21. The whole 81 KB app ships inside `index.html`, so it can't be cached on its own. Every visit after 10 minutes re-downloads all of it.
22. The friend code comes from a hash of a random device id, so it isn't tied to anything on a server.

## Screenshots

These are the 390 px baseline shots in light and dark mode, saved in the work session but not committed: the first screen, the reveal, the end of the feed, search, and Me.

What stands out in them:

- In the reveal, a single device vote shows as "100% · You're the first voice on Earth today."
- The five scope tabs crowd the top of the first screen.
- Me shows six greyed-out badges you haven't earned.
