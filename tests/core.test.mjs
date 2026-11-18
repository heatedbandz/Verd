// Unit checks for core.js: Verd only phrases numbers that met their minimum sample size.
//   cd tests && node --test core.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shares, leader, localLevel, dayState, promptLine, verdictMain, lockedLines, pickTeaser, guessLine, bucket, flavor } from '../core.js';

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
