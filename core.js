// Verd's rules for what the numbers allow it to say. No screen, no storage, so tests can run it in Node.
// The rule everywhere: a split is only shown when the database says it has met its minimum sample size.
// Levels below their minimum arrive with counts: null, and every line here rolls up past them.

export const sum = a => a.reduce((x, y) => x + y, 0);
export const pct = (n, t) => t ? Math.round(n * 100 / t) : 0;
export const countsOf = level => level && level.counts ? level.counts : null;
export const num = n => n.toLocaleString("en-US");

// Whole percentages that always add up to exactly 100 (largest remainder), so two bars never read 49 and 50.
export function shares(counts){
  const total = sum(counts); if (!total) return counts.map(() => 0);
  const raw = counts.map(c => c * 100 / total), out = raw.map(Math.floor);
  let left = 100 - sum(out);
  for (const [, i] of raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])){ if (left-- <= 0) break; out[i]++; }
  return out;
}

// The answer with the most votes, or -1 when the top is tied.
export function leader(counts){
  const max = Math.max(...counts);
  return counts.filter(c => c === max).length > 1 ? -1 : counts.indexOf(max);
}

export const LOCAL = ["city", "state", "country"];   // most local first; world is the last roll-up

// The most local level whose split can be shown, or null. A level under its minimum is skipped.
export function localLevel(res){
  for (const k of LOCAL) if (countsOf(res && res[k])) return k;
  return null;
}

// Where today's question stands, from the screen's point of view.
//   open: you haven't answered · loading: no results yet · device: no database, nothing to count
//   offline: your answer is waiting to be sent · counting: sent, the count is on its way
//   locked: counted, but fewer votes than the minimum · revealed: the verdict can be shown
//   error: sent, but the count couldn't be loaded (failed: the last try to load it failed)
export function dayState({ mine, mode, res, waiting, failed }){
  if (mine == null) return "open";
  if (mode === "device") return "device";
  if (waiting) return "offline";
  if (!res) return failed ? "error" : "loading";
  if (!res.visible) return "counting";
  return countsOf(res.world) ? "revealed" : "locked";
}

// The line under today's question before you answer.
export function promptLine(res, mode){
  if (mode === "device" || !res || !res.world) return "Tap your answer.";
  const n = res.world.n;
  if (!n) return "Be the first to answer today.";
  const people = num(n) + (n === 1 ? " person" : " people");
  if (n < 50) return people + " so far. Be one of the first 50 to vote.";
  return people + " answered. Tap to see the verdict.";
}

// The headline once the verdict is in. Only called with counts that met the minimum.
export function verdictMain(counts, mine){
  const s = shares(counts), share = s[mine], top = [...s].sort((a, b) => b - a);
  if (top[0] - top[1] <= 8) return "It's neck and neck.";
  if (share === 0) return "Almost nobody picked that. Rare club.";
  if (share < 35) return "Only " + share + "% are with you. Rare club.";
  if (share >= 75) return share + "% agree with you.";
  return share + "% are on your side.";
}

// A short second line about the split, for when the headline is about your guess.
export function flavor(counts, mine){
  const s = shares(counts), share = s[mine], top = [...s].sort((a, b) => b - a);
  if (top[0] - top[1] <= 8) return "It's neck and neck.";
  if (share < 35) return "Rare club.";
  if (share >= 75) return "Most people are with you.";
  return "";
}

// The guess before the reveal: how many people picked the same answer as you?
export const GUESSES = [["most", "Most"], ["half", "About half"], ["few", "Few"]];
export const bucket = share => share >= 60 ? "most" : share >= 40 ? "half" : "few";
export function guessLine(guess, share){
  if (bucket(share) === guess) return "You called it. " + share + "% are with you.";
  return "You guessed " + { most: "most people", half: "about half", few: "only a few" }[guess] + ". It's " + share + "%.";
}

// Before the minimum: how far along the count is, in plain numbers.
export function lockedLines(res){
  const n = res && res.world ? res.world.n : 0, min = (res && res.min && res.min.world) || 10, left = Math.max(1, min - n);
  return [
    n <= 1 ? "You're the first voter today." : "You're one of the first " + num(n) + " voters.",
    left + (left === 1 ? " more vote" : " more votes") + " until the verdict unlocks."
  ];
}

