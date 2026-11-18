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
export function dayState({ mine, mode, res, waiting }){
  if (mine == null) return "open";
  if (mode === "device") return "device";
  if (waiting) return "offline";
  if (!res) return "loading";
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
  if (share === 0) return "Nobody else picked that. Yet.";
  if (share < 35) return "Only " + share + "% are with you. Rare club.";
  if (share >= 75) return share + "% agree with you.";
  return share + "% are on your side.";
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
