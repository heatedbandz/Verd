// ---------- Settings. Paste your free Supabase project URL and anon key here to go public. ----------
const CONFIG = { supabaseUrl: "", supabaseKey: "", siteUrl: "" };

// ---------- Questions: one per day, in order, then it loops. Two to four answers each. ----------
const QUESTIONS = [
  ["Would you rather be able to fly or be invisible?", ["Fly","Be invisible"]],
  ["Cats or dogs?", ["Cats","Dogs"]],
  ["Is a hot dog a sandwich?", ["Yes","No"]],
  ["Would you go to Mars if you could never come back?", ["Yes, I'd go","No way"]],
  ["Which is better: morning or night?", ["Morning","Night"]],
  ["Would you rather know the future or change the past?", ["Know the future","Change the past"]],
  ["Do you put pineapple on pizza?", ["Yes","Never"]],
  ["Should school start later in the day?", ["Yes","No"]],
  ["Would you rather live by the beach or in the mountains?", ["Beach","Mountains"]],
  ["Will humans live on another planet within 50 years?", ["Yes","No"]],
  ["Would you take $1 million now or $5,000 a month for life?", ["$1 million now","$5,000 a month"]],
  ["Sweet or salty snacks?", ["Sweet","Salty"]],
  ["Would you rather speak every language or play every instrument?", ["Every language","Every instrument"]],
  ["Is it okay to text while someone is talking to you?", ["Sometimes","Never"]],
  ["Summer or winter?", ["Summer","Winter"]],
  ["Would you trust a self-driving car with your life?", ["Yes","Not yet"]],
  ["Do you believe in aliens?", ["Yes","No","Not sure"]],
  ["Would you give up your phone for a month for $10,000?", ["Easily","No chance"]],
  ["Books or movies?", ["Books","Movies"]],
  ["Should everyone learn to code at school?", ["Yes","No"]],
  ["Would you rather be famous or rich?", ["Famous","Rich"]],
  ["Do you shower in the morning or at night?", ["Morning","Night"]],
  ["Would you rather explore space or the deep ocean?", ["Space","Deep ocean"]],
  ["Is cereal a soup?", ["Yes","No"]],
  ["Would you rather never use social media again or never watch TV again?", ["No social media","No TV"]],
  ["Do you think AI will make life better overall?", ["Better","Worse","Not sure"]],
  ["Would you rather have no homework or no exams?", ["No homework","No exams"]],
  ["Tea or coffee?", ["Tea","Coffee","Neither"]],
  ["Would you live 200 years if you could?", ["Yes","No"]],
  ["Would you rather be the funniest or the smartest person in the room?", ["Funniest","Smartest"]],
  ["Should the minimum age for social media be 16?", ["Yes","No"]],
  ["Do you make your bed every morning?", ["Yes","No"]],
  ["Would you rather time travel to the past or the future?", ["Past","Future"]],
  ["Is it better to rent or to own a home?", ["Rent","Own"]],
  ["Would you eat bugs to save the planet?", ["Yes","No"]],
  ["Do you sleep with socks on?", ["Yes","No"]],
  ["Would you rather work from home or in an office?", ["Home","Office"]],
  ["Should we bring back extinct animals like the mammoth?", ["Yes","No"]],
  ["Would you rather have a rewind button or a pause button for your life?", ["Rewind","Pause"]],
  ["Are you happier today than a year ago?", ["Happier","Same","Less happy"]]
];