// One true line under the verdict. names: { city, state, country } as the person wrote them.
// It uses the most local level that met its minimum; if the level you set is still too small,
// it rolls up, and only says "you're early" when nothing below the world level is big enough yet.
export function pickTeaser(res, mine, names){
  const world = countsOf(res && res.world); if (!world || mine == null) return "";
  const k = localLevel(res), name = k && names[k];
  if (k && name){
    const c = countsOf(res[k]), share = shares(c)[mine], lead = leader(c), wlead = leader(world);
    if (lead >= 0 && wlead >= 0 && lead !== wlead) return "Plot twist: " + name + " went the other way.";
    return share ? name + " is " + share + "% with you." : "Nobody in " + name + " picked that. Yet.";
  }
  const early = LOCAL.find(x => res[x] && !countsOf(res[x]));
  if (!early) return "";
  const who = names[early] || (early === "city" ? "Your city" : early === "state" ? "Your state" : "Your country");
  return who + " doesn't have enough votes yet. You're early.";
}

// Time left until the next question, as people say it: "6h 12m", "12m", "1m".
export function countdown(ms){
  const mins = Math.max(1, Math.ceil(ms / 60000)), h = Math.floor(mins / 60), m = mins % 60;
  return h ? h + "h " + m + "m" : m + "m";
}
export const inDays = k => k === 1 ? "tomorrow" : "in " + k + " days";

// ---------- Streaks ----------
// Days in a row you answered. Freezes cover missed days by themselves, and they're easy to get: everyone starts
// with one and earns another for every 5 days answered (in a row or not), holding up to 3. Missing more days than
// your freezes cover starts a fresh streak. Your best is kept, and nothing ever says you lost something.
export const FREEZES = { start: 1, every: 5, max: 3 };
export const NO_STREAK = { last: -99, streak: 0, freezes: FREEZES.start, best: 0 };
const days = n => n + (n === 1 ? " day" : " days");

// Where a streak stands on day `today`. s.last is the day number of your last answer.
export function streakOn(s, today){
  const gap = today - s.last - 1;   // days missed since your last answer, not counting today
  const alive = s.last === today || (s.streak > 0 && gap <= s.freezes);
  return { ...s, gap, alive, current: alive ? s.streak : 0 };
}
// Answering on `today`, your `answered`th day overall: the new state, the freezes that covered missed days, and
// whether this answer earned a freeze.
export function answerOn(s, today, answered){
  if (s.last === today) return { state: s, used: 0, earned: false };
  const now = streakOn(s, today), used = now.alive ? Math.max(0, now.gap) : 0, streak = now.alive ? s.streak + 1 : 1;
  let freezes = s.freezes - used;
  const earned = answered > 0 && answered % FREEZES.every === 0 && freezes < FREEZES.max;
  if (earned) freezes += 1;
  return { state: { last: today, streak, freezes, best: Math.max(s.best, streak) }, used, earned };
}
// The line under your streak: what helps next. A missed day never reads as a loss.
export function streakNote(s, today, answered){
  const st = streakOn(s, today);
  if (!answered) return "Answer today's question to start your streak.";
  if (st.best > 1 && (!st.alive || (st.last === today && st.streak === 1))) return "Fresh start. Your best is " + days(st.best) + ".";
  if (!st.alive) return "Answer today's question to start a new streak.";
  if (st.last !== today){
    const spare = st.freezes - Math.max(0, st.gap);
    return "Answer today to make it " + days(st.streak + 1) + "." + (spare > 0 ? " If you can't, a freeze covers it." : "");
  }
  if (st.freezes) return (st.freezes === 1 ? "1 streak freeze" : st.freezes + " streak freezes") + " saved. A freeze covers a missed day by itself.";
  const k = FREEZES.every - answered % FREEZES.every;
  return "Answer " + k + (k === 1 ? " more day" : " more days") + " to earn a streak freeze.";
}
