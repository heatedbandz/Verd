// Unit checks for core.js: Verd only phrases numbers that met their minimum sample size.
//   cd tests && node --test core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shares, leader, localLevel, dayState, promptLine, verdictMain, lockedLines, pickTeaser, guessLine, bucket, flavor, countdown, inDays, NO_STREAK, streakOn, answerOn, streakNote } from '../core.js';

const MIN = { world: 10, country: 30, state: 30, city: 30 };
// Builds a results object the way the database sends it: counts are null below the minimum.
function results(levels, { visible = true, mine = 0 } = {}){
  const r = { mode: 'live', mine, visible, min: MIN, world: null, country: null, state: null, city: null };
  for (const [k, counts] of Object.entries(levels)){
    const n = counts.reduce((a, b) => a + b, 0);
    r[k] = { n, counts: visible && n >= MIN[k] ? counts : null };
  }
  return r;
}
const names = { city: 'Austin', state: 'Texas', country: 'United States' };

test('percentages always add up to exactly 100', () => {
  assert.deepEqual(shares([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(shares([2, 1]), [67, 33]);
  assert.deepEqual(shares([0, 0]), [0, 0]);
  for (let i = 0; i < 2000; i++){
    const c = Array.from({ length: 2 + (i % 3) }, () => Math.floor(Math.random() * 500));
    if (c.some(Boolean)) assert.equal(shares(c).reduce((a, b) => a + b, 0), 100, String(c));
  }
});

test('a tie at the top has no leader', () => {
  assert.equal(leader([5, 5]), -1);
  assert.equal(leader([5, 7, 7]), -1);
  assert.equal(leader([9, 7]), 0);
});

test('below the world minimum there is no verdict, only the count', () => {
  const r = results({ world: [4, 3] });
  assert.equal(r.world.counts, null);
  assert.equal(dayState({ mine: 0, mode: 'live', res: r }), 'locked');
  assert.equal(pickTeaser(r, 0, names), '');
  const [main, sub] = lockedLines(r);
  assert.equal(main, "You're one of the first 7 voters.");
  assert.equal(sub, '3 more votes until the verdict unlocks.');
  assert.doesNotMatch(main + sub, /%/);
  assert.deepEqual(lockedLines(results({ world: [1, 0] })), ["You're the first voter today.", '9 more votes until the verdict unlocks.']);
  assert.equal(lockedLines(results({ world: [5, 4] }))[1], '1 more vote until the verdict unlocks.');
});

test('at the world minimum the verdict appears', () => {
  const r = results({ world: [7, 3] });
  assert.equal(dayState({ mine: 0, mode: 'live', res: r }), 'revealed');
  assert.equal(verdictMain(r.world.counts, 0), '70% are on your side.');
  assert.equal(verdictMain(r.world.counts, 1), 'Only 30% are with you. Rare club.');
  assert.equal(verdictMain([52, 48], 0), "It's neck and neck.");
  assert.equal(verdictMain([80, 20], 0), '80% agree with you.');
});

test('a city under its minimum rolls up to the state, then the country', () => {
  // city 12 votes (< 30), state 40 votes: the state line shows, never the city's numbers
  let r = results({ world: [60, 40], country: [40, 20], state: [30, 10], city: [9, 3] });
  assert.equal(localLevel(r), 'state');
  assert.equal(pickTeaser(r, 0, names), 'Texas is 75% with you.');
  // state too small as well: roll up to the country
  r = results({ world: [60, 40], country: [40, 20], state: [20, 5], city: [9, 3] });
  assert.equal(localLevel(r), 'country');
  assert.equal(pickTeaser(r, 0, names), 'United States is 67% with you.');
});

test("when nothing local is big enough it says you're early, with no numbers", () => {
  const r = results({ world: [60, 40], country: [20, 5], state: [9, 5], city: [2, 1] });
  assert.equal(localLevel(r), null);
  assert.equal(pickTeaser(r, 0, names), "Austin doesn't have enough votes yet. You're early.");
  assert.equal(pickTeaser(r, 0, { country: 'United States' }), "Your city doesn't have enough votes yet. You're early.");
  const onlyCountry = results({ world: [60, 40], country: [20, 5] });
  assert.equal(pickTeaser(onlyCountry, 0, names), "United States doesn't have enough votes yet. You're early.");
});

test('a plot twist needs both sides to have met their minimum', () => {
  const r = results({ world: [60, 40], country: [10, 25] });
  assert.equal(pickTeaser(r, 0, names), 'Plot twist: United States went the other way.');
  const small = results({ world: [60, 40], country: [3, 25] });  // 28 < 30
  assert.doesNotMatch(pickTeaser(small, 0, names), /Plot twist/);
});

test("you can't see today's split before you answer", () => {
  const r = results({ world: [60, 40], country: [40, 20] }, { visible: false, mine: null });
  assert.equal(r.world.counts, null);
  assert.equal(dayState({ mine: null, mode: 'live', res: r }), 'open');
  assert.equal(promptLine(r, 'live'), '100 people answered. Tap to see the verdict.');
});

test('the prompt before you answer is honest about small numbers', () => {
  assert.equal(promptLine(null, 'device'), 'Tap your answer.');
  assert.equal(promptLine(results({ world: [0, 0] }, { visible: false, mine: null }), 'live'), 'Be the first to answer today.');
  assert.equal(promptLine(results({ world: [1, 0] }, { visible: false, mine: null }), 'live'), '1 person so far. Be one of the first 50 to vote.');
  assert.equal(promptLine(results({ world: [20, 9] }, { visible: false, mine: null }), 'live'), '29 people so far. Be one of the first 50 to vote.');
});

test('with no database there is nothing to count, and the state says so', () => {
  assert.equal(dayState({ mine: 1, mode: 'device', res: null }), 'device');
  assert.equal(dayState({ mine: 1, mode: 'live', res: null, waiting: true }), 'offline');
  assert.equal(dayState({ mine: 1, mode: 'live', res: results({ world: [5, 5] }, { visible: false }) }), 'counting');
});

test('every number in a teaser comes from a level that met its minimum', () => {
  const rnd = k => Math.floor(Math.random() * k);
  for (let i = 0; i < 3000; i++){
    const lv = { world: [rnd(80), rnd(80)] };
    if (rnd(2)) lv.country = [rnd(40), rnd(40)];
    if (lv.country && rnd(2)) lv.state = [rnd(30), rnd(30)];
    if (lv.state && rnd(2)) lv.city = [rnd(25), rnd(25)];
    const r = results(lv), mine = rnd(2), line = pickTeaser(r, mine, names);
    const m = line.match(/(\d+)%/);
    if (!m) continue;
    const k = localLevel(r);
    assert.ok(k, 'a percentage appeared with no local level over its minimum: ' + line);
    assert.equal(Number(m[1]), shares(r[k].counts)[mine]);
  }
});

test('the guess is judged against the real share', () => {
  assert.equal(bucket(64), 'most'); assert.equal(bucket(59), 'half'); assert.equal(bucket(40), 'half'); assert.equal(bucket(39), 'few');
  assert.equal(guessLine('most', 64), 'You called it. 64% are with you.');
  assert.equal(guessLine('few', 64), "You guessed only a few. It's 64%.");
  assert.equal(guessLine('half', 51), 'You called it. 51% are with you.');
  assert.equal(flavor([52, 48], 0), "It's neck and neck.");
  assert.equal(flavor([20, 80], 0), 'Rare club.');
  assert.equal(flavor([65, 35], 0), '');
});

test('a count that could not be loaded is an error, not endless counting', () => {
  assert.equal(dayState({ mine: 0, mode: 'live', res: null }), 'loading');
  assert.equal(dayState({ mine: 0, mode: 'live', res: null, failed: true }), 'error');
  // a cached count still shows while the network is down
  assert.equal(dayState({ mine: 0, mode: 'live', res: results({ world: [7, 3] }), failed: true }), 'revealed');
  // an answer that hasn't been sent yet is "offline", whatever the count is doing
  assert.equal(dayState({ mine: 0, mode: 'live', res: null, waiting: true, failed: true }), 'offline');
  assert.equal(dayState({ mine: null, mode: 'live', res: null, failed: true }), 'open');
});

test('the countdown reads like a person would say it', () => {
  const H = 3600000, M = 60000;
  assert.equal(countdown(6 * H + 12 * M), '6h 12m');
  assert.equal(countdown(6 * H + 11 * M + 5000), '6h 12m');   // rounds up: never says 0m while time is left
  assert.equal(countdown(12 * M), '12m');
  assert.equal(countdown(1000), '1m');
  assert.equal(countdown(0), '1m');
  assert.equal(countdown(24 * H), '24h 0m');
  assert.equal(inDays(1), 'tomorrow');
  assert.equal(inDays(5), 'in 5 days');
});

test('streaks: freezes are easy to get, and cover a missed day by themselves', () => {
  let s = { ...NO_STREAK }, r;
  const answer = (day, n) => { r = answerOn(s, day, n); s = r.state; return r; };
  assert.equal(s.freezes, 1, 'everyone starts with a freeze');
  assert.equal(streakOn(s, 10).current, 0);
  answer(10, 1); answer(11, 2);
  assert.equal(streakOn(s, 11).current, 2);
  assert.equal(streakOn(s, 12).current, 2, 'still alive the next day, before answering');
  answer(13, 3);   // day 12 missed: the starting freeze covered it, with nothing to do
  assert.equal(r.used, 1); assert.equal(s.streak, 3); assert.equal(s.freezes, 0);
  answer(14, 4); answer(15, 5);
  assert.ok(r.earned, 'a freeze for every 5 days answered'); assert.equal(s.freezes, 1); assert.equal(s.best, 5);
  const again = answerOn(s, 15, 5);
  assert.deepEqual(again.state, s, 'answering twice in a day changes nothing'); assert.equal(again.used, 0); assert.equal(again.earned, false);
  // days answered count, not days in a row: the 10th answer earns one even after a fresh start
  assert.equal(answerOn({ last: 2, streak: 1, freezes: 0, best: 6 }, 9, 10).state.freezes, 1);
  // three is the most you hold
  const full = answerOn({ last: 0, streak: 1, freezes: 3, best: 1 }, 1, 10);
  assert.equal(full.earned, false); assert.equal(full.state.freezes, 3);
});

test('streaks: missing more days than your freezes is a fresh start that keeps your best, never a guilt trip', () => {
  const s = { last: 20, streak: 9, freezes: 1, best: 9 };
  assert.equal(streakOn(s, 22).alive, true, 'one missed day: covered');
  assert.equal(streakOn(s, 23).alive, false, 'two missed days and one freeze: a fresh start');
  const r = answerOn(s, 23, 10);
  assert.equal(r.state.streak, 1); assert.equal(r.state.best, 9); assert.equal(r.used, 0, 'freezes are kept for the new streak');
  assert.equal(r.state.freezes, 2, 'and the 10th day answered earned another');
  const notes = [
    streakNote(NO_STREAK, 5, 0),
    streakNote({ last: 4, streak: 3, freezes: 1, best: 3 }, 5, 3),
    streakNote({ last: 3, streak: 3, freezes: 1, best: 3 }, 5, 3),   // the freeze is already covering yesterday
    streakNote({ last: 5, streak: 3, freezes: 0, best: 3 }, 5, 3),
    streakNote({ last: 5, streak: 4, freezes: 0, best: 4 }, 5, 9),
    streakNote({ last: 5, streak: 3, freezes: 2, best: 3 }, 5, 3),
    streakNote(s, 23, 9),
    streakNote(r.state, 23, 10),
    streakNote({ last: 1, streak: 1, freezes: 0, best: 1 }, 5, 1)
  ];
  assert.deepEqual(notes, [
    "Answer today's question to start your streak.",
    "Answer today to make it 4 days. If you can't, a freeze covers it.",
    'Answer today to make it 4 days.',
    'Answer 2 more days to earn a streak freeze.',
    'Answer 1 more day to earn a streak freeze.',
    '2 streak freezes saved. A freeze covers a missed day by itself.',
    'Fresh start. Your best is 9 days.',
    'Fresh start. Your best is 9 days.',
    "Answer today's question to start a new streak."
  ]);
  for (const n of notes) assert.doesNotMatch(n, /lost|lose|broke|ruin|gone|miss out|don't|!|shame|sad/i, n);
});