const COUNTRIES = {US:"United States",IN:"India",BR:"Brazil",ID:"Indonesia",NG:"Nigeria",PK:"Pakistan",MX:"Mexico",PH:"Philippines",GB:"United Kingdom",DE:"Germany",FR:"France",ES:"Spain",IT:"Italy",CA:"Canada",AU:"Australia",JP:"Japan",KR:"South Korea",CN:"China",RU:"Russia",TR:"Turkey",EG:"Egypt",ZA:"South Africa",KE:"Kenya",GH:"Ghana",AR:"Argentina",CO:"Colombia",PE:"Peru",CL:"Chile",VN:"Vietnam",TH:"Thailand",MY:"Malaysia",BD:"Bangladesh",SA:"Saudi Arabia",AE:"UAE",PL:"Poland",NL:"Netherlands",SE:"Sweden",UA:"Ukraine",NZ:"New Zealand",IE:"Ireland",JM:"Jamaica",XX:"Somewhere else"};

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const START = Date.UTC(2026,10,17); // Question #1
const DAY_MS = 86400000;
const dayNum = () => Math.floor((Date.now() - START) / DAY_MS);
const dayKey = n => new Date(START + n*DAY_MS).toISOString().slice(0,10);
const qFor = n => QUESTIONS[((n % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length];
const flag = cc => cc === "XX" ? "🌍" : String.fromCodePoint(...[...cc].map(c => 127397 + c.charCodeAt(0)));
const store = {
  get(k, d){ try{ const v = localStorage.getItem("es_"+k); return v == null ? d : JSON.parse(v);}catch{ return d; } },
  set(k, v){ try{ localStorage.setItem("es_"+k, JSON.stringify(v)); }catch{} }
};
function toast(msg){ const t=$("toast"); t.textContent=msg; t.hidden=false; requestAnimationFrame(()=>t.classList.add("show")); clearTimeout(toast.h); toast.h=setTimeout(()=>{ t.classList.remove("show"); setTimeout(()=>{ if(!t.classList.contains("show")) t.hidden=true; },250); },2400); }
function voterId(){ let id=store.get("id"); if(!id){ id=(crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()); store.set("id",id);} return id; }
function emptyTally(n){ return { total:0, counts:Array(n).fill(0), byCountry:{} }; }
function addTo(t, choice, cc){ if(choice<0||choice>=t.counts.length) return; t.total++; t.counts[choice]++; (t.byCountry[cc] ||= Array(t.counts.length).fill(0))[choice]++; }

// ---------- Backends: Supabase (public), Claude shared data (preview), or this device only ----------
const backends = {
  supabase(){
    const h = { apikey: CONFIG.supabaseKey, Authorization: "Bearer "+CONFIG.supabaseKey, "Content-Type":"application/json" };
    const base = CONFIG.supabaseUrl.replace(/\/$/,"") + "/rest/v1";
    return {
      label: "Live: answers from everyone who opens this link.",
      me: codeFrom(voterId()),
      async friendVotes(codes){
        if (!codes.length) return {};
        const r = await fetch(base+"/rpc/friend_votes", { method:"POST", headers:h, body: JSON.stringify({codes}) });
        const out = {}; for (const row of await r.json()) (out[row.code] ||= {})[row.day] = row.choice; return out;
      },
      async vote(day, choice, cc){
        const r = await fetch(base+"/votes", { method:"POST", headers:{...h, Prefer:"resolution=ignore-duplicates"}, body: JSON.stringify({day, voter: voterId(), code: codeFrom(voterId()), choice, country: cc}) });
        if(!r.ok && r.status !== 409) throw new Error("vote failed");
      },
      async suggest(question, answers){
        const r = await fetch(base+"/suggestions", { method:"POST", headers:h, body: JSON.stringify({question, answers, voter: voterId()}) });
        if(!r.ok) throw new Error("suggest failed");
      },
      watch(day, n, cb){
        const load = async () => {
          try{
            const r = await fetch(base+"/rpc/tally", { method:"POST", headers:h, body: JSON.stringify({d: day}) });
            const rows = await r.json(); const t = emptyTally(n);
            for(const row of rows) for(let i=0;i<row.n;i++) addTo(t, row.choice, row.country);
            cb(t);
          }catch{}
        };
        load(); setInterval(load, 15000);
      }
    };
  },
  claude(db, uid){
    const cache = {}; const subs = []; const byCode = {}; const me = codeFrom(uid);
    db.collection("votes").onSnapshot(snap => {
      for(const k in cache) delete cache[k];
      for(const k in byCode) delete byCode[k];
      for(const d of snap.docs){ const data=d.data()||{}, v=data.v||{}; if (data.code){ byCode[data.code] = {}; for (const day in v) byCode[data.code][day] = v[day][0]; } for(const day in v){ (cache[day] ||= []).push(v[day]); } }
      subs.forEach(f => f());
    }, () => {});
    return {
      label: "Preview: shared live with everyone you send this page to.",
      me,
      async friendVotes(codes){ const o = {}; for (const c of codes) if (byCode[c]) o[c] = byCode[c]; return o; },
      async vote(day, choice, cc){
        const ref = db.doc("votes/"+uid); const s = await ref.get();
        const v = (s.exists && (s.data()||{}).v) || {};
        if(v[day]) return; v[day] = [choice, cc]; await ref.set({ v, code: me });
      },
      watch(day, n, cb){
        const f = () => { const t = emptyTally(n); for(const [c,cc] of (cache[day]||[])) addTo(t,c,cc); cb(t); };
        subs.push(f); f();
      }
    };
  },
  local(){
    const all = store.get("localVotes", {});
    const subs = {};
    return {
      label: "Demo mode: answers stay on this device until the app is connected to its database.",
      me: codeFrom(voterId()),
      async friendVotes(){ return {}; },
      async vote(day, choice, cc){ all[day] = [choice, cc]; store.set("localVotes", all); (subs[day]||[]).forEach(f=>f()); },
      watch(day, n, cb){ const f = () => { const t=emptyTally(n); if(all[day]) addTo(t, all[day][0], all[day][1]); cb(t); }; (subs[day] ||= []).push(f); f(); }
    };
  }
};

async function pickBackend(){
  if (CONFIG.supabaseUrl && CONFIG.supabaseKey) return backends.supabase();
  if (window.claude && window.claude.use){
    try{
      const timeout = new Promise(r => setTimeout(() => r(null), 6000));
      const db = await Promise.race([window.claude.use("db"), timeout]);
      const user = db && await Promise.race([window.claude.use("user"), timeout]);
      const uid = user && await user.id();
      if (db && uid) return Object.assign(backends.claude(db, uid), { ask: askClaude(db, uid) });
    }catch{}
  }
  return Object.assign(backends.local(), { ask: askLocal() });
}

// iPhone (iOS 18+): Safari gives a real haptic tick when a hidden switch toggles from a tap. Android: the Vibration API.
const iosTick = (() => {
  try{
    const l = document.createElement("label"); l.setAttribute("aria-hidden", "true");
    l.style.cssText = "position:fixed;left:-20px;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none";
    const i = document.createElement("input"); i.type = "checkbox"; i.setAttribute("switch", ""); i.tabIndex = -1;
    l.appendChild(i); document.body.appendChild(l); return () => l.click();
  }catch{ return () => {}; }
})();
function haptic(pattern){
  try{
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (navigator.vibrate) { navigator.vibrate(pattern); return; }
    iosTick();
    if (Array.isArray(pattern) && pattern.length > 2) setTimeout(iosTick, 90);
  }catch{}
}
function countUp(el, to, suffix){
  if (matchMedia("(prefers-reduced-motion: reduce)").matches){ el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 750;
  const step = now => { const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = Math.round(to * e) + suffix; if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------- Streaks with freezes ----------
// You earn a streak freeze every 7 days in a row (hold up to 2). A missed day uses one automatically.
function streakNow(){
  const s = store.get("streakState", { last:-99, streak:0, freezes:0, best:0 });
  const gap = today - s.last - 1; // days missed since last answer (ignoring today)
  const alive = s.last === today || gap <= s.freezes;
  return { ...s, alive, current: alive ? s.streak : 0, gap };
}
function bumpStreak(){
  const s = streakNow(); let used = 0;
  if (s.last === today) return;
  if (s.alive && s.last > -99){ used = Math.max(0, s.gap); s.freezes -= used; s.streak += 1; } else s.streak = 1;
  if (s.streak % 7 === 0) s.freezes = Math.min(2, s.freezes + 1);
  s.last = today; s.best = Math.max(s.best, s.streak);
  store.set("streakState", { last:s.last, streak:s.streak, freezes:s.freezes, best:s.best });
  if (used) toast("Streak freeze used. Your " + s.streak + "-day streak is safe.");
  else if (s.streak % 7 === 0) toast(s.streak + " days! You earned a streak freeze.");
}

function recapData(){
  const days = []; for (let n = today; n > today-7; n--) if (myVotes[dayKey(n)]) days.push(n);
  if (!days.length) return null;
  const withShare = days.filter(n => typeof myVotes[dayKey(n)].share === "number");
  const rarest = withShare.sort((a,b)=>myVotes[dayKey(a)].share - myVotes[dayKey(b)].share)[0];
  const maj = days.filter(n => (myVotes[dayKey(n)].share ?? 0) >= 50).length;
  return { answered: days.length, maj, rarest, s: streakNow().current };
}

const HIDE_AT = 3; // reports needed to hide a post for everyone
function codeFrom(s){ let h=2166136261; for(const c of String(s)){ h^=c.charCodeAt(0); h=Math.imul(h,16777619)>>>0; } const A="ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let o=""; for(let i=0;i<6;i++){ o+=A[h%32]; h=Math.floor(h/32)^(i*7919); h>>>=0; } return o; }
const norm = s => String(s||"").trim().toLowerCase();
// Topics people can search and browse. A post's topic is guessed from its words.
const TOPICS = [
  ["school", "School", /school|class|teacher|homework|\btests?\b|exam|college|grades?\b|summer break/i, 4],
  ["food", "Food", /food|\beat|pizza|burger|taco|cereal|pineapple|breakfast|lunch|dinner|snack|drink|coffee|fries|ketchup|chicken/i, 6],
  ["style", "Style", /hair|outfit|\bfit\b|shoes|sneaker|socks|sandals|\bwear|style|jacket|nails|drip|tattoo|clothes/i, 5],
  ["dating", "Dating", /\bdate|dating|crush|text(ing)? back|boyfriend|girlfriend|relationship|\bex\b|love|situationship/i, 1],
  ["sports", "Sports", /\bnba\b|\bnfl\b|soccer|football|basketball|baseball|\bteam\b|\bgoat\b|lebron|messi|sport|gym/i, 2],
  ["music", "Music", /song|music|album|rapper|artist|concert|playlist|spotify|\bbeat\b/i, 0],
  ["money", "Money", /money|\$|rich|\bjob\b|\bwork|\bpay|\btip|\bbuy|price|expensive|save|billion|million/i, 7],
  ["tech", "Tech", /phone|iphone|android|\bai\b|\bapps?\b|gaming|video game|tiktok|instagram|internet|online|robot/i, 3],
  ["rather", "Would you rather", /would you rather|\brather\b/i, 4],
  ["takes", "Hot takes", /overrated|underrated|hot take|unpopular|honestly|lowkey|highkey/i, 1]
];
const catOf = text => { const t = TOPICS.find(([, , re]) => re.test(text || "")); return t ? t[0] : "takes"; };

function combinePosts(postDocs, voteDocs, reportDocs, commentDocs, photoDocs){
  const byId = {}, cById = {};
  for (const items of postDocs) for (const p of items) byId[p.id] = {...p, cat: p.cat || catOf(p.text), yes:0, no:0, reports:0, comments:[]};
  for (const items of (commentDocs||[])) for (const c of items) if (byId[c.post]) cById[c.id] = {...c, reports:0};
  for (const v of voteDocs) for (const id in v) if (byId[id]) { v[id] > 0 ? byId[id].yes++ : byId[id].no++; }
  for (const r of reportDocs) for (const id in r) { if (byId[id]) byId[id].reports++; else if (cById[id]) cById[id].reports++; }
  for (const c of Object.values(cById).sort((a,b)=>a.t-b.t)) byId[c.post].comments.push(c);
  for (const m of (photoDocs||[])) for (const id in m) if (byId[id]) byId[id].imgs = m[id];
  return Object.values(byId).sort((a,b) => b.t - a.t);
}

function askClaude(db, uid){
  const me = codeFrom(uid); const state = { posts:{}, votes:{}, reports:{}, comments:{}, photos:{} }; let cb = () => {};
  const emit = () => cb(combinePosts(Object.values(state.posts), Object.values(state.votes), Object.values(state.reports), Object.values(state.comments), Object.values(state.photos)), state.votes[uid] || {}, state.reports[uid] || {});
  const sub = (name, field, key) => db.collection(name).onSnapshot(s => { state[key] = {}; for (const d of s.docs) state[key][d.id] = (d.data()||{})[field] || (field==="items"?[]:{}); emit(); }, () => {});
  sub("posts","items","posts"); sub("pvotes","v","votes"); sub("reports","r","reports"); sub("comments","items","comments"); sub("photos","m","photos");
  async function merge(name, field, fn){ const ref = db.doc(name+"/"+uid); const s = await ref.get(); const cur = (s.exists && (s.data()||{})[field]) || (field==="items"?[]:{}); await ref.set({[field]: fn(cur)}); }
  return {
    me,
    watch(f){ cb = f; emit(); },
    post: item => merge("posts","items", cur => [...cur, item].slice(-50)),
    // photos live in their own document, newest 5 photo posts per person, so the shared data stays small
    photo: (id, imgs) => merge("photos","m", cur => { const keep = Object.keys(cur).slice(-4); const out = {}; for (const k of keep) out[k] = cur[k]; out[id] = imgs; return out; }),
    comment: item => merge("comments","items", cur => [...cur, item].slice(-200)),
    vote: (id, v) => merge("pvotes","v", cur => ({...cur, [id]: v})),
    report: id => merge("reports","r", cur => ({...cur, [id]: 1}))
  };
}

function askLocal(){
  const me = codeFrom(voterId()); let cb = () => {};
  const S = { posts: store.get("askPosts", []), votes: store.get("askVotes", {}), reports: store.get("askReports", {}), comments: store.get("askComments", []), photos: store.get("askPhotos", {}) };
  const emit = () => cb(combinePosts([S.posts],[S.votes],[S.reports],[S.comments],[S.photos]), S.votes, S.reports);
  return {
    me,
    watch(f){ cb = f; emit(); },
    async post(item){ S.posts.push(item); store.set("askPosts", S.posts); emit(); },
    async photo(id, imgs){ const keep = Object.keys(S.photos).slice(-4); const out = {}; for (const k of keep) out[k] = S.photos[k]; out[id] = imgs; S.photos = out; store.set("askPhotos", out); emit(); },
    async comment(item){ S.comments.push(item); store.set("askComments", S.comments); emit(); },
    async vote(id, v){ S.votes[id] = v; store.set("askVotes", S.votes); emit(); },
    async report(id){ S.reports[id] = 1; store.set("askReports", S.reports); emit(); }
  };
}

// "For you" ranking: posts you haven't judged yet, in topics you care about, still fresh, and splitting people close to 50/50.
function rank(list){
  const catVotes = {};
  for (const p of ask.posts) if (ask.api && (ask.myVotes[p.id] || p.author === ask.api.me)) catVotes[p.cat] = (catVotes[p.cat]||0) + 1;
  const now = Date.now();
  const score = p => {
    const total = p.yes + p.no, hours = (now - p.t) / 3600000;
    const fresh = Math.exp(-hours / 36);                       // fades over a day and a half
    const topic = Math.min(catVotes[p.cat] || 0, 5) * 0.25;   // your interests
    const unseen = ask.myVotes[p.id] || p.author === ask.api.me ? 0 : 1;
    const split = total >= 3 ? 1 - Math.abs(p.yes - p.no) / total : 0; // close calls are interesting
    const talk = Math.log1p(total + 2 * p.comments.length) * 0.3;
    return unseen * 1.5 + fresh * 2 + topic + split * 0.8 + talk;
  };
  return list.map(p => [score(p), p]).sort((a,b) => b[0]-a[0]).map(x => x[1]);
}

// ---------- App state ----------
const today = dayNum(), todayKey = dayKey(today);
const [question, options] = qFor(today);
let myVotes = store.get("myVotes", {});
let tally = emptyTally(options.length), ytally = null;
let backend = null, order = [], animate = null, jumpTo = null, sheetPost = null;
const pct = (n, t) => t ? Math.round(n * 100 / t) : 0;
function guessCountry(){
  const saved = store.get("country"); if (saved) return saved;
  const langs = navigator.languages || [navigator.language || ""];
  for (const l of langs){ const m = /-([A-Z]{2})$/i.exec(l); if (m && COUNTRIES[m[1].toUpperCase()]) return m[1].toUpperCase(); }
  return "XX";
}
const myPlace = () => ({ city: store.get("city", ""), state: store.get("state", ""), country: guessCountry() });
const friends = () => store.get("friends", []);
const SCOPES = [["world","World"],["country","Country"],["state","State"],["city","City"],["friends","Friends"]];
const COLORS = [["#5b3df5","#3d22c7"],["#ff4d4d","#d62a41"],["#0fa968","#07784a"],["#17181a","#000000"],["#2563ff","#1240c4"],["#e0338a","#ad1966"],["#f2730a","#cc4e00"],["#0e8fa3","#066a7c"]];
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const ask = { api: null, posts: [], myVotes: {}, myReports: {}, flipped: {}, scope: store.get("askScope", "world") };
if (!SCOPES.some(([k]) => k === ask.scope)) ask.scope = "world";
const signOf = p => p.yes > p.no ? 1 : p.yes < p.no ? -1 : 0;
const BLOCK = [/\d[\d\s().-]{6,}\d/, /@\w/, /https?:|www\./i, /\b(kill|kys|die)\b/i];
const ICON = {
  comment: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.800 7L4 20l1-4.200A8 8 0 1 1 20 12z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>'
};
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function iact(icon, label, text, fn){ const b = el("button", "iact"); b.innerHTML = ICON[icon]; b.setAttribute("aria-label", label); if (text) b.append(el("span", "", text)); b.onclick = fn; return b; }
function ago(t){ const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; }
function sizeClass(text){ return text.length > 105 ? " s" : text.length > 55 ? " m" : ""; }
document.addEventListener("click", e => { if (e.isTrusted && e.target.closest("button")) haptic(8); }, true);

// ---------- Feed ----------
function visible(p, anyScope){
  const pl = myPlace(), mine = p.author === ask.api.me;
  if ((p.reports >= HIDE_AT && !mine) || ask.myReports[p.id] || (!anyScope && p.scope !== ask.scope)) return false;
  if (p.scope === "friends") return mine || friends().includes(p.author);
  if (p.scope === "city") return p.country === pl.country && norm(p.city) === norm(pl.city) && norm(p.state) === norm(pl.state);
  if (p.scope === "state") return p.country === pl.country && norm(p.state) === norm(pl.state);
  if (p.scope === "country") return p.country === pl.country;
  return true;
}
function placeLabel(p){
  return p.scope === "friends" ? "Friends" : p.scope === "city" ? p.city : p.scope === "state" ? p.state : p.scope === "country" ? COUNTRIES[p.country] : "World";
}
// The order is frozen while you browse, so posts never jump under your thumb. New posts join at the end.
function syncOrder(){
  const vis = ask.api ? ask.posts.filter(visible) : [];
  const ids = new Set(vis.map(p => p.id));
  order = order.filter(id => ids.has(id));
  if (jumpTo && ids.has(jumpTo) && !order.includes(jumpTo)) order.unshift(jumpTo);
  order.push(...rank(vis.filter(p => !order.includes(p.id))).map(p => p.id));
  order = order.slice(0, 40);
}
function currentId(){ const f = $("feed"); if (!f.children.length || !f.clientHeight) return null; const s = f.children[Math.round(f.scrollTop / f.clientHeight)]; return s ? s.dataset.id : null; }

function shell(id, color){ const s = el("section", "slide"); s.dataset.id = id; s.style.background = "radial-gradient(120% 70% at 0% 0%,rgba(255,255,255,.2),rgba(255,255,255,0) 60%),radial-gradient(90% 60% at 100% 100%,rgba(0,0,0,.28),rgba(0,0,0,0) 70%),linear-gradient(165deg," + color[0] + "," + color[1] + ")"; return s; }
function answers(id, labels, results, mineIdx, onTap){
  const box = el("div", "answers" + (labels.length > 2 ? " stack" : ""));
  labels.forEach((label, i) => {
    const done = results !== null, b = el("button", "ans" + (mineIdx === i ? " mine" : ""));
    const fill = el("i", "fill"); b.append(fill, el("span", "alabel", label));
    if (done){
      const p = el("span", "apct"); b.append(p); b.disabled = true;
      const set = () => { fill.style.width = results[i] + "%"; fill.style.height = labels.length > 2 ? "100%" : results[i] + "%"; };
      if (animate === id){ countUp(p, results[i], "%"); requestAnimationFrame(() => requestAnimationFrame(set)); if (mineIdx === i) b.classList.add("pop"); }
      else { p.textContent = results[i] + "%"; set(); }
    } else b.onclick = () => onTap(i);
    box.append(b);
  });
  return box;
}

function verdict(mine){
  const share = pct(tally.counts[mine.choice], tally.total);
  const top = tally.counts.indexOf(Math.max(...tally.counts)), second = [...tally.counts].sort((a, b) => b - a)[1] || 0;
  const close = tally.total >= 4 && Math.abs(pct(tally.counts[top], tally.total) - pct(second, tally.total)) <= 8;
  const main = tally.total < 2 ? "You're the first voice on Earth today." : close ? "Earth is almost perfectly split on this."
    : share < 35 ? "Only " + share + "% of Earth is with you. Rare club." : share >= 75 ? share + "% of Earth agrees with you." : share + "% of Earth is on your side.";
  let sub = ""; const local = tally.byCountry[mine.country];
  if (local && mine.country !== "XX"){ const lt = local.reduce((a, b) => a + b, 0);
    if (lt >= 2) sub = local.indexOf(Math.max(...local)) !== top ? "Plot twist: " + COUNTRIES[mine.country] + " went the other way." : COUNTRIES[mine.country] + " is " + pct(local[mine.choice], lt) + "% with you."; }
  if (tally.total >= 2){ mine.share = share; mine.majority = tally.counts[mine.choice] === Math.max(...tally.counts); store.set("myVotes", myVotes); }
  return [main, sub];
}
function nextIn(){ const left = START + (today + 1) * DAY_MS - Date.now(); return Math.floor(left / 3600000) + "h " + Math.floor(left % 3600000 / 60000) + "m"; }

function dailySlide(){
  const s = shell("daily", COLORS[today % COLORS.length]), mine = myVotes[todayKey], body = el("div", "sbody");
  body.append(el("div", "kicker", "Today's question · No. " + (today + 1)), el("h2", "stext" + sizeClass(question), question));
  if (mine){ const [main, sub] = verdict(mine); body.append(el("p", "sverdict", main)); if (sub) body.append(el("p", "ssub", sub)); }
  const res = mine ? options.map((_, i) => pct(tally.counts[i], tally.total)) : null;
  const foot = el("div", "sfoot"), nc = Object.keys(tally.byCountry).length;
  const info = el("span", "", mine ? "Next question in " + nextIn() : tally.total ? tally.total.toLocaleString() + (tally.total === 1 ? " person" : " people") + " answered. Tap to see the verdict." : "Be the first on Earth to answer.");
  if (mine) info.id = "nextIn";
  foot.append(info); const acts = el("div", "sacts");
  if (mine) acts.append(iact("share", "Share", "Share", shareDaily));
  foot.append(acts);
  s.append(body, answers("daily", options, res, mine ? mine.choice : -1, vote), foot);
  if (mine && animate === "daily"){ const h = el("div", "hint", "Swipe up for more"); s.append(h); }
  return s;
}
function yesterdaySlide(){
  const [yq, yo] = qFor(today - 1), s = shell("yday", COLORS[(today + 7) % COLORS.length]), body = el("div", "sbody"), mine = myVotes[dayKey(today - 1)];
  body.append(el("div", "kicker", "Yesterday's final verdict"), el("h2", "stext" + sizeClass(yq), yq));
  const foot = el("div", "sfoot"); foot.append(el("span", "", ytally.total.toLocaleString() + " answers")); foot.append(el("div", "sacts"));
  s.append(body, answers("yday", yo, yo.map((_, i) => pct(ytally.counts[i], ytally.total)), mine ? mine.choice : -1, () => {}), foot);
  return s;
}
function postSlide(p){
  const mine = p.author === ask.api.me, my = ask.myVotes[p.id], total = p.yes + p.no, show = mine || !!my, yes = pct(p.yes, total);
  const s = shell(p.id, COLORS[(typeof p.color === "number" ? p.color : hash(p.id)) % COLORS.length]), body = el("div", "sbody");
  body.append(el("div", "kicker", [placeLabel(p), ago(p.t), mine ? "Your post" : "", ask.flipped[p.id] ? "Flipped since you voted" : ""].filter(Boolean).join(" · ")));
  const imgs = p.imgs || [], duo = imgs.length === 2, labels = duo ? ["This one", "That one"] : ["Yes", "No"];
  const tap = i => mine ? toast("You can't vote on your own post.") : votePost(p.id, i === 0 ? 1 : -1);
  if (imgs.length === 1){ s.classList.add("photo"); const im = el("img", "pbg"); im.src = imgs[0]; im.alt = ""; s.append(im); }
  if (duo){ s.classList.add("duo"); const g = el("div", "duo-imgs");
    imgs.forEach((src, i) => { const b = el("button", my && (my > 0 ? 0 : 1) === i ? "mine" : ""), im = el("img"); im.src = src; im.alt = labels[i]; b.append(im); b.setAttribute("aria-label", labels[i]); if (show) b.disabled = true; else b.onclick = () => tap(i); g.append(b); });
    s.append(g); }
  body.append(el("h2", "stext" + (imgs.length ? " s" : sizeClass(p.text)), p.text));
  const close = total >= 4 && Math.abs(yes - 50) <= 10;
  if (show){ const v = !total ? "Waiting for the first verdict." : close ? "Split " + yes + "/" + (100 - yes) + ". Could go either way." : total >= 3 && yes >= 75 ? (duo ? "This one is winning." : "People are into it.") : total >= 3 && yes <= 25 ? (duo ? "That one is winning." : "People say no.") : ""; if (v) body.append(el("p", "sverdict", v)); }
  const foot = el("div", "sfoot");
  foot.append(el("span", "", show ? total + (total === 1 ? " vote" : " votes") : !total ? "Be the first to judge." : close ? "This one is splitting people. Tap to see." : total + (total === 1 ? " person" : " people") + " voted. Tap to see the verdict."));
  const live = liveComments(p), nC = live.length, acts = el("div", "sacts");
  if (show && nC){ const last = live[live.length - 1], pk = el("button", "peek"); pk.append(el("b", "", whoSaid(last)), el("span", "", last.text)); pk.onclick = () => openSheet(p.id); pk.setAttribute("aria-label", "Open comments"); body.append(pk); }
  acts.append(iact("comment", "Comments", nC ? String(nC) : "", () => openSheet(p.id)));
  if (!mine) acts.append(iact("flag", "Report", "", () => report(p.id)));
  foot.append(acts);
  s.append(body, answers(p.id, labels, show && total ? [yes, 100 - yes] : null, my ? (my > 0 ? 0 : 1) : -1, tap), foot);
  return s;
}
function endSlide(){
  const s = el("section", "slide end"); s.dataset.id = "end"; const body = el("div", "sbody"), pl = myPlace();
  let h = "You're all caught up.", sub = "Come back later for more, or put something up for a verdict.", cta = ["Post something", openCompose];
  if (!ask.api){ sub = "Posts from people are coming soon. A new question drops in " + nextIn() + "."; cta = null; }
  else if ((ask.scope === "city" && (!pl.city || !pl.state)) || (ask.scope === "state" && !pl.state)){ h = "Where are you?"; sub = "Add your city and state to see what people near you really think."; cta = ["Set my place", () => showPage("me")]; }
  else if (ask.scope === "friends" && !friends().length){ h = "No friends here yet."; sub = "Swap codes with a friend and judge each other's posts."; cta = ["Add a friend", () => showPage("me")]; }
  else if (!order.length && ask.scope !== "world"){ h = "Nothing here yet."; sub = "Be the first one to ask."; }
  body.append(el("h2", "stext m", h), el("p", "ssub", sub));
  if (cta){ const b = el("button", "cta", cta[0]); b.onclick = cta[1]; body.append(b); }
  s.append(body); return s;
}
function renderFeed(){
  const feed = $("feed"), cur = jumpTo || currentId();
  syncOrder(); feed.innerHTML = "";
  if (ask.scope === "world"){ feed.append(dailySlide()); if (ytally && ytally.total) feed.append(yesterdaySlide()); }
  const byId = Object.fromEntries(ask.posts.map(p => [p.id, p]));
  for (const id of order) feed.append(postSlide(byId[id]));
  feed.append(endSlide());
  const keep = cur && [...feed.children].find(s => s.dataset.id === cur);
  feed.scrollTop = keep ? keep.offsetTop : 0;
  if (keep && jumpTo === cur) jumpTo = null;
  if (seen) { seen.disconnect(); for (const sl of feed.children) seen.observe(sl); }
  animate = null;
}
// Text eases in the first time each post comes into view. Posts are fully visible without it.
const shown = new Set();
const seen = "IntersectionObserver" in window ? new IntersectionObserver(es => { for (const e of es) if (e.isIntersecting && e.intersectionRatio > .6 && !shown.has(e.target.dataset.id)){ shown.add(e.target.dataset.id); if (shown.size > 1) e.target.classList.add("in"); } }, { threshold: .6 }) : null;
function renderTop(){
  const box = $("scopes"); box.innerHTML = "";
  SCOPES.forEach(([k, l]) => { const b = el("button", "scope" + (k === ask.scope ? " on" : ""), l); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", k === ask.scope);
    b.onclick = () => { ask.scope = k; store.set("askScope", k); order = []; renderTop(); renderFeed(); $("feed").scrollTop = 0; }; box.append(b); });
}

// ---------- Actions ----------
async function vote(i){
  const cc = guessCountry(); myVotes[todayKey] = { choice: i, country: cc }; store.set("myVotes", myVotes); bumpStreak();
  addTo(tally, i, cc); haptic([14, 30, 20]); animate = "daily"; renderFeed(); checkBadges();
  try{ await backend.vote(todayKey, i, cc); }catch{ toast("Couldn't save your answer online. Check your connection."); }
}
async function votePost(id, v){
  ask.myVotes = { ...ask.myVotes, [id]: v }; const p = ask.posts.find(x => x.id === id);
  if (p){ v > 0 ? p.yes++ : p.no++; const signs = store.get("askSigns", {}); signs[id] = signOf(p) || v; store.set("askSigns", signs); }
  haptic([14, 30, 20]); animate = id; renderFeed();
  try{ await ask.api.vote(id, v); }catch{ toast("Couldn't save your vote. Try again."); }
}
async function report(id){ ask.myReports = { ...ask.myReports, [id]: 1 }; toast("Reported. It's hidden for you."); renderFeed(); if (sheetPost) renderSheet(); try{ await ask.api.report(id); }catch{} }
function checkFlips(){ const signs = store.get("askSigns", {}); for (const p of ask.posts) if (ask.myVotes[p.id] && signs[p.id] && p.yes + p.no >= 4){ const s = signOf(p); if (s && s !== signs[p.id]) ask.flipped[p.id] = true; } }
async function copyOrShow(text, okMsg){
  try{ await navigator.clipboard.writeText(text); toast(okMsg); }
  catch{ sheetPost = null; $("stitle").textContent = "Copy this"; $("clist").hidden = true; $("cform").hidden = true; const b = $("shareBox"); b.hidden = false; b.value = text; $("sheet").hidden = false; b.focus(); b.select(); }
}
function shareDaily(){
  const mine = myVotes[todayKey]; if (!mine) return;
  const url = CONFIG.siteUrl || location.href.split("#")[0];
  copyOrShow("Verd #" + (today + 1) + "\n" + question + "\nI'm with " + pct(tally.counts[mine.choice], tally.total) + "% of Earth. What's your Verd? (No peeking before you answer.)\n" + streakNow().current + " day streak\n" + url, "Copied. Paste it in your group chat.");
}

// ---------- Comments ----------
const liveComments = p => p.comments.filter(c => (c.reports < HIDE_AT || c.author === ask.api.me) && !ask.myReports[c.id]);
const whoSaid = c => c.author === ask.api.me ? "You" : friends().includes(c.author) ? c.author : "Someone";
const sideLabels = p => (p.imgs || []).length === 2 ? ["This one", "That one"] : ["Yes", "No"];
function openSheet(id){ sheetPost = id; $("stitle").textContent = "Comments"; $("clist").hidden = false; $("cform").hidden = false; $("shareBox").hidden = true; renderSheet(); $("sheet").hidden = false; }
function closeSheet(){ $("sheet").hidden = true; sheetPost = null; }
function renderSheet(){
  const p = ask.posts.find(x => x.id === sheetPost), box = $("clist"); if (!p) return; box.innerHTML = "";
  const list = liveComments(p), lab = sideLabels(p), my = ask.myVotes[p.id], total = p.yes + p.no;
  $("stitle").textContent = list.length ? list.length + (list.length === 1 ? " comment" : " comments") : "Comments";
  $("ssubt").textContent = (my || p.author === ask.api.me) && total ? lab[0] + " " + pct(p.yes, total) + "% · " + lab[1] + " " + (100 - pct(p.yes, total)) + "%" : "Vote first, then say why.";
  $("cinput").placeholder = my ? "Why did you pick " + lab[my > 0 ? 0 : 1] + "?" : p.author === ask.api.me ? "Add to the debate" : "Vote to join the debate";
  if (!list.length) box.append(el("p", "note", "No comments yet. Start the debate."));
  for (const c of list){ const row = el("div", "cmt"), head = el("div", "chead");
    head.append(el("b", "", whoSaid(c)));
    if (c.side === 0 || c.side === 1) head.append(el("i", c.side === 0 ? "a" : "", lab[c.side]));
    if (c.t) head.append(el("span", "", ago(c.t)));
    if (c.author !== ask.api.me){ const r = el("button", "lnk", "Report"); r.onclick = () => report(c.id); head.append(r); }
    row.append(head, el("p", "", c.text)); box.append(row); }
}
$("sclose").onclick = closeSheet;
$("sheet").onclick = e => { if (e.target === $("sheet")) closeSheet(); };
$("cform").onsubmit = async e => {
  e.preventDefault(); const text = $("cinput").value.trim(); if (text.length < 2 || !sheetPost) return;
  if (BLOCK.some(r => r.test(text))){ toast("Leave out phone numbers, @handles, links and threats."); return; }
  const pp = ask.posts.find(x => x.id === sheetPost), my = ask.myVotes[sheetPost];
  if (!my && !(pp && pp.author === ask.api.me)){ toast("Vote first, then say why."); return; }
  const item = { id: "c-" + ask.api.me + "-" + Date.now().toString(36), post: sheetPost, author: ask.api.me, text, t: Date.now() };
  if (my) item.side = my > 0 ? 0 : 1;
  const p = ask.posts.find(x => x.id === sheetPost); if (p) p.comments.push({ ...item, reports: 0 });
  $("cinput").value = ""; renderSheet(); renderFeed();
  try{ await ask.api.comment(item); store.set("commented", true); checkBadges(); }catch{ toast("Couldn't send your comment. Try again."); }
};

// ---------- New post ----------
let cColor = 0, cScope = "world", cPhotos = [];
// Shrinks a photo in the browser so it loads fast and stays small.
function shrink(file){
  return new Promise((ok, fail) => { const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, 640 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); ok(c.toDataURL("image/jpeg", .7)); };
    img.onerror = () => { URL.revokeObjectURL(url); fail(); }; img.src = url; });
}
$("pfile").onchange = async e => {
  for (const f of [...e.target.files].slice(0, 2 - cPhotos.length)){ try{ cPhotos.push(await shrink(f)); }catch{ toast("That photo couldn't be opened."); } }
  e.target.value = ""; if (cPhotos.length) cScope = "friends"; drawCompose();
};
function openCompose(prefill){
  if (!ask.api){ toast("Posting opens soon."); return; }
  cColor = Math.floor(Math.random() * COLORS.length); cScope = ask.scope; cPhotos = []; drawCompose(); $("compose").hidden = false;
  if (typeof prefill === "string") $("ptext").value = prefill; $("ptext").focus();
}
function drawCompose(){
  $("compose").style.background = "radial-gradient(120% 70% at 0% 0%,rgba(255,255,255,.2),rgba(255,255,255,0) 60%),linear-gradient(165deg," + COLORS[cColor][0] + "," + COLORS[cColor][1] + ")";
  const sw = $("swatches"); sw.innerHTML = "";
  COLORS.forEach((c, i) => { const b = el("button", "sw" + (i === cColor ? " on" : "")); b.style.background = c[0]; b.setAttribute("aria-label", "Color " + (i + 1)); b.onclick = () => { cColor = i; drawCompose(); }; sw.append(b); });
  const au = $("aud"); au.innerHTML = "";
  SCOPES.forEach(([k, l]) => { const b = el("button", k === cScope ? "on" : "", l); b.disabled = cPhotos.length > 0 && k !== "friends"; b.onclick = () => { cScope = k; drawCompose(); }; au.append(b); });
  const th = $("thumbs"); th.innerHTML = "";
  cPhotos.forEach((src, i) => { const t = el("div", "thumb"), im = el("img"); im.src = src; im.alt = "Photo " + (i + 1); const x = el("button", "", "×"); x.setAttribute("aria-label", "Remove photo"); x.onclick = () => { cPhotos.splice(i, 1); drawCompose(); }; t.append(im, x); th.append(t); });
  if (cPhotos.length < 2){ const a = el("button", "addp"); a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'; a.setAttribute("aria-label", "Add a photo"); a.onclick = () => $("pfile").click(); th.append(a); }
  $("compose").classList.toggle("haspic", cPhotos.length > 0); $("colorRow").hidden = cPhotos.length > 0;
  $("ptext").placeholder = cPhotos.length === 2 ? "Which one?" : cPhotos.length === 1 ? "Yes or no?" : "What do you want a verdict on?";
  $("cnote").textContent = cPhotos.length === 2 ? "Friends pick This one or That one. Photo posts go to friends only for now."
    : cPhotos.length === 1 ? "Friends answer Yes or No. Photo posts go to friends only for now."
    : "People answer Yes or No. No names, phone numbers or anything mean about a real person.";
}
$("cclose").onclick = () => { $("compose").hidden = true; };
$("psend").onclick = async () => {
  let text = $("ptext").value.trim().replace(/\s+/g, " "); const pl = myPlace(), imgs = cPhotos.slice();
  if (imgs.length && !text) text = imgs.length === 2 ? "Which one?" : "Yes or no?";
  if (imgs.length && !friends().length){ toast("Add a friend on your profile first. Photo posts go to friends."); return; }
  if (text.length < 4){ toast("Write a little more."); return; }
  if (BLOCK.some(r => r.test(text))){ toast("Leave out phone numbers, @handles, links and threats."); return; }
  if ((cScope === "city" && (!pl.city || !pl.state)) || (cScope === "state" && !pl.state)){ toast("Add your city and state on the Me page first."); return; }
  const item = { id: ask.api.me + "-" + Date.now().toString(36), author: ask.api.me, text, color: cColor, photos: imgs.length, cat: catOf(text), scope: imgs.length ? "friends" : cScope, city: pl.city, state: pl.state, country: pl.country, t: Date.now() };
  $("psend").disabled = true;
  try{
    if (ask.scope !== item.scope){ ask.scope = item.scope; store.set("askScope", item.scope); order = []; renderTop(); }
    jumpTo = item.id; if (imgs.length) await ask.api.photo(item.id, imgs); await ask.api.post(item); store.set("posted", true);
    $("ptext").value = ""; $("compose").hidden = true; showPage("feed"); renderFeed(); toast("Posted."); checkBadges();
  }catch{ jumpTo = null; toast("Couldn't post. Check your connection and try again."); }
  $("psend").disabled = false;
};

// ---------- Me ----------
function profile(){
  const days = Object.keys(myVotes).filter(d => typeof myVotes[d].share === "number");
  const avg = days.length ? days.reduce((a, d) => a + myVotes[d].share, 0) / days.length : null;
  return { type: days.length < 3 ? null : avg < 40 ? "Rare thinker" : avg <= 60 ? "Free thinker" : "Mainstream", nTyped: days.length, nAnswered: Object.keys(myVotes).length,
    judged: days.length, maj: days.filter(d => myVotes[d].majority).length };
}
const BADGES = [
  ["first", "First answer", p => p.nAnswered >= 1], ["s3", "3-day streak", () => streakNow().best >= 3], ["s7", "7-day streak", () => streakNow().best >= 7],
  ["s30", "30-day streak", () => streakNow().best >= 30], ["rare", "Rare club", () => Object.values(myVotes).some(v => v.share < 35)], ["ten", "10 answers", p => p.nAnswered >= 10],
  ["poster", "First post", () => store.get("posted", false)], ["talker", "First comment", () => store.get("commented", false)], ["crew", "Added a friend", () => friends().length > 0]
];
function checkBadges(){
  const had = store.get("badges", []), p = profile(); let fresh = null;
  for (const [id, label, test] of BADGES) if (test(p) && !had.includes(id)){ had.push(id); fresh = label; }
  if (fresh){ store.set("badges", had); if (had.length > 1){ setTimeout(() => toast("New badge: " + fresh), 1400); } }
}
function renderMe(){
  const s = streakNow(), p = profile();
  $("meta").textContent = "No. " + (today + 1);
  $("streak").textContent = s.current;
  $("streakNote").textContent = !myVotes[todayKey] && s.current > 0 ? "Answer today to keep it alive." + (s.freezes ? " " + s.freezes + " freeze" + (s.freezes > 1 ? "s" : "") + " saved." : "")
    : s.freezes ? s.freezes + " streak freeze" + (s.freezes > 1 ? "s" : "") + " saved. A freeze covers one missed day." : "Answer every day. Seven in a row earns a streak freeze.";
  $("otype").textContent = p.type || "–";
  $("otypeNote").textContent = p.type ? "your opinion type" : "opinion type, " + (3 - p.nTyped) + " more to unlock";
  $("agree").textContent = p.judged ? p.maj + "/" + p.judged : "–";
  $("answered").textContent = p.nAnswered;
  const box = $("badges"); box.innerHTML = "";
  for (const [, label, test] of BADGES) box.append(el("span", test(p) ? "" : "off", label));
  const r = recapData(), rb = $("recapBody"); $("recap").hidden = !r || r.answered < 2; rb.innerHTML = "";
  if (r){ const row = (a, b) => { const d = el("div"); d.append(el("b", "", a), el("span", "", b)); rb.append(d); };
    row("Days answered", r.answered + " of 7"); row("With the majority", r.maj + " of " + r.answered); row("Streak", r.s + (r.s === 1 ? " day" : " days"));
    if (r.rarest !== undefined){ const v = myVotes[dayKey(r.rarest)], [q, o] = qFor(r.rarest); row("Rarest take", o[v.choice] + ", " + v.share + "%"); } }
  renderFriends();
}
async function renderFriends(){
  const fl = friends(), box = $("flist"); let theirs = {};
  try{ if (backend && fl.length) theirs = await backend.friendVotes(fl); }catch{}
  box.innerHTML = ""; const mine = {}; for (const d in myVotes) mine[d] = myVotes[d].choice;
  fl.map(c => { const t = theirs[c] || {}, both = Object.keys(t).filter(d => d in mine), same = both.filter(d => t[d] === mine[d]).length; return { c, n: both.length, m: both.length ? pct(same, both.length) : null, today: t[todayKey] }; })
    .sort((a, b) => (b.m ?? -1) - (a.m ?? -1))
    .forEach(r => { const d = el("div"); d.append(el("b", "", r.c), el("span", "", r.m === null ? (r.today !== undefined ? "Answered today" : "No shared answers yet") : (r.m >= 80 ? "Same brain, " : r.m <= 30 ? "Opposites, " : "") + r.m + "% match")); box.append(d); });
}
$("recapShare").onclick = () => { const r = recapData(), p = profile(); if (!r) return;
  copyOrShow("My week on Verd\n" + r.answered + "/7 days answered, with the majority " + r.maj + " times\n" + (p.type ? "I'm a " + p.type + ". " : "") + r.s + " day streak\nWhat are you? " + (CONFIG.siteUrl || location.href.split("#")[0]), "Copied. Post it anywhere."); };
$("copycode").onclick = () => copyOrShow($("mycode").textContent, "Code copied. Send it to a friend.");
$("fform").onsubmit = e => { e.preventDefault(); const c = $("fcode").value.trim().toUpperCase(), me = $("mycode").textContent;
  if (!/^[A-Z0-9]{6}$/.test(c)){ toast("Friend codes are 6 letters and numbers."); return; } if (c === me){ toast("That's your own code."); return; }
  const f = friends(); if (!f.includes(c)) f.push(c); store.set("friends", f); $("fcode").value = ""; toast("Friend added."); checkBadges(); renderMe(); order = []; renderFeed(); };
function setupPlace(){
  const sel = $("country");
  Object.entries(COUNTRIES).sort((a, b) => a[0] === "XX" ? 1 : b[0] === "XX" ? -1 : a[1].localeCompare(b[1])).forEach(([cc, name]) => sel.add(new Option(flag(cc) + "  " + name, cc)));
  sel.value = guessCountry(); $("mycity").value = store.get("city", ""); $("mystate").value = store.get("state", "");
  const changed = () => { order = []; renderFeed(); };
  sel.onchange = () => { store.set("country", sel.value); changed(); };
  $("mycity").onchange = () => { store.set("city", $("mycity").value.trim()); changed(); };
  $("mystate").onchange = () => { store.set("state", $("mystate").value.trim()); changed(); };
}

// ---------- Search ----------
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>';
const grad = c => "radial-gradient(120% 80% at 0% 0%,rgba(255,255,255,.22),rgba(255,255,255,0) 60%),linear-gradient(160deg," + c[0] + "," + c[1] + ")";
const searchable = () => ask.api ? ask.posts.filter(p => visible(p, true)) : [];
const heat = p => p.yes + p.no + 2 * liveComments(p).length;
function remember(q){ q = q.trim(); if (q.length < 2) return; store.set("recentQ", [q, ...store.get("recentQ", []).filter(x => norm(x) !== norm(q))].slice(0, 8)); }
function highlight(text, words){
  const frag = document.createDocumentFragment(); if (!words.length){ frag.append(text); return frag; }
  const re = new RegExp("(" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
  text.split(re).forEach((part, i) => frag.append(i % 2 ? el("mark", "", part) : part)); return frag;
}
function openPost(id){
  if (id === "daily"){ ask.scope = "world"; store.set("askScope", "world"); order = []; renderTop(); showPage("feed"); renderFeed(); $("feed").scrollTop = 0; return; }
  const p = ask.posts.find(x => x.id === id); if (!p) return;
  ask.scope = p.scope; store.set("askScope", p.scope); order = []; jumpTo = id; renderTop(); showPage("feed"); renderFeed();
}
function resultRow(p, words, onTap){
  const b = el("button", "res"), mini = el("div", "mini"), rb = el("div", "rb");
  mini.style.background = grad(p.colorPair || COLORS[(typeof p.color === "number" ? p.color : hash(p.id)) % COLORS.length]);
  if (p.imgs && p.imgs.length){ const im = el("img"); im.src = p.imgs[0]; im.alt = ""; mini.append(im); } else mini.append(el("span", "", p.badge || "?"));
  const t = el("div", "rt"); t.append(highlight(p.text, words));
  rb.append(t, el("div", "rm", p.meta)); b.append(mini, rb); b.onclick = onTap; return b;
}
const badgeOf = p => { const t = p.yes + p.no; return (ask.myVotes[p.id] || p.author === ask.api.me) && t ? pct(p.yes, t) + "%" : "?"; };
function postMeta(p){
  const total = p.yes + p.no, nC = liveComments(p).length, seenIt = ask.myVotes[p.id] || p.author === ask.api.me, lab = sideLabels(p);
  return [placeLabel(p), total + (total === 1 ? " vote" : " votes"), nC ? nC + (nC === 1 ? " comment" : " comments") : "", seenIt && total ? pct(p.yes, total) + "% " + lab[0] : "Tap to judge"].filter(Boolean).join(" · ");
}
function section(title, action){ const sec = el("div"), h = el("div", "shd"); h.append(el("h3", "", title)); if (action) h.append(action); sec.append(h); return sec; }
function renderSearch(){
  const raw = $("q").value, q = norm(raw), box = $("sres"); box.innerHTML = ""; $("qclear").hidden = !raw;
  const posts = searchable();
  if (!q){
    const recent = store.get("recentQ", []);
    if (recent.length){
      const clr = el("button", "lnk", "Clear"); clr.onclick = () => { store.set("recentQ", []); renderSearch(); };
      const sec = section("Recent", clr);
      for (const r of recent){ const row = el("div", "rrow"); row.innerHTML = CLOCK_ICON; const go = el("span", "", r); go.style.cursor = "pointer"; go.onclick = () => { $("q").value = r; renderSearch(); };
        const x = el("button", "rx", "×"); x.setAttribute("aria-label", "Remove"); x.onclick = () => { store.set("recentQ", recent.filter(y => y !== r)); renderSearch(); }; row.append(go, x); sec.append(row); }
      box.append(sec);
    }
    const stats = TOPICS.map(([id, name, , ci], i) => { const ps = posts.filter(p => p.cat === id); return { id, name, ci, i, n: ps.length, heat: ps.reduce((a, p) => a + heat(p), 0) }; })
      .sort((a, b) => b.heat - a.heat || b.n - a.n || a.i - b.i).slice(0, 6);
    const sec = section("Trending topics"), grid = el("div", "topics");
    stats.forEach((t, i) => { const b = el("button", "topic"); b.style.background = grad(COLORS[t.ci]);
      b.append(el("span", "rk", String(i + 1)), el("b", "", t.name), el("small", "", t.n ? t.n + (t.n === 1 ? " debate" : " debates") : "Be the first"));
      b.onclick = () => { $("q").value = t.name; remember(t.name); renderSearch(); }; grid.append(b); });
    sec.append(grid); box.append(sec);
    const hot = posts.filter(p => heat(p) > 0).sort((a, b) => heat(b) - heat(a)).slice(0, 5);
    if (hot.length){ const hs = section("Hot debates"); for (const p of hot) hs.append(resultRow({ ...p, meta: postMeta(p), badge: badgeOf(p) }, [], () => openPost(p.id))); box.append(hs); }
    return;
  }
  const words = q.split(/\s+/).filter(w => w.length > 0), topic = TOPICS.find(([id, name]) => norm(name) === q || norm(name).startsWith(q) && q.length >= 3 || id === q);
  const hits = posts.map(p => { const t = norm(p.text), m = words.filter(w => t.includes(w)).length, on = topic && p.cat === topic[0];
      return { p, score: (m === words.length ? 10 : m * 2) + (on ? 6 : 0) + Math.log1p(heat(p)) }; })
    .filter(h => h.score >= 6).sort((a, b) => b.score - a.score).map(h => h.p);
  const res = section(topic ? topic[1] : "Results");
  if (words.every(w => norm(question).includes(w)) || (topic && TOPICS.find(([id]) => id === catOf(question))[0] === topic[0])){
    const mine = myVotes[todayKey];
    res.append(resultRow({ id: "daily", text: question, colorPair: COLORS[today % COLORS.length], badge: "No." + (today + 1), meta: "Today's question · " + tally.total.toLocaleString() + " answers" + (mine ? "" : " · Tap to answer") }, topic ? [] : words, () => openPost("daily")));
  }
  for (const p of hits.slice(0, 30)) res.append(resultRow({ ...p, meta: postMeta(p), badge: badgeOf(p) }, topic && !words.some(w => norm(p.text).includes(w)) ? [] : words, () => { remember(raw); openPost(p.id); }));
  if (res.children.length > 1) box.append(res);
  const e = el("div", "sempty");
  e.append(el("h2", "", res.children.length > 1 ? "Got a take on " + raw.trim() + "?" : "Nothing on “" + raw.trim() + "” yet."), el("p", "note", res.children.length > 1 ? "Put it up and let people decide." : "Be the first. Ask it and let people decide."));
  const go = el("button", "b2", "Start a debate"); go.onclick = () => { remember(raw); openCompose(topic ? "" : raw.trim().replace(/\?*$/, "") + "?"); };
  e.append(go); box.append(e);
}
$("q").oninput = renderSearch;
$("q").onkeydown = e => { if (e.key === "Enter"){ remember($("q").value); $("q").blur(); } };
$("qclear").onclick = () => { $("q").value = ""; renderSearch(); $("q").focus(); };
$("qcancel").onclick = () => { $("q").value = ""; showPage("feed"); };

// ---------- Navigation ----------
function showPage(name){
  $("me").hidden = name !== "me"; $("search").hidden = name !== "search"; document.querySelector(".app").classList.toggle("paged", name !== "feed");
  $("navHome").classList.toggle("on", name === "feed"); $("navSearch").classList.toggle("on", name === "search"); $("navMe").classList.toggle("on", name === "me");
  if (name === "search"){ renderSearch(); $("search").scrollTop = 0; setTimeout(() => $("q").focus(), 60); }
  if (name === "me"){ renderMe(); $("me").scrollTop = 0; }
}
$("navSearch").onclick = () => showPage("search");
$("navHome").onclick = () => { if ($("me").hidden && $("search").hidden) $("feed").scrollTo({ top: 0, behavior: "smooth" }); showPage("feed"); };
$("navMe").onclick = () => showPage("me");
$("navPlus").onclick = openCompose;
setInterval(() => { const n = $("nextIn"); if (n) n.textContent = "Next question in " + nextIn(); }, 30000);

(async function start(){
  setupPlace(); renderTop(); renderFeed();
  backend = await pickBackend();
  $("mode").textContent = backend.label; $("mycode").textContent = backend.me;
  if (backend.ask){
    ask.api = backend.ask;
    ask.api.watch((posts, mv, mr) => { ask.posts = posts; ask.myVotes = { ...mv, ...ask.myVotes }; ask.myReports = { ...mr, ...ask.myReports }; checkFlips(); renderFeed(); if (sheetPost) renderSheet(); if (!$("search").hidden) renderSearch(); });
  } else $("navPlus").hidden = true;
  if (backend.suggest){
    $("suggest").hidden = false;
    $("sform").onsubmit = async e => { e.preventDefault();
      const q = $("sq").value.trim(), a = $("sa").value.split(",").map(s => s.trim()).filter(Boolean);
      if (a.length < 2 || a.length > 4){ toast("Give 2 to 4 answers, separated by commas."); return; }
      $("ssend").disabled = true;
      try{ await backend.suggest(q, a); $("sform").reset(); toast("Sent. Watch for it."); }catch{ toast("Couldn't send it. Try again."); }
      $("ssend").disabled = false; };
  }
  backend.watch(todayKey, options.length, t => { const mine = myVotes[todayKey]; if (mine && t.total === 0) addTo(t, mine.choice, mine.country); tally = t; renderFeed(); });
  if (today > 0){
    const yKey = dayKey(today - 1), yo = qFor(today - 1)[1];
    backend.watch(yKey, yo.length, t => { ytally = t; const mine = myVotes[yKey];
      if (mine && t.total >= 2){ mine.majority = t.counts[mine.choice] === Math.max(...t.counts); mine.share = pct(t.counts[mine.choice], t.total); store.set("myVotes", myVotes); }
      renderFeed(); });
  }
  renderFeed(); checkBadges();
})();
