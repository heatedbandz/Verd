import { sum, pct, num, countsOf, shares, leader, dayState, promptLine, verdictMain, lockedLines, pickTeaser, flavor, GUESSES, guessLine, countdown, inDays, FREEZES, NO_STREAK, streakOn, answerOn, streakNote, blockedText, BLOCK_MSG, publicWaitNote } from "./core.js";

// ---------- Settings ----------
// Verd's Supabase project: its Project URL and publishable key (the project's Connect button, or Settings > API Keys).
// The key is meant to be public. setup.sql locks the database so the key can only call safe functions, and
// tests/live-rls.mjs proves it against the real project on GitHub after every change (.github/workflows/live-check.yml).
// Leave both empty and Verd runs on the phone alone, as it did before launch.
const CONFIG = {
  supabaseUrl: "https://zfphqlavepncdoihiugu.supabase.co",
  supabaseKey: "sb_publishable_Ue0OIDULo5ly2vT1FBgcjA_iWX-uuBv",
  siteUrl: "https://heatedbandz.github.io/Verd/",   // GitHub Pages paths are case-sensitive: the repo is "Verd"
  // Minimum votes before a split is shown. The live database has its own copy (app_config);
  // these are only used by the claude.ai preview, which has no database to ask.
  min: { world: 10, country: 30, state: 30, city: 30, friends: 3 }
};
const LIVE = !!(CONFIG.supabaseUrl && CONFIG.supabaseKey);

// ---------- Questions and colours ----------
// They live in index.html (#verd-data) so the page can paint today's question before this file arrives.
// One question a day from "start", in order, then it loops. Two to four answers each, and a topic id (TOPICS below).
const DATA = JSON.parse(document.getElementById("verd-data").textContent);
const QUESTIONS = DATA.questions;

const COUNTRIES = {US:"United States",IN:"India",BR:"Brazil",ID:"Indonesia",NG:"Nigeria",PK:"Pakistan",MX:"Mexico",PH:"Philippines",GB:"United Kingdom",DE:"Germany",FR:"France",ES:"Spain",IT:"Italy",CA:"Canada",AU:"Australia",JP:"Japan",KR:"South Korea",CN:"China",RU:"Russia",TR:"Turkey",EG:"Egypt",ZA:"South Africa",KE:"Kenya",GH:"Ghana",AR:"Argentina",CO:"Colombia",PE:"Peru",CL:"Chile",VN:"Vietnam",TH:"Thailand",MY:"Malaysia",BD:"Bangladesh",SA:"Saudi Arabia",AE:"UAE",PL:"Poland",NL:"Netherlands",SE:"Sweden",UA:"Ukraine",NZ:"New Zealand",IE:"Ireland",JM:"Jamaica",XX:"Somewhere else"};

// ---------- Helpers ----------
const $ = id => document.getElementById(id);
const START = Date.parse(DATA.start + "T00:00:00Z");   // Question #1
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

// ---------- Backends ----------
// Every backend answers with the same results shape, so the screens never care where numbers came from:
// { mode: "live" | "preview" | "device", mine, visible, min: {world, country, state, city},
//   world: {n, counts}, country, state, city }   counts is null until the minimum is met (and you voted).
// "device" means no database: nothing but your own answer is known, and the app says so.
const backends = {
  // Supabase, through its REST API. ~3 KB instead of the 40 KB SDK.
  supabase(){
    const base = CONFIG.supabaseUrl.replace(/\/+$/, ""), key = CONFIG.supabaseKey;
    const now = () => Math.floor(Date.now() / 1000);
    let session = store.get("sb", null), pending = null, flushing = null, stuck = false;
    const subs = new Map();   // dayKey -> { n, place, cbs: Set }
    function keep(s){ session = { at: s.access_token, rt: s.refresh_token, exp: s.expires_at || now() + (s.expires_in || 3600) }; store.set("sb", session); }
    async function auth(path, body){
      const r = await fetch(base + "/auth/v1/" + path, { method: "POST", headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok){ const e = new Error("auth " + r.status); e.status = r.status; throw e; }
      keep(await r.json());
    }
    async function token(){
      if (session && session.exp - 60 > now()) return session.at;
      if (session && session.rt){
        try{ await auth("token?grant_type=refresh_token", { refresh_token: session.rt }); return session.at; }
        catch(e){ if (!e.status || e.status >= 500) throw e; }   // offline or server trouble: keep the session for later
      }
      await auth("signup", { data: {} });   // anonymous sign-in: no email, no password, no signup wall
      importLocal(); syncFriends();
      return session.at;
    }
    // needAuth: create a session if there is none (voting). Otherwise use it only if it exists.
    // With no session the key goes only in apikey: a publishable key isn't a token, so it never goes in Authorization.
    async function rpc(name, args, needAuth, retried){
      const t = needAuth || session ? await (pending ||= token().finally(() => { pending = null; })) : null;
      const r = await fetch(base + "/rest/v1/rpc/" + name, { method: "POST", headers: { apikey: key, ...(t ? { Authorization: "Bearer " + t } : {}), "Content-Type": "application/json" }, body: JSON.stringify(args) });
      const body = await r.json().catch(() => null);
      if (r.status === 401 && session && !retried){ session = null; store.set("sb", null); return rpc(name, args, needAuth, true); }
      if (!r.ok){ const e = new Error((body && body.message) || "rpc " + r.status); e.status = r.status; throw e; }
      return body;
    }
    const shape = r => ({ mode: "live", mine: r.mine, visible: r.visible, min: r.min, world: r.world, country: r.country || null, state: r.state || null, city: r.city || null });
    const placeArgs = p => ({ cc: p.country, st: p.state || null, ci: p.city || null });
    function emit(dayKey, r){ store.set("res:" + dayKey, r); const s = subs.get(dayKey); if (s) s.cbs.forEach(cb => cb(r)); }
    async function refresh(dayKey){
      const s = subs.get(dayKey); if (!s) return;
      try{ emit(dayKey, shape(await rpc("get_results", { d: dayKey, n: s.n, ...placeArgs(s.place) }))); }
      catch{ s.cbs.forEach(cb => cb(null)); }   // null = couldn't reach the results
    }
    // Votes go to an outbox first, so a vote made with no signal is never lost.
    function flush(){
      return flushing ||= (async () => {
        try{
          for (let q = store.get("outbox", []); q.length; q = store.get("outbox", [])){
            const v = q[0];
            try{ emit(v.d, shape(await rpc("cast_vote", { d: v.d, c: v.c, n: v.n, ...placeArgs(v.place) }, true))); stuck = false; }
            catch(e){ if (!(e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429)){ stuck = true; return false; } }   // keep it and retry later; a 4xx means rejected for good
            store.set("outbox", store.get("outbox", []).filter(x => !(x.d === v.d)));
          }
          return true;
        } finally { flushing = null; }
      })();
    }
    // Your friend list lives on this phone. The database gets a copy once you have an account, so a friend
    // match can check that you both added each other. No account is made just for this.
    // A match or request check waits for the last save, so someone just added or accepted counts straight away.
    let syncing = Promise.resolve();
    function syncFriends(){ if (session) syncing = rpc("set_friends", { codes: liveFriends() }, true).catch(() => {}); syncName(); return syncing; }
    // Your name for your friends, sent once you have an account and again whenever it changes.
    function syncName(){
      const n = store.get("myName", "");
      if (session && n && store.get("nameSent", "") !== n) rpc("set_my_name", { n }, true).then(() => store.set("nameSent", n)).catch(() => {});
    }
    // Answers this phone saved before the database existed, copied once (today's goes through the outbox).
    async function importLocal(){
      if (store.get("imported", false)) return;
      const items = Object.entries(myVotes).filter(([d]) => d !== todayKey).map(([d, v]) => ({ d, c: v.choice, cc: v.country })).slice(-60);
      try{ if (items.length) await rpc("import_votes", { items }, true); store.set("imported", true); }catch{}
    }
    addEventListener("online", () => { flush(); subs.forEach((_, d) => refresh(d)); });
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible"){ flush(); subs.forEach((_, d) => refresh(d)); } });
    setInterval(() => { if (document.visibilityState === "visible") subs.forEach((_, d) => refresh(d)); }, 20000);

    // ---------- Sign in with Google, to post ----------
    // PKCE: Google sends back a one-time code, never a token in the address. If you already have an account
    // from answering, Google is linked to it, so your answers, streak and friend code stay as they are.
    let acct = null, settings = null;
    const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    async function challenge(){
      const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
      store.set("pkce", verifier);
      return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    }
    // "away" (gone to Google), "linking off" (Supabase's manual linking isn't switched on), or "failed".
    async function signIn(fresh){
      try{
        const q = "provider=google&redirect_to=" + encodeURIComponent(location.origin + location.pathname) + "&code_challenge=" + await challenge() + "&code_challenge_method=s256";
        if (!session || fresh){ store.set("signin", "fresh"); location.assign(base + "/auth/v1/authorize?" + q); return "away"; }
        const t = await (pending ||= token().finally(() => { pending = null; }));
        const r = await fetch(base + "/auth/v1/user/identities/authorize?" + q + "&skip_http_redirect=true", { headers: { apikey: key, Authorization: "Bearer " + t } });
        const b = await r.json().catch(() => null);
        if (r.ok && b && b.url){ store.set("signin", "link"); location.assign(b.url); return "away"; }
        return b && b.error_code === "manual_linking_disabled" ? "linking off" : "failed";
      }catch{ return "failed"; }
    }
    // Back from Google: ?code= becomes a session. "ok", "failed", "away" (gone to sign in again), or null.
    async function finishSignIn(){
      const u = new URL(location.href), q = u.searchParams, h = new URLSearchParams(u.hash.slice(1));
      const code = q.get("code"), err = q.get("error_code") || h.get("error_code") || q.get("error") || h.get("error");
      if (!code && !err) return null;
      ["code", "error", "error_code", "error_description", "state"].forEach(k => q.delete(k));
      history.replaceState(null, "", u.pathname + (q.toString() ? "?" + q : "") + (h.has("error") ? "" : u.hash));
      const verifier = store.get("pkce", ""), how = store.get("signin", ""); store.set("pkce", null); store.set("signin", null);
      // That Google account already has a Verd account (from another phone): sign in to that one instead.
      // This phone's answers stay counted once, with the account they were sent from.
      if (err === "identity_already_exists" && how === "link") return (await signIn(true)) === "away" ? "away" : "failed";
      if (err || !verifier) return "failed";
      try{ await auth("token?grant_type=pkce", { auth_code: code, code_verifier: verifier }); }catch{ return "failed"; }
      acct = null; store.set("nameSent", ""); importLocal(); syncFriends();
      return "ok";
    }
    // What your account may do. No account is made just to ask.
    async function account(force){
      if (!session) return { real: false, age_given: false, age_ok: false, moderator: false, blocked: false };
      if (!acct || force) acct = await rpc("my_profile", {}, true);
      return acct;
    }
    async function authSettings(){
      if (!settings) try{ const r = await fetch(base + "/auth/v1/settings", { headers: { apikey: key } }); settings = r.ok ? await r.json() : {}; }catch{ return {}; }
      return settings;
    }

    // ---------- Posts: people's own questions, checked by a moderator first (or afterwards, with auto_approve) ----------
    // Posts and comments come back the way the screens expect them. "@me" stands for you; a mutual friend's
    // posts and comments carry their code; everyone else is nobody in particular.
    function askLive(){
      // missing: get_posts isn't in the database yet (Google switched on before the posting part of setup.sql).
      // One quiet answer of "no such function" is enough: no asking again on a timer, and sign-in stays hidden.
      // reviewFirst: new posts wait for a moderator. False once the database owner sets auto_approve.
      // photosOn: the owner switched photo posts on (friends only). pics: each photo post's photos, once fetched.
      let cb = null, open = false, reviewFirst = true, photosOn = false, loading = null, missing = false;
      const pics = {}, fetching = {};
      const num = id => Number(String(id).slice(1));
      const what = id => String(id)[0] === "c" ? "comment" : "post";
      const asPost = (p, pl) => ({
        id: "p" + p.id, text: p.body, color: p.color, cat: catOf(p.body), scope: p.scope, country: p.country, opts: p.a && p.b ? [p.a, p.b] : null,
        state: p.scope === "state" || p.scope === "city" ? pl.state : "", city: p.scope === "city" ? pl.city : "",
        t: p.t, author: p.mine ? "@me" : p.code || null, yes: p.yes, no: p.no, total: p.total, close: p.close, reports: 0,
        photos: p.photos || 0, imgs: pics["p" + p.id],
        status: p.status || "approved", reason: p.reason || "",
        comments: p.comments.map(c => ({ id: "c" + c.id, post: "p" + p.id, author: c.mine ? "@me" : c.code || null, text: c.body, side: c.side, t: c.t, reports: 0, status: c.status || "approved" }))
      });
      function load(){
        if (missing) return Promise.resolve();
        return loading ||= (async () => {
          try{
            const pl = myPlace(), r = await rpc("get_posts", placeArgs(pl)), mv = {};
            open = !!r.open; reviewFirst = r.review_first !== false; photosOn = r.photos_on === true;
            for (const p of r.posts) if (p.my_vote) mv["p" + p.id] = p.my_vote;
            if (cb) cb(r.posts.map(p => asPost(p, pl)), mv, {});
          }catch(e){ if (e.status === 404) missing = true; } finally { loading = null; }
        })();
      }
      document.addEventListener("visibilitychange", () => { if (cb && document.visibilityState === "visible") load(); });
      setInterval(() => { if (cb && document.visibilityState === "visible") load(); }, 60000);
      return {
        me: "@me", live: true,
        get open(){ return open; },
        get reviewFirst(){ return reviewFirst; },
        get photosOn(){ return photosOn; },
        get missing(){ return missing; },
        watch(f){ cb = f; load(); },
        refresh: load,
        // live: it went up at once (auto_approve), instead of waiting for a moderator.
        // imgs: a photo post's photos, as the composer made them (data URLs). The database keeps the JPEG only.
        async post(item, imgs){
          const shots = (imgs || []).map(u => u.slice(u.indexOf(",") + 1));
          const r = await rpc("create_post", { body: item.text, color: item.color, scope: item.scope, ...placeArgs(myPlace()), ...(item.opts ? { opt_a: item.opts[0], opt_b: item.opts[1] } : {}), ...(shots.length ? { pics: shots } : {}) }, true);
          if (shots.length) pics["p" + r.id] = imgs.slice();
          await load(); return { id: "p" + r.id, live: r.status === "approved" };
        },
        // A photo post's photos, asked for once each, after the feed is up, so the feed never waits for them.
        photos(id){
          if (pics[id]) return Promise.resolve(pics[id]);
          return fetching[id] ||= rpc("get_photos", { pid: num(id) }, true)
            .then(list => pics[id] = list.map(b => "data:image/jpeg;base64," + b)).finally(() => { delete fetching[id]; });
        },
        async comment(item){ const r = await rpc("create_comment", { pid: num(item.post), body: item.text, ...placeArgs(myPlace()) }, true); await load(); return { id: "c" + r.id, live: r.status === "approved" }; },
        vote: (id, v) => rpc("judge_post", { pid: num(id), yes: v > 0, ...placeArgs(myPlace()) }, true),
        report: id => rpc("report_item", { what: what(id), iid: num(id), ...placeArgs(myPlace()) }, true),
        async remove(id){ await rpc("delete_mine", { what: what(id), iid: num(id) }, true); await load(); }
      };
    }

    return {
      mode: "live", label: "Live: everyone's answers, counted by Verd's database.",
      ask: askLive(), account, signIn, finishSignIn, authSettings,
      setBirth: (y, m) => rpc("set_birth", { y, m }, true).then(() => account(true)),
      review: {
        queue: () => rpc("review_queue", {}, true),
        decide: (what, iid, decision, why) => rpc("review_item", { what, iid, decision, why: why || null }, true),
        photos: iid => rpc("get_photos", { pid: iid }, true),
        block: (what, iid, days, why) => rpc("ban_author", { what, iid, for_days: days, why }, true)
      },
      watch(dayKey, n, place, cb){
        let s = subs.get(dayKey); if (!s){ s = { n, place, cbs: new Set() }; subs.set(dayKey, s); }
        s.cbs.add(cb); const cached = store.get("res:" + dayKey, null); if (cached) cb({ ...cached, stale: true });
        refresh(dayKey);
      },
      async vote(dayKey, c, n, place){
        store.set("outbox", [...store.get("outbox", []).filter(x => x.d !== dayKey), { d: dayKey, c, n, place }]);
        return flush();
      },
      async results(dayKey, n, place){ const r = shape(await rpc("get_results", { d: dayKey, n, ...placeArgs(place) })); store.set("res:" + dayKey, r); return r; },
      retry(){ flush(); subs.forEach((_, d) => refresh(d)); },
      async profile(){ return session ? rpc("my_profile", {}, true) : null; },   // no account until the first vote
      // null: can't check yet (no account until your first answer). Only friends who added you too come back.
      async friendMatch(codes){ await syncing; return !codes.length ? [] : session ? rpc("friend_match", { codes }, true) : null; },
      setFriends: syncFriends,
      hasAccount: () => !!session,
      setName: () => syncName(),
      // People who added you and you haven't added back. null: no account yet, or the database is older than requests.
      // Invite links: yours (made once you have an account), and joining from someone else's (makes an account).
      async myInvite(){ if (!session) return null; try{ return await rpc("my_invite", {}, true); }catch{ return null; } },
      acceptInvite: tok => rpc("accept_invite", { tok }, true),
      async friendRequests(){ if (!session) return null; await syncing; try{ return await rpc("friend_requests", {}, true); }catch{ return null; } },
      async board(dayKey, n, place, level){ return rpc("get_board", { d: dayKey, n, cc: level === "country" ? null : place.country, st: level === "city" ? place.state : null }); },
      async suggest(q, answers){ return rpc("suggest_question", { q, answers }, true); },
      waiting: d => stuck && store.get("outbox", []).some(x => x.d === d)   // saved, but no connection to send it
    };
  },

  // The claude.ai preview: shared storage between the people the page is shared with.
  claude(db, uid){
    const docs = {}, cbs = new Set(), me = codeFrom(uid);
    db.collection("votes").onSnapshot(snap => {
      for (const k in docs) delete docs[k];
      for (const d of snap.docs) docs[d.id] = d.data() || {};
      cbs.forEach(f => f());
    }, () => {});
    const min = CONFIG.min;
    function compute(dayKey, n, place){
      let mine = null; const world = [], country = [];
      for (const [id, data] of Object.entries(docs)){
        const v = (data.v || {})[dayKey]; if (!v || v[0] >= n) continue;
        if (id === uid) mine = v[0];
        world.push(v[0]); if (v[1] === place.country) country.push(v[0]);
      }
      const visible = dayKey < todayKey || mine !== null;
      const level = (arr, m) => { const counts = Array(n).fill(0); arr.forEach(c => counts[c]++); return { n: arr.length, counts: visible && arr.length >= m ? counts : null }; };
      return { mode: "preview", mine, visible, min, world: level(world, min.world), country: place.country !== "XX" ? level(country, min.country) : null, state: null, city: null };
    }
    return {
      mode: "preview", label: "Preview: shared with the people you send this page to.",
      watch(dayKey, n, place, cb){ const f = () => cb(compute(dayKey, n, place)); cbs.add(f); f(); },
      async results(dayKey, n, place){ return compute(dayKey, n, place); },
      async vote(dayKey, c, n, place){
        const ref = db.doc("votes/" + uid), s = await ref.get();
        const v = (s.exists && (s.data() || {}).v) || {};
        if (!v[dayKey]){ v[dayKey] = [c, place.country]; await ref.set({ v, code: me }); }
        return true;
      },
      async profile(){ return { code: me }; },
      async friendMatch(codes){
        const mineByDay = (docs[uid] || {}).v || {};
        return codes.map(code => {
          const doc = Object.values(docs).find(x => x.code === code); if (!doc) return null;
          const both = Object.keys(doc.v || {}).filter(d => d < todayKey && mineByDay[d]);
          const agree = both.filter(d => doc.v[d][0] === mineByDay[d][0]).length;
          return { code, shared: both.length, agree: both.length >= min.friends ? agree : null };
        }).filter(Boolean);
      },
      async board(){ return []; }
    };
  },

  // No database: only this phone's own answer is known. Nothing pretends otherwise.
  device(){
    const me = codeFrom(voterId());
    const result = dayKey => ({ mode: "device", mine: myVotes[dayKey] ? myVotes[dayKey].choice : null, visible: false, min: CONFIG.min, world: null, country: null, state: null, city: null });
    const cbs = new Map();
    return {
      mode: "device", label: "Not live yet: answers are saved on this phone until Verd's database is switched on.",
      watch(dayKey, n, place, cb){ cbs.set(dayKey, cb); cb(result(dayKey)); },
      async results(dayKey){ return result(dayKey); },
      async vote(dayKey){ const cb = cbs.get(dayKey); if (cb) cb(result(dayKey)); return true; },
      async profile(){ return { code: me }; },
      async friendMatch(){ return null; },   // nothing to compare with until live results are switched on
      async board(){ return []; }
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
  return Object.assign(backends.device(), { ask: askLocal() });
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
// The only haptics in the app: four meaningful moments. Never on scroll, never on ordinary taps.
const haptics = (() => {
  const play = (pattern, ticks) => { try{ if (navigator.vibrate) navigator.vibrate(pattern); else ticks.forEach(ms => ms ? setTimeout(iosTick, ms) : iosTick()); }catch{} };
  return {
    vote: () => play(12, [0]),                           // your answer is in
    reveal: () => play([10, 60, 18], [0, 90]),           // the verdict lands
    streak: () => play([8, 40, 8, 40, 16], [0, 80, 160]), // a streak milestone
    badge: () => play([16, 50, 16], [0, 110])            // a new badge
  };
})();
const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// Counts up with an ease-out and always lands exactly on the real number.
function countUp(el, to, suffix){
  if (calm()){ el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 800;
  const step = now => { const k = Math.min(1, (now - t0) / dur); el.textContent = (k < 1 ? Math.round(to * (1 - Math.pow(1 - k, 3))) : to) + suffix; if (k < 1) requestAnimationFrame(step); };
  el.textContent = "0" + suffix; requestAnimationFrame(step);
}
// Let the browser paint the tap first, then do the work (keeps every tap well under 100 ms).
const afterPaint = fn => requestAnimationFrame(() => setTimeout(fn, 0));
const idle = fn => "requestIdleCallback" in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 600);
// View Transitions where the browser has them (Safari 18+, Chrome); otherwise the change just happens.
function withTransition(update){
  if (!document.startViewTransition || calm() || document.hidden) return update();
  const root = document.documentElement; root.classList.add("vt");
  document.startViewTransition(update).finished.finally(() => root.classList.remove("vt"));
}

// ---------- Streaks with freezes ----------
// The rules live in core.js (streakOn, answerOn, streakNote). A streak saved under the old, stricter rules
// (a freeze every 7 days in a row) gets the starting freeze too.
function streakState(){
  const s = store.get("streakState", null);
  if (!s) return { ...NO_STREAK };
  return s.v === 2 ? s : { ...s, freezes: Math.max(s.freezes || 0, FREEZES.start) };
}
const streakNow = () => streakOn(streakState(), today);
function bumpStreak(){
  const answered = Object.keys(myVotes).length, { state, used, earned } = answerOn(streakState(), today, answered);
  store.set("streakState", { ...state, v: 2 });
  if (used) toast("Streak freeze used. Your " + state.streak + "-day streak is safe.");
  else if (earned){ toast(answered + " days answered. You earned a streak freeze."); haptics.streak(); }
}

function recapData(){
  const days = []; for (let n = today; n > today-7; n--) if (myVotes[dayKey(n)]) days.push(n);
  if (!days.length) return null;
  const withShare = days.filter(n => typeof myVotes[dayKey(n)].share === "number");
  const maj = withShare.filter(n => myVotes[dayKey(n)].majority).length;
  const rarest = [...withShare].sort((a,b)=>myVotes[dayKey(a)].share - myVotes[dayKey(b)].share)[0];
  return { answered: days.length, known: withShare.length, maj, rarest, s: streakNow().current };
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
  ["takes", "Hot takes", /overrated|underrated|hot take|unpopular|honestly|lowkey|highkey/i, 1],
  ["future", "Space & future", /\bspace\b|\bmars\b|planet|alien|future|time travel|extinct/i, 0],
  ["life", "Everyday life", /\bsleep|shower|\bbed\b|morning|\bnight\b|weekend|routine|chores/i, 2]
];
const catOf = text => { const t = TOPICS.find(([, , re]) => re.test(text || "")); return t ? t[0] : "takes"; };
const topicName = id => (TOPICS.find(t => t[0] === id) || TOPICS.find(t => t[0] === "takes"))[1];
const topicOfDay = n => qFor(n)[2] || catOf(qFor(n)[0]);
// Daily questions that are out (today's and before), newest first. Once the list loops, a question shows once, at its latest day.
function aired(){ const out = [], had = new Set(); for (let n = today; n >= 0 && out.length < QUESTIONS.length; n--){ const q = qFor(n)[0]; if (!had.has(q)){ had.add(q); out.push(n); } } return out; }
// Days until the next question that passes test(day), or 0 if none comes up in the next loop.
function daysUntil(test){ for (let k = 1; k <= QUESTIONS.length; k++) if (test(today + k)) return k; return 0; }
const dateLabel = n => n === today ? "Today" : n === today - 1 ? "Yesterday" : new Date(START + n * DAY_MS).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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
    const total = totalOf(p), hours = (now - p.t) / 3600000;
    const fresh = Math.exp(-hours / 36);                       // fades over a day and a half
    const topic = Math.min(catVotes[p.cat] || 0, 5) * 0.25;   // your interests
    const unseen = ask.myVotes[p.id] || p.author === ask.api.me ? 0 : 1;
    const split = p.yes == null ? (p.close ? 1 : 0) : total >= 3 ? 1 - Math.abs(p.yes - p.no) / total : 0; // close calls are interesting
    const talk = Math.log1p(total + 2 * p.comments.length) * 0.3;
    return unseen * 1.5 + fresh * 2 + topic + split * 0.8 + talk;
  };
  return list.map(p => [score(p), p]).sort((a,b) => b[0]-a[0]).map(x => x[1]);
}

// ---------- App state ----------
const today = dayNum(), todayKey = dayKey(today);
const [question, options] = qFor(today);
let myVotes = store.get("myVotes", {});
let res = null, yres = null;   // today's and yesterday's results (see Backends for the shape)
let backend = null, ready = null, order = [], animate = null, jumpTo = null, sheetPost = null;
function guessCountry(){
  const saved = store.get("country"); if (saved) return saved;
  const langs = navigator.languages || [navigator.language || ""];
  for (const l of langs){ const m = /-([A-Z]{2})$/i.exec(l); if (m && COUNTRIES[m[1].toUpperCase()]) return m[1].toUpperCase(); }
  return "XX";
}
// Your place: country for everyone; state and city only once you're known to be 13 or older (see ageOk).
const myPlace = () => { const ok = ageOk(); return { city: ok ? store.get("city", "") : "", state: ok ? store.get("state", "") : "", country: guessCountry() }; };
// ---------- Age: one neutral question before state and city ----------
// A child's city counts as personal information, so state and city are only kept and sent for people 13 and older.
// The question doesn't hint at the cut-off, the answer stays on this phone, and once given it can't be changed here.
const bornAt = () => { const m = /^(\d{4})-(\d{2})$/.exec(store.get("born", "")); return m ? +m[1] * 12 + (+m[2] - 1) : null; };
// The day isn't asked, so the month of the 13th birthday still counts as 12.
function ageOk(){ const b = bornAt(), now = new Date(); return b != null && now.getFullYear() * 12 + now.getMonth() - b > 13 * 12; }
// Someone who said they're under 13: country only, and no suggestions, the one place where words someone writes reach the server.
const under13 = () => bornAt() != null && !ageOk();
const canSuggest = () => !!(backend && backend.suggest) && !under13();
const friends = () => store.get("friends", []);
// First names from invite links. They're kept on this phone only.
// The name a friend gave themselves (from the database, once you're friends), else the one you typed for them.
const nick = c => store.get("names", {})[c] || store.get("nicks", {})[c] || "";
const keepNames = rows => { const add = Object.fromEntries((rows || []).filter(r => r && r.code && r.name).map(r => [r.code, r.name]));
  if (Object.keys(add).length) store.set("names", { ...store.get("names", {}), ...add }); };
function saveFriends(list){ store.set("friends", list); if (backend && backend.setFriends) backend.setFriends(); }
// Where each friend was added. A code added before Verd went live is a stand-in that doesn't exist in the database,
// so that friend is asked for a new link, and the stand-in is never sent there.
function addedIn(c){ return store.get("addedIn", {})[c] || "device"; }
// An invite can open before the backend is picked, but whether Verd is live is known from the start.
const modeNow = () => backend ? backend.mode : LIVE ? "live" : "device";
function liveFriends(){ return friends().filter(c => addedIn(c) === "live"); }
function addFriend(c){ store.set("addedIn", { ...store.get("addedIn", {}), [c]: modeNow() }); saveFriends([...friends().filter(x => x !== c), c]); }
function removeFriend(c){
  const name = nick(c) || "your friend", nicks = store.get("nicks", {}), added = store.get("addedIn", {});
  delete nicks[c]; delete added[c]; store.set("nicks", nicks); store.set("addedIn", added);
  saveFriends(friends().filter(x => x !== c));
  toast("Removed " + name + ". To add them back, use " + c + "."); renderFriends();
}
// Your friend code. Codes from the database and stand-in codes from before it existed are kept apart,
// so an invite never carries a code that won't work.
const myCode = () => store.get("myCode:" + (backend ? backend.mode : ""), "");
const ownCode = c => c === codeFrom(voterId()) || ["live", "preview"].some(m => store.get("myCode:" + m, "") === c);
const SCOPES = [["world","World"],["country","Country"],["state","State"],["city","City"],["friends","Friends"]];
// Under 13 there's no state or city, so those tabs and audiences aren't offered.
// Signed in with Google, Friends comes first: friends' posts are what that person opened Verd for.
const scopes = () => { const l = under13() ? SCOPES.filter(([k]) => k !== "state" && k !== "city") : SCOPES;
  return signedInReal ? [l[l.length - 1], ...l.slice(0, -1)] : l; };
// Slide colours: violet, crimson, green, ink, blue, pink, rust, teal. Each is dark enough that white text passes
// WCAG AA (4.5:1) on both ends of its gradient, under the sheen. tests/contrast.mjs checks every pair (#verd-data).
const COLORS = DATA.colors;
const hue = (e, c) => { e.style.setProperty("--c0", c[0]); e.style.setProperty("--c1", c[1]); return e; };
const hash = s => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
const ask = { api: null, posts: [], myVotes: {}, myReports: {}, flipped: {}, scope: "world" };
const signOf = p => p.yes > p.no ? 1 : p.yes < p.no ? -1 : 0;
// How many judged a post. The live database sends the split only once you've judged (or it's yours).
const totalOf = p => p.total ?? (p.yes + p.no);
// Posting on the live site opens once Verd has a moderator and Google sign-in is switched on.
let signInReady = false;
// Signed in with Google (not just the anonymous account every answer makes), and whether you've picked a tab yourself.
let signedInReal = false, pickedScope = false;
// Signed in with friends' posts to see: open on Friends, with today's question one tab over. Signed out,
// or with nothing from friends yet, Verd opens on today's question as always. Never once you've picked a tab.
function friendsFirst(){
  if (!signedInReal || pickedScope || ask.scope !== "world" || !ask.api || !friends().length || $("feed").scrollTop > 40) return;
  if (!ask.posts.some(p => p.scope === "friends" && p.author !== ask.api.me && visible(p, true))) return;
  ask.scope = "friends"; order = []; renderTop(); renderFeed(); $("feed").scrollTop = 0;
}
const postingOpen = () => !!ask.api && (!ask.api.live || (ask.api.open && signInReady));
const ICON = {
  comment: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 0 1-11.800 7L4 20l1-4.200A8 8 0 1 1 20 12z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/></svg>'
};
function el(tag, cls, text){ const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function iact(icon, label, text, fn){ const b = el("button", "iact"); b.innerHTML = ICON[icon]; b.setAttribute("aria-label", label); if (text) b.append(el("span", "", text)); b.onclick = fn; return b; }
function ago(t){ const m = Math.max(1, Math.round((Date.now() - t) / 60000)); return m < 60 ? m + "m" : m < 1440 ? Math.round(m / 60) + "h" : Math.round(m / 1440) + "d"; }
function sizeClass(text){ return text.length > 105 ? " s" : text.length > 55 ? " m" : ""; }
// Safari only shows :active (the press squish) if a touchstart listener exists.
document.addEventListener("touchstart", () => {}, { passive: true });

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
  const vis = ask.api ? ask.posts.filter(p => visible(p)) : [];
  const ids = new Set(vis.map(p => p.id));
  order = order.filter(id => ids.has(id));
  if (jumpTo && ids.has(jumpTo) && !order.includes(jumpTo)) order.unshift(jumpTo);
  order.push(...rank(vis.filter(p => !order.includes(p.id))).map(p => p.id));
  order = order.slice(0, 40);
}
function currentId(){ const f = $("feed"); if (!f.children.length || !f.clientHeight) return null; const s = f.children[Math.round(f.scrollTop / f.clientHeight)]; return s ? s.dataset.id : null; }

function shell(id, color){ const s = hue(el("section", "slide"), color); s.dataset.id = id; return s; }
function answers(id, labels, results, mineIdx, onTap, anim){
  const box = el("div", "answers" + (labels.length > 2 ? " stack" : ""));
  labels.forEach((label, i) => {
    const b = el("button", "ans" + (mineIdx === i ? " mine" : ""));
    const fill = el("i", "fill"); b.append(fill, el("span", "alabel", label));
    if (anim && mineIdx === i) b.classList.add("pop");
    if (results){
      const p = el("span", "apct"); b.append(p); b.disabled = true;
      const set = () => { fill.style.transform = (labels.length > 2 ? "scaleX(" : "scaleY(") + results[i] / 100 + ")"; };   // transform only: no layout per frame
      if (anim){ countUp(p, results[i], "%"); requestAnimationFrame(() => requestAnimationFrame(set)); }
      else { p.textContent = results[i] + "%"; set(); }
    } else if (mineIdx >= 0) b.disabled = true;   // answered: locked in while the count comes
    else b.onclick = () => onTap(i, b);
    box.append(b);
  });
  return box;
}

// Where today's question stands (see dayState in core.js). Every line below only says what is known.
function todayState(){
  const mine = myVotes[todayKey];
  if (mine && !backend) return "loading";
  return dayState({ mine: mine ? mine.choice : null, mode: backend && backend.mode, res, failed: netDown, waiting: !!(backend && backend.waiting && backend.waiting(todayKey)) });
}
const placeNames = () => { const p = myPlace(); return { city: p.city, state: p.state, country: COUNTRIES[p.country] }; };
function verdict(state, mine){
  if (state === "device") return ["Your answer is saved.", "Live results aren't switched on yet, so there's no verdict to show."];
  if (state === "offline") return ["Your answer is saved.", "It counts as soon as you're back online."];
  if (state === "loading" || state === "counting") return ["Your answer is in.", "Counting the votes…"];
  if (state === "error") return ["Your answer is in.", "Couldn't load the count right now."];
  if (state === "locked"){ const [a, b] = lockedLines(res); return [a, b + (mine.guess ? " Your guess is saved." : "")]; }
  const counts = countsOf(res.world), teaser = pickTeaser(res, mine.choice, placeNames());
  if (mine.guess) return [guessLine(mine.guess, shares(counts)[mine.choice]), teaser || flavor(counts, mine.choice)];
  return [verdictMain(counts, mine.choice), teaser];
}
// Remember how your answer did once the real count is in (for badges, your week and your opinion type).
function noteShare(key, r){
  const mine = myVotes[key], c = countsOf(r && r.world); if (!mine || !c || !r.visible) return;
  const share = shares(c)[mine.choice], majority = c[mine.choice] === Math.max(...c);
  if (mine.share === share && mine.majority === majority) return;
  mine.share = share; mine.majority = majority; store.set("myVotes", myVotes); checkBadges();
}
const nextIn = () => countdown(START + (today + 1) * DAY_MS - Date.now());

// The line at the bottom of today's slide. null means the count is on its way: a placeholder bar shows instead.
function dailyFoot(){
  const n = res && res.world ? res.world.n : 0;
  if (!myVotes[todayKey]){
    const counted = backend ? backend.mode !== "device" : LIVE || !!(window.claude && window.claude.use);
    return counted && !res && !netDown ? null : promptLine(res, backend && backend.mode);
  }
  return (todayState() === "revealed" ? num(n) + (n === 1 ? " answer" : " answers") + " · " : "") + "Next question in " + nextIn();
}
// Today's slide moves through: open → (tap) guess → (tap) reveal. With no database there's no guess,
// because there will be nothing to check it against.
// What today's slide shows, as plain data. Two models with the same key look identical on screen.
function dailyModel(){
  const mine = myVotes[todayKey], state = todayState();
  const guessing = !!(mine && backend && backend.mode !== "device" && mine.guess == null && !mine.seen);
  const counts = state === "revealed" && !guessing ? countsOf(res.world) : null;
  return {
    choice: mine ? mine.choice : -1, guessing, share: !!mine && !guessing, foot: dailyFoot(),
    lines: guessing ? ["Quick guess before the reveal.", "How many people picked " + options[mine.choice] + "?"] : mine ? verdict(state, mine) : null,
    results: counts ? shares(counts) : null,
    wait: !guessing && (state === "loading" || state === "counting"),   // the count is on its way
    retry: state === "error",
    reveal: !!counts && !mine.seen   // the first time you see this verdict
  };
}
const modelKey = m => JSON.stringify({ ...m, reveal: 0, foot: 0 });   // the footer line is updated on its own
const setFoot = (e, text) => { if (!e) return; e.classList.toggle("sk", text == null); e.textContent = text == null ? "Loading" : text; };
function dailySlide(m = dailyModel()){
  const s = shell("daily", COLORS[today % COLORS.length]), body = el("div", "sbody"), mine = myVotes[todayKey];
  s.dataset.key = modelKey(m);
  body.append(el("div", "kicker", "Today's question · No. " + (today + 1)), el("h2", "stext" + sizeClass(question), question));
  if (m.lines){ body.append(el("p", "sverdict", m.lines[0])); if (m.lines[1]) body.append(el("p", "ssub", m.lines[1])); }
  if (m.retry){ const b = el("button", "cta ghost", "Try again"); b.onclick = retryNow; body.append(b); }
  const foot = el("div", "sfoot"), info = el("span", "sinfo"); setFoot(info, m.foot);
  foot.append(info); const acts = el("div", "sacts");
  if (m.share) acts.append(iact("share", "Share", "Share", shareDaily));
  foot.append(acts);
  const box = m.guessing ? guessRow() : answers("daily", options, m.results, m.choice, vote, m.reveal);
  if (m.wait) box.classList.add("wait");
  s.append(body, box, foot);
  if (m.reveal){
    s.classList.add("reveal"); s.append(el("div", "hint", "Swipe up for more"));
    mine.seen = true; store.set("myVotes", myVotes); revealing = Date.now() + 1400; haptics.reveal();
  }
  if (m.share) setTimeout(() => idle(prepareCard), m.reveal ? 3000 : 2500);   // drawn while you read, never during the reveal
  return s;
}
function guessRow(){
  const box = el("div", "answers stack guess");
  for (const [k, label] of GUESSES){ const b = el("button", "ans"); b.dataset.guess = k; b.append(el("span", "alabel", label)); b.onclick = () => guess(k); box.append(b); }
  return box;
}
// Re-draw only today's slide, not the whole feed, and keep the slide itself: its full-screen gradient
// stays painted and only what changed inside it is drawn again. This keeps a vote or a new count cheap.
let revealing = 0, later = null;
// If nothing visible changed (say, a new count arrives while you're choosing a guess), nothing is redrawn,
// so a button is never swapped out from under your finger.
function renderDaily(){
  const old = $("feed").querySelector('.slide[data-id="daily"]');
  if (!old) return renderFeed();
  patchDaily(old, dailyModel());
}
// The question itself never changes during the day, so it is never taken out of the page: it stays painted
// (it is the page's first and largest paint, from index.html) and only what's around it is swapped.
function patchDaily(old, m){
  if (old.dataset.key === modelKey(m)) return setFoot(old.querySelector(".sinfo"), m.foot);
  const fresh = dailySlide(m), ob = old.querySelector(".sbody"), fb = fresh.querySelector(".sbody");
  const oq = ob && ob.querySelector(".stext"), fq = fb.querySelector(".stext");
  old.className = fresh.className + (old.classList.contains("in") ? " in" : ""); old.dataset.key = fresh.dataset.key;
  if (!oq || oq.className !== fq.className || oq.textContent !== fq.textContent) return old.replaceChildren(...fresh.childNodes);
  const kids = [...fb.childNodes], at = kids.indexOf(fq);
  for (const c of [...ob.childNodes]) if (c !== oq) c.remove();
  oq.before(...kids.slice(0, at)); oq.after(...kids.slice(at + 1));
  for (const c of [...old.childNodes]) if (c !== ob) c.remove();
  old.append(...[...fresh.childNodes].filter(c => c !== fb));
}
// A new count while the reveal is still playing waits for it to finish.
function onToday(r){
  if (r){ res = r; noteShare(todayKey, r); if (!r.stale) netDown = false; if (!r.stale && r.mine != null) boardSoon(); } else netDown = true;
  renderNet(); clearTimeout(later); const wait = revealing - Date.now();
  if (wait > 0) later = setTimeout(renderDaily, wait); else renderDaily();
}
// The headline for a finished day: how your answer did, or what came out on top.
function finalLine(c, o, mine){
  if (mine) return "You said " + o[mine.choice] + ". " + verdictMain(c, mine.choice);
  const lead = leader(c); return lead < 0 ? "It ended in a tie." : shares(c)[lead] > 50 ? "Most people said " + o[lead] + "." : o[lead] + " came out on top.";
}
// ---------- Today's board ----------
// Countries, and cities in your state, with enough answers today (30 each, set in the database), and how many in
// each picked your answer. Live only, once the database has your answer. Below the minimum it says so.
let board = null, boardAt = 0;
function boardSoon(){
  if (!backend || backend.mode !== "live" || !myVotes[todayKey] || Date.now() - boardAt < 60000) return;
  boardAt = Date.now();
  const place = myPlace(), n = options.length;
  Promise.all([backend.board(todayKey, n, place, "country"), place.state ? backend.board(todayKey, n, place, "city") : null])
    .then(([countries, cities]) => {
      const next = { countries: countries || [], cities }; if (JSON.stringify(next) === JSON.stringify(board)) return;
      board = next; setTimeout(() => idle(renderFeed), Math.max(0, revealing - Date.now()));   // never during the reveal
    })
    .catch(() => { boardAt = 0; });
}
const placeKey = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const titleCase = s => String(s).replace(/(^|[\s-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
function boardSlide(){
  const mine = myVotes[todayKey].choice, pl = myPlace(), min = k => (res && res.min && res.min[k]) || CONFIG.min[k];
  const s = shell("board", COLORS[(today + 3) % COLORS.length]), body = el("div", "sbody"), list = el("div", "board");
  body.append(el("div", "kicker", "Today's board"), el("h2", "stext m", "Who said " + options[mine] + "?"));
  // The biggest places, plus yours if it made the board lower down.
  const rows = (all, isMe, label) => {
    const show = all.slice(0, 5), me = all.find(isMe); if (me && !show.includes(me)) show.push(me);
    for (const r of show){
      const p = shares(r.counts)[mine], d = el("div", "brow" + (isMe(r) ? " you" : "")), bar = el("i");
      bar.style.setProperty("--p", p / 100); bar.setAttribute("aria-hidden", "true");
      d.append(el("span", "", label(r)), el("b", "", p + "%"), bar); list.append(d);
    }
  };
  const notes = [], { countries, cities } = board;
  if (countries.length){
    rows(countries, r => r.place === pl.country, r => flag(r.place) + " " + (COUNTRIES[r.place] || r.place));
    if (pl.country !== "XX" && !countries.some(r => r.place === pl.country)) notes.push(COUNTRIES[pl.country] + " shows up at " + min("country") + " answers.");
  } else notes.push("No country has " + min("country") + " answers yet. Share today's question to put yours on the board.");
  if (cities && cities.length){
    list.append(el("p", "blabel", "Cities in " + titleCase(pl.state)));
    rows(cities, r => r.place === placeKey(pl.city), r => titleCase(r.place));
  } else if (cities) notes.push("No city in " + titleCase(pl.state) + " has " + min("city") + " answers yet.");
  if (list.children.length) body.append(list);
  for (const t of notes) body.append(el("p", "ssub", t));
  const foot = el("div", "sfoot"), acts = el("div", "sacts");
  acts.append(iact("share", "Share", "Share", shareDaily));
  foot.append(el("span", "sinfo", "Places show at " + min("country") + " answers."), acts);
  s.append(body, foot); return s;
}
function yesterdaySlide(){
  const [yq, yo] = qFor(today - 1), s = shell("yday", COLORS[(today + 7) % COLORS.length]), body = el("div", "sbody"), mine = myVotes[dayKey(today - 1)];
  const yc = countsOf(yres.world), yt = sum(yc);
  body.append(el("div", "kicker", "Yesterday's final verdict"), el("h2", "stext" + sizeClass(yq), yq), el("p", "sverdict", finalLine(yc, yo, mine)));
  const foot = el("div", "sfoot"); foot.append(el("span", "", num(yt) + (yt === 1 ? " answer" : " answers"))); foot.append(el("div", "sacts"));
  s.append(body, answers("yday", yo, shares(yc), mine ? mine.choice : -1, () => {}, false), foot);
  return s;
}
// Where your own post stands on the live site: waiting for a moderator, turned down, removed, or up.
const standing = p => p.status === "pending" ? "Waiting for review" : p.status === "rejected" ? "Not approved" + (p.reason ? ": " + p.reason : "")
  : p.status === "removed" ? "Removed" + (p.reason ? ": " + p.reason : "") : "Your post";
function postSlide(p){
  // On the live site the split arrives once you've judged (or it's yours). Before that: how many judged, and whether it's close.
  const mine = p.author === ask.api.me, my = ask.myVotes[p.id], total = totalOf(p), show = mine || !!my, yes = p.yes == null ? null : pct(p.yes, total);
  const published = !p.status || p.status === "approved";
  const s = shell(p.id, COLORS[(typeof p.color === "number" ? p.color : hash(p.id)) % COLORS.length]), body = el("div", "sbody");
  body.append(el("div", "kicker", [placeLabel(p), ago(p.t), mine ? standing(p) : "", ask.flipped[p.id] ? "Flipped since you voted" : ""].filter(Boolean).join(" · ")));
  // On the live site a photo post's photos come a moment after the post: until then their places stay empty.
  const waitPics = !p.imgs && p.photos > 0 && !!ask.api.photos;
  const imgs = p.imgs || (waitPics ? Array(p.photos).fill("") : []), duo = imgs.length === 2, labels = sideLabels(p);
  if (waitPics) fillPics(p);
  const tap = i => mine ? toast("You can't vote on your own post.") : votePost(p.id, i === 0 ? 1 : -1);
  if (imgs.length === 1){ s.classList.add("photo"); const im = el("img", "pbg"); if (imgs[0]) im.src = imgs[0]; im.alt = ""; s.append(im); }
  if (duo){ s.classList.add("duo"); const g = el("div", "duo-imgs");
    imgs.forEach((src, i) => { const b = el("button", my && (my > 0 ? 0 : 1) === i ? "mine" : ""); if (src){ const im = el("img"); im.src = src; im.alt = labels[i]; b.append(im); } b.setAttribute("aria-label", labels[i]); if (show) b.disabled = true; else b.onclick = () => tap(i); g.append(b); });
    s.append(g); }
  body.append(el("h2", "stext" + (imgs.length ? " s" : sizeClass(p.text)), p.text));
  const close = p.close ?? (total >= 4 && Math.abs(yes - 50) <= 10);
  if (!published) body.append(el("p", "sverdict", p.status === "pending" ? "Only you can see this until a moderator approves it." : "Only you can see this."));
  else if (show && yes != null){ const v = !total ? "Waiting for the first verdict." : close ? "Split " + yes + "/" + (100 - yes) + ". Could go either way." : total >= 3 && yes >= 75 ? (duo ? "This one is winning." : "People are into it.") : total >= 3 && yes <= 25 ? (duo ? "That one is winning." : "People say no.") : ""; if (v) body.append(el("p", "sverdict", v)); }
  const foot = el("div", "sfoot");
  foot.append(el("span", "", show ? total + (total === 1 ? " vote" : " votes") : !total ? "Be the first to judge." : close ? "This one is splitting people. Tap to see." : total + (total === 1 ? " person" : " people") + " voted. Tap to see the verdict."));
  const live = liveComments(p), nC = live.length, acts = el("div", "sacts");
  if (show && nC){ const last = live[live.length - 1], pk = el("button", "peek"); pk.append(el("b", "", whoSaid(last)), el("span", "", last.text)); pk.onclick = () => openSheet(p.id); pk.setAttribute("aria-label", "Open comments"); body.append(pk); }
  if (published) acts.append(iact("comment", "Comments", nC ? String(nC) : "", () => openSheet(p.id)));
  if (!mine) acts.append(iact("flag", "Report", "", () => report(p.id)));
  if (mine && ask.api.remove) acts.append(iact("trash", "Delete your post", "", () => removeMine(p.id)));
  foot.append(acts);
  s.append(body, answers(p.id, labels, show && total && yes != null ? [yes, 100 - yes] : null, my ? (my > 0 ? 0 : 1) : -1, tap, animate === p.id), foot);
  return s;
}
// Fetches a live photo post's photos and swaps its slide for one with them, where it is.
function fillPics(p){
  ask.api.photos(p.id).then(list => {
    const old = $("feed").querySelector('.slide[data-id="' + p.id + '"]'); if (!old || !list.length) return;
    const fresh = postSlide({ ...p, imgs: list }); old.replaceWith(fresh); if (seen) seen.observe(fresh);
  }).catch(() => {});
}
const dropLine = () => "Tomorrow's question drops in " + nextIn() + ".";
function endSlide(){
  const s = el("section", "slide end"); s.dataset.id = "end"; const body = el("div", "sbody"), pl = myPlace();
  let h = "You're caught up.", sub = null, cta = null;
  if ((ask.scope === "city" && (!pl.city || !pl.state)) || (ask.scope === "state" && !pl.state)){ h = "Where are you?"; sub = "Add your city and state to see what people near you really think."; cta = ["Set my place", () => showPage("me")]; }
  else if (ask.scope === "friends" && !friends().length){ h = "No friends here yet."; sub = "Swap codes with a friend and judge each other's posts."; cta = ["Add a friend", () => showPage("me")]; }
  else if (!order.length && ask.scope !== "world"){ h = "Nothing here yet."; sub = postingOpen() ? "Be the first one to ask." : "Posts from people show up here."; cta = postingOpen() ? ["Post something", openCompose] : null; }
  body.append(el("h2", "stext m", h));
  if (sub) body.append(el("p", "ssub", sub));
  else {
    // The real end of the feed: when the next question drops, and a sneak peek of what it's about.
    const next = el("p", "ssub", dropLine()), peek = el("p", "peekline"); next.dataset.tick = "drop";
    peek.append(el("span", "", "Tomorrow's topic"), el("b", "", topicName(topicOfDay(today + 1))));
    body.append(next, peek);
    cta = !myVotes[todayKey] ? ["Answer today's question", () => openPost("daily")] : postingOpen() ? ["Post something", openCompose] : null;
  }
  if (cta){ const b = el("button", "cta", cta[0]); b.onclick = cta[1]; body.append(b); }
  s.append(body); return s;
}
// The end slide changes once you've answered (no more "Answer today's question").
function renderEnd(){ const old = $("feed").querySelector('.slide[data-id="end"]'); if (old) old.replaceChildren(...endSlide().childNodes); }
function renderFeed(){
  const feed = $("feed"), cur = jumpTo || currentId();
  syncOrder();
  // Today's slide is patched where it is (see patchDaily); everything else is rebuilt.
  const old = feed.querySelector('.slide[data-id="daily"]'), daily = ask.scope !== "world" ? null : old ? (patchDaily(old, dailyModel()), old) : dailySlide();
  for (const c of [...feed.children]) if (c !== daily) c.remove();
  if (daily){ if (!daily.isConnected) feed.prepend(daily); if (board && myVotes[todayKey]) feed.append(boardSlide()); if (countsOf(yres && yres.world)) feed.append(yesterdaySlide()); }
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
// The tabs only filter people's posts. With no posts to filter they would be dead controls, so they don't show
// and the feed is simply today's question.
function renderTop(){
  const box = $("scopes"), show = !!ask.api && ask.posts.some(p => visible(p, true));
  if (!show) ask.scope = "world";
  box.hidden = !show; box.innerHTML = ""; if (!show) return;
  scopes().forEach(([k, l]) => { const b = el("button", "scope" + (k === ask.scope ? " on" : ""), l); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", k === ask.scope);
    b.onclick = () => { pickedScope = true; ask.scope = k; order = []; renderTop(); renderFeed(); $("feed").scrollTop = 0; }; box.append(b); });
}

// ---------- Connection ----------
// A small pill in the top bar when Verd can't be reached. Answers are never lost: they wait in the outbox.
let netDown = false;   // the last try to load today's count failed
function renderNet(){
  const b = $("net"), counted = !!backend && backend.mode !== "device", off = !navigator.onLine;
  const stuck = !!(backend && backend.waiting && backend.waiting(todayKey));
  b.hidden = !counted || !(off || netDown || stuck);
  $("netText").textContent = off ? "Offline" : "Can't connect · Retry";
}
function retryNow(){ netDown = false; renderNet(); renderDaily(); if (backend && backend.retry) backend.retry(); }
$("net").onclick = () => navigator.onLine ? retryNow() : toast("You're offline. Answers are saved and sent when you're back.");
addEventListener("online", renderNet); addEventListener("offline", renderNet);

// ---------- Actions ----------
// The tap itself only marks your answer and ticks (under 16 ms). Saving and drawing happen after that frame.
let voting = false;
function vote(i, btn, quiet){
  if (myVotes[todayKey] || voting) return; voting = true;
  if (btn){ btn.classList.add("mine"); if (!quiet) btn.classList.add("pop"); for (const b of btn.parentNode.children) b.disabled = true; }
  if (!quiet) haptics.vote();
  afterPaint(() => commitVote(i));
}
async function commitVote(i){
  const place = myPlace(); myVotes[todayKey] = { choice: i, country: place.country }; store.set("myVotes", myVotes); bumpStreak();
  if (res) res = { ...res, mine: i };
  withTransition(() => { renderDaily(); renderEnd(); }); checkBadges();
  if (!backend) await ready;
  let ok = false;
  try{ ok = await backend.vote(todayKey, i, options.length, place); }catch{}
  voting = false;
  if (ok){ store.set("sent", todayKey); showCode(); }
  else { toast("Saved. It will count when you're back online."); renderDaily(); }
  renderNet();
}
function guess(k){
  const mine = myVotes[todayKey]; if (!mine || mine.guess) return;
  mine.guess = k; store.set("myVotes", myVotes);
  withTransition(renderDaily);
}
async function votePost(id, v){
  ask.myVotes = { ...ask.myVotes, [id]: v }; const p = ask.posts.find(x => x.id === id);
  const sign = () => { const signs = store.get("askSigns", {}); signs[id] = signOf(p) || v; store.set("askSigns", signs); };
  if (p && p.yes != null){ v > 0 ? p.yes++ : p.no++; if (p.total != null) p.total++; sign(); }
  else if (p) p.total = (p.total || 0) + 1;   // live: the split comes back with your answer
  haptics.vote(); animate = id; renderFeed();
  try{
    const r = await ask.api.vote(id, v);
    if (p && r && typeof r.yes === "number"){ p.yes = r.yes; p.no = r.no; p.total = r.yes + r.no; sign(); animate = id; renderFeed(); }
  }catch{ toast("Couldn't save your vote. Try again."); }
}
// Deleting your own post or comment: tap, then tap again within 4 seconds.
let armed = null;
async function removeMine(id){
  if (armed !== id){ armed = id; toast(id[0] === "c" ? "Tap Delete again to delete your comment." : "Tap the bin again to delete your post."); setTimeout(() => { if (armed === id) armed = null; }, 4000); return; }
  armed = null;
  try{ await ask.api.remove(id); toast("Deleted."); }catch{ toast("Couldn't delete it. Try again."); }
}
async function report(id){ ask.myReports = { ...ask.myReports, [id]: 1 }; toast("Reported. It's hidden for you."); renderFeed(); if (sheetPost) renderSheet(); try{ await ask.api.report(id); }catch{} }
function checkFlips(){ const signs = store.get("askSigns", {}); for (const p of ask.posts) if (ask.myVotes[p.id] && signs[p.id] && p.yes + p.no >= 4){ const s = signOf(p); if (s && s !== signs[p.id]) ask.flipped[p.id] = true; } }
async function copyOrShow(text, okMsg){
  try{ await navigator.clipboard.writeText(text); toast(okMsg); }
  catch{ sheetPost = null; $("stitle").textContent = "Copy this"; $("clist").hidden = true; $("cform").hidden = true; const b = $("shareBox"); b.hidden = false; b.value = text; $("sheet").hidden = false; b.focus(); b.select(); }
}
// ---------- Share: a result card image, through the share sheet ----------
// The card says how big your side is, never which side won, so friends still have to answer to find out.
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
// Share and invite links. On the public site they use the address the page was opened at, so they always work;
// anywhere else (the claude.ai preview, a local copy) they point at the public site.
const siteUrl = () => /(^|\.)github\.io$/.test(location.hostname) ? location.origin + location.pathname.replace(/[^/]*$/, "")
  : CONFIG.siteUrl || location.href.split("#")[0].split("?")[0];
function shareLines(){
  const mine = myVotes[todayKey], counts = todayState() === "revealed" ? countsOf(res.world) : null;
  if (counts) return ["I'm with " + shares(counts)[mine.choice] + "% of " + num(sum(counts)) + " people.", "Which side are you on?"];
  return ["I answered. The verdict isn't in yet.", "What's your Verd?"];
}
function wrapText(g, text, width){
  const lines = []; let line = "";
  for (const w of text.split(" ")){ const t = line ? line + " " + w : w; if (line && g.measureText(t).width > width){ lines.push(line); line = w; } else line = t; }
  return line ? [...lines, line] : lines;
}
function drawCard(){
  const W = 1080, H = 1350, P = 88, cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const g = cv.getContext("2d"), [c0, c1] = COLORS[today % COLORS.length];
  let gr = g.createLinearGradient(W * .37, 0, W * .63, H); gr.addColorStop(0, c0); gr.addColorStop(1, c1); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  gr = g.createRadialGradient(0, 0, 0, 0, 0, W * 1.2); gr.addColorStop(0, "rgba(255,255,255,.1)"); gr.addColorStop(.6, "rgba(255,255,255,0)"); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.fillStyle = "#fff"; g.textBaseline = "alphabetic";
  g.font = "800 54px " + FONT; g.fillText("What's the Verd?", P, 160);
  g.font = "600 36px " + FONT; g.textAlign = "right"; g.fillText("No. " + (today + 1), W - P, 158); g.textAlign = "left";
  let size = 124, lines;   // the question, as big as fits
  do { size -= 6; g.font = "800 " + size + "px " + FONT; lines = wrapText(g, question, W - 2 * P); } while ((lines.length > 5 || lines.length * size * 1.04 > 500) && size > 56);
  const [l1, l2] = shareLines(); g.font = "700 50px " + FONT; const l1s = wrapText(g, l1, W - 2 * P);
  const n = options.length, gap = 24, pw = (W - 2 * P - gap * (n - 1)) / n, ph = 120, py = H - 330;
  const block = lines.length * size * 1.04 + 40 + l1s.length * 62 + 42;   // centre the words between the header and the answers
  let y = 200 + Math.max(40, (py - 200 - block) / 2) + size * .8;
  g.font = "800 " + size + "px " + FONT; for (const l of lines){ g.fillText(l, P, y); y += size * 1.04; }
  y += 40; g.font = "700 50px " + FONT; for (const l of l1s){ g.fillText(l, P, y); y += 62; }
  g.font = "500 42px " + FONT; g.fillText(l2, P, y);
  // the answers, without numbers
  options.forEach((o, i) => {
    const x = P + i * (pw + gap); g.beginPath(); g.roundRect ? g.roundRect(x, py, pw, ph, 28) : g.rect(x, py, pw, ph);
    g.fillStyle = "rgba(255,255,255,.16)"; g.fill(); g.strokeStyle = "rgba(255,255,255,.28)"; g.lineWidth = 2; g.stroke();
    let fs = 44; do { g.font = "700 " + fs + "px " + FONT; fs -= 2; } while (g.measureText(o).width > pw - 40 && fs > 22);
    g.fillStyle = "#fff"; g.textAlign = "center"; g.fillText(o, x + pw / 2, py + ph / 2 + fs * .36); g.textAlign = "left";
  });
  const code = myCode();
  g.font = "600 34px " + FONT; g.fillText("Answer at " + siteUrl().replace(/^https?:\/\//, "").replace(/\/$/, ""), P, code ? H - 140 : H - 100);
  if (code){ g.font = "500 34px " + FONT; g.fillText("Add me on Verd: " + code, P, H - 88); }
  return cv;
}
const cardName = () => "verd-" + (today + 1) + ".png";
function fileFromCanvas(cv){
  const bin = atob(cv.toDataURL("image/png").split(",")[1]), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new File([u8], cardName(), { type: "image/png" });
}
// The card is drawn ahead of time, in idle moments, so tapping Share opens the sheet straight away.
let card = null;
const cardKey = () => todayState() + "|" + shareLines()[0] + "|" + myCode();
function prepareCard(){
  if (!myVotes[todayKey]) return;
  const key = cardKey(); if (card && card.key === key) return;
  try{ drawCard().toBlob(b => { if (b) card = { key, file: new File([b], cardName(), { type: "image/png" }) }; }, "image/png"); }catch{}
}
function saveFile(file){
  try{ const a = el("a"); a.href = URL.createObjectURL(file); a.download = file.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }catch{}
}
async function shareDaily(){
  if (!myVotes[todayKey]) return;
  const [l1, l2] = shareLines(), url = inviteUrl();
  const text = "Verd No. " + (today + 1) + ": " + question + "\n" + l1 + " " + l2 + " (No peeking before you answer.)";
  let file = card && card.key === cardKey() ? card.file : null;
  if (!file){ try{ file = fileFromCanvas(drawCard()); }catch{} }
  try{
    if (file && navigator.canShare && navigator.canShare({ files: [file] })){ await navigator.share({ files: [file], text: text + "\n" + url }); return; }
    if (navigator.share){ await navigator.share({ title: "What's the Verd?", text, url }); return; }
  }catch(e){ if (e && e.name === "AbortError") return; }
  if (file) saveFile(file);   // no share sheet here (most computers): save the card and copy the text
  copyOrShow(text + "\n" + url, file ? "Card saved. The text is copied too." : "Copied. Paste it in your group chat.");
}

// ---------- Comments ----------
const liveComments = p => p.comments.filter(c => (c.reports < HIDE_AT || c.author === ask.api.me) && !ask.myReports[c.id]);
const whoSaid = c => c.author === ask.api.me ? "You" : friends().includes(c.author) ? c.author : "Someone";
// A post's answers: its own two (like Lamborghini or Ferrari), This one or That one for two photos, else Yes or No.
const sideLabels = p => (p.imgs ? p.imgs.length : ask.api && ask.api.photos ? p.photos : 0) === 2 ? ["This one", "That one"] : p.opts && p.opts.length === 2 ? p.opts : ["Yes", "No"];
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
    if (c.status && c.status !== "approved") head.append(el("span", "", c.status === "pending" ? "Waiting for review" : "Not approved"));
    if (c.author !== ask.api.me){ const r = el("button", "lnk", "Report"); r.onclick = () => report(c.id); head.append(r); }
    else if (ask.api.remove){ const r = el("button", "lnk", "Delete"); r.onclick = () => removeMine(c.id); head.append(r); }
    row.append(head, el("p", "", c.text)); box.append(row); }
}
$("sclose").onclick = closeSheet;
$("sheet").onclick = e => { if (e.target === $("sheet")) closeSheet(); };
$("cform").onsubmit = async e => {
  e.preventDefault(); const text = $("cinput").value.trim(); if (text.length < 2 || !sheetPost) return;
  if (blockedText(text)){ toast(BLOCK_MSG); return; }
  const pp = ask.posts.find(x => x.id === sheetPost), my = ask.myVotes[sheetPost];
  if (!my && !(pp && pp.author === ask.api.me)){ toast("Vote first, then say why."); return; }
  if (ask.api.live){
    if (!postingOpen()){ toast("Comments open soon."); return; }
    const post = sheetPost; if (!(await gate("comment:" + post))) return;
    $("csend").disabled = true;
    try{ const r = await ask.api.comment({ post, text }); $("cinput").value = ""; store.set("commented", true); checkBadges(); toast(r.live ? "Posted. Others can see it now." : "Sent. Others see it once a moderator approves it."); }
    catch(err){ const m = writeError(err); if (m) toast(m); else gate("comment:" + post); }
    $("csend").disabled = false; return;
  }
  const item = { id: "c-" + ask.api.me + "-" + Date.now().toString(36), post: sheetPost, author: ask.api.me, text, t: Date.now() };
  if (my) item.side = my > 0 ? 0 : 1;
  const p = ask.posts.find(x => x.id === sheetPost); if (p) p.comments.push({ ...item, reports: 0 });
  $("cinput").value = ""; renderSheet(); renderFeed();
  try{ await ask.api.comment(item); store.set("commented", true); checkBadges(); }catch{ toast("Couldn't send your comment. Try again."); }
};

// ---------- New post ----------
let cColor = 0, cScope = "world", cPhotos = [], cWait = null;
// Shrinks a photo in the browser so it loads fast and stays small (960 pixels on the live site, 640 on the phone).
// Drawing it again keeps only the picture: where and when it was taken and the camera are left behind.
// The database cuts those out too, whatever app sends the photo.
function shrink(file, max){
  return new Promise((ok, fail) => { const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      let q = .7, out = c.toDataURL("image/jpeg", q);
      while (out.length > 300000 && q > .3){ q -= .15; out = c.toDataURL("image/jpeg", q); }   // about 220 KB at most
      ok(out); };
    img.onerror = () => { URL.revokeObjectURL(url); fail(); }; img.src = url; });
}
$("pfile").onchange = async e => {
  for (const f of [...e.target.files].slice(0, 2 - cPhotos.length)){ try{ cPhotos.push(await shrink(f, ask.api.live ? 960 : 640)); }catch{ toast("That photo couldn't be opened."); } }
  e.target.value = ""; if (cPhotos.length) cScope = "friends"; drawCompose();
};
async function openCompose(prefill){
  if (!postingOpen()){ toast("Posting opens soon."); return; }
  if (ask.api.live && !(await gate("post"))) return;
  // How long until your next public post (the database counts it from your answer streak). The account was just
  // fetched by the gate. Missing on a database that's older than the waits: then nothing is said.
  cWait = null;
  if (ask.api.live) try{ const w = (await backend.account()).public_wait; if (w) cWait = { ...w, until: Date.now() + w.next * 1000 }; }catch{}
  cColor = Math.floor(Math.random() * COLORS.length); cScope = ask.scope; cPhotos = []; drawCompose(); $("compose").hidden = false; paintStatusBar();
  if (typeof prefill === "string") $("ptext").value = prefill; $("ptext").focus();
}
function drawCompose(){
  hue($("compose"), COLORS[cColor]);
  const sw = $("swatches"); sw.innerHTML = "";
  COLORS.forEach((c, i) => { const b = el("button", "sw" + (i === cColor ? " on" : "")); b.style.background = c[0]; b.setAttribute("aria-label", "Color " + (i + 1)); b.onclick = () => { cColor = i; drawCompose(); }; sw.append(b); });
  const au = $("aud"); au.innerHTML = "";
  scopes().forEach(([k, l]) => { const b = el("button", k === cScope ? "on" : "", l); b.disabled = cPhotos.length > 0 && k !== "friends"; b.onclick = () => { cScope = k; drawCompose(); }; au.append(b); });
  const th = $("thumbs"); th.innerHTML = "";
  cPhotos.forEach((src, i) => { const t = el("div", "thumb"), im = el("img"); im.src = src; im.alt = "Photo " + (i + 1); const x = el("button"); x.append(el("span", "", "×")); x.setAttribute("aria-label", "Remove photo"); x.onclick = () => { cPhotos.splice(i, 1); drawCompose(); }; t.append(im, x); th.append(t); });
  if (cPhotos.length < 2){ const a = el("button", "addp"); a.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'; a.setAttribute("aria-label", "Add a photo"); a.onclick = () => $("pfile").click(); th.append(a); }
  $("compose").classList.toggle("haspic", cPhotos.length > 0); $("colorRow").hidden = cPhotos.length > 0;
  // Photos on the live site only once the owner switches them on: nothing can check a photo the way words are
  // checked, so they go to friends only, and only friends who are signed in and 13 or older see them.
  $("photoRow").hidden = !!ask.api.live && !ask.api.photosOn;
  $("ptext").placeholder = cPhotos.length === 2 ? "Which one?" : cPhotos.length === 1 ? "Yes or no?" : "What do you want a verdict on?";
  const who = ask.api.live ? " Only friends who are signed in and 13 or older see it, and one report hides it until the moderator looks."
    : " Photo posts go to friends only for now.";
  $("cnote").textContent = cPhotos.length === 2 ? "Friends pick This one or That one." + who
    : cPhotos.length === 1 ? "Friends answer Yes or No." + who
    : "People pick one of your two answers. No names, phone numbers or anything mean about a real person.";
  $("optRow").hidden = cPhotos.length > 0;
  const pub = cWait && cScope !== "friends" && !cPhotos.length; $("awhen").hidden = !pub;
  if (pub) $("awhen").textContent = publicWaitNote(cWait, Math.ceil((cWait.until - Date.now()) / 60000));
  if (backend && backend.mode === "device") $("cnote").textContent = "Only you can see your posts until Verd goes live. " + $("cnote").textContent;
  if (ask.api.live) $("cnote").textContent = (ask.api.reviewFirst ? "A moderator checks every post before anyone else sees it, and your name is never shown. "
    : "Posts go live straight away, and your name is never shown. ") + $("cnote").textContent;
}
function closeCompose(){ $("compose").hidden = true; paintStatusBar(); }
$("cclose").onclick = closeCompose;
$("psend").onclick = async () => {
  let text = $("ptext").value.trim().replace(/\s+/g, " "); const pl = myPlace(), imgs = cPhotos.slice();
  if (imgs.length && !text) text = imgs.length === 2 ? "Which one?" : "Yes or no?";
  if (imgs.length && !friends().length){ toast("Add a friend on your profile first. Photo posts go to friends."); return; }
  if (text.length < 4){ toast("Write a little more."); return; }
  if (blockedText(text)){ toast(BLOCK_MSG); return; }
  // Your own answers, or Yes and No when both are left empty.
  const oa = $("opta").value.trim().replace(/\s+/g, " "), ob = $("optb").value.trim().replace(/\s+/g, " "), opts = !imgs.length && (oa || ob) ? [oa, ob] : null;
  if (opts && (!oa || !ob)){ toast("Fill in both answers, or leave both empty for Yes and No."); return; }
  if (opts && oa.toLowerCase() === ob.toLowerCase()){ toast("Make the two answers different."); return; }
  if (opts && (blockedText(oa) || blockedText(ob))){ toast(BLOCK_MSG); return; }
  if ((cScope === "city" && (!pl.city || !pl.state)) || (cScope === "state" && !pl.state)){ toast("Add your city and state on the Me page first."); return; }
  const item = { id: ask.api.me + "-" + Date.now().toString(36), author: ask.api.me, text, color: cColor, photos: imgs.length, opts, cat: catOf(text), scope: imgs.length ? "friends" : cScope, city: pl.city, state: pl.state, country: pl.country, t: Date.now() };
  $("psend").disabled = true;
  if (ask.api.live){
    try{
      const r = await ask.api.post(item, imgs); store.set("posted", true);
      if (ask.scope !== item.scope){ ask.scope = item.scope; order = []; renderTop(); }
      jumpTo = r.id; $("ptext").value = $("opta").value = $("optb").value = ""; cPhotos = []; closeCompose(); showPage("feed"); renderFeed();
      toast(r.live ? (imgs.length ? "Posted. Your friends can see it now." : "Posted. Others can see it now.") : "Sent for review. Others see it once a moderator approves it."); checkBadges();
    }catch(err){ const m = writeError(err); if (m) toast(m); else { closeCompose(); gate("post"); } }
    $("psend").disabled = false; return;
  }
  try{
    if (ask.scope !== item.scope){ ask.scope = item.scope; order = []; renderTop(); }
    jumpTo = item.id; if (imgs.length) await ask.api.photo(item.id, imgs); await ask.api.post(item); store.set("posted", true);
    $("ptext").value = $("opta").value = $("optb").value = ""; closeCompose(); showPage("feed"); renderFeed(); toast("Posted."); checkBadges();
  }catch{ jumpTo = null; toast("Couldn't post. Check your connection and try again."); }
  $("psend").disabled = false;
};

// ---------- Accounts, for posting on the live site ----------
// Writing needs the month and year you were born (asked before signing in, so nobody under 13 hands over an
// email), a real account (Google), 13 or older, and no block. Reading, judging and reporting need none of it.
// then: what to do once that's all done ("post", "comment:<post id>" or "me"), kept through the trip to Google.
async function gate(then){
  if (under13()){ openAcct("young"); return false; }
  let a;
  try{ a = await backend.account(true); }catch{ toast("Couldn't check your account. Check your connection."); return false; }
  const born = /^(\d{4})-(\d{2})$/.exec(store.get("born", ""));
  if (!a.real){ openAcct(born ? "signin" : "age", then); return false; }
  if (!a.age_given){
    if (!born){ openAcct("age", then); return false; }
    try{ a = await backend.setBirth(+born[1], +born[2]); }catch{ toast("Couldn't save that. Check your connection."); return false; }
  }
  if (!a.age_ok){ openAcct("young"); return false; }
  if (a.blocked){ toast("Posting is blocked for this account right now."); return false; }
  return true;
}
function openAcct(mode, then){
  const inv = then === "invite" && store.get("invite", null), who = inv && (inv.name || "A friend");
  $("atitle").textContent = inv && mode !== "age" ? who + " invited you" : { signin: "Sign in to post", age: "One question first", young: "Posting is for 13 and older" }[mode];
  $("anote").textContent = inv && mode === "signin" ? "Sign in with Google and you're friends right away. Your name is never shown to anyone."
    : inv && mode === "join" ? "Tap Join and you're friends right away. No sign-in needed."
    : mode === "signin" ? "Posts and comments come from real accounts, so the rules stick. Your name is never shown, and your birth month and year are kept with the account."
    : mode === "age" ? (inv ? "To join " + who + ", pick the month and year you were born." : "Pick the month and year you were born.")
    : "That goes for comments too. You can still answer every day, judge posts and report anything that looks wrong.";
  $("aage").hidden = mode !== "age"; $("amonth").value = $("ayear").value = "";
  // Joining from an invite asks your name too: it's what your new friend sees.
  const askName = !!inv && (mode === "signin" || mode === "join"); $("aname").hidden = !askName; if (askName) $("aname").value = store.get("myName", "");
  const go = $("ago"); go.hidden = mode === "young"; go.disabled = false;
  go.textContent = mode === "signin" ? "Continue with Google" : mode === "join" ? "Join" : "Continue";
  const named = fn => () => { if (askName){ if (blockedText($("aname").value)){ toast(BLOCK_MSG); return; } const n = cleanName($("aname").value); if (!n){ toast("Type your name first. It's what your friend sees."); $("aname").focus(); return; }
      store.set("myName", n); $("myname").value = n; if (backend.setName) backend.setName(); } fn(); };
  go.onclick = mode === "signin" ? named(() => startSignIn(then, go)) : mode === "join" ? named(() => { go.disabled = true; acceptInvite(); }) : async () => {
    const y = $("ayear").value, m = $("amonth").value;
    if (!y || !m){ toast("Pick a month and a year."); return; }
    saveBorn(y + "-" + m); closeAcct();
    if (then === "invite") return joinInvite();
    if (await gate(then)) resume(then);
  };
  $("acct").hidden = false;
}
function closeAcct(){ $("acct").hidden = true; }
$("aclose").onclick = closeAcct;
$("acct").onclick = e => { if (e.target === $("acct")) closeAcct(); };
async function startSignIn(then, b){
  store.set("afterSignIn", then || "me");
  store.set("draft", then === "post" ? $("ptext").value : then && then.startsWith("comment:") ? $("cinput").value : "");
  b.disabled = true;
  const r = await backend.signIn();
  if (r === "away") return;
  b.disabled = false;
  toast(r === "linking off" ? "Signing in isn't fully switched on yet. Try again later." : "Couldn't start signing in. Check your connection.");
}
// Back on this page from Google with the Back button: the buttons work again.
addEventListener("pageshow", e => { if (e.persisted) for (const id of ["ago", "acctBtn"]) $(id).disabled = false; });
function resume(then){
  const d = store.get("draft", ""); store.set("draft", null);
  if (then === "post") openCompose(d || undefined);
  else if (then && then.startsWith("comment:")){ openSheet(then.slice(8)); if (d) $("cinput").value = d; }
  else if (then === "me") showPage("me");
}
// The database's refusals, in plain words. null: the gate deals with it (signing in, age).
function writeError(e){
  const m = (e && e.message) || "";
  return /blocked words/.test(m) ? BLOCK_MSG
    : /enough posts/.test(m) ? "That's the limit for today. You can post again tomorrow."
    : /enough photo posts/.test(m) ? "That's the limit for photo posts today. Posts without photos can still go."
    : /next public post in \d+/.test(m) ? publicWaitNote(null, +/next public post in (\d+)/.exec(m)[1])
    : /enough comments/.test(m) ? "That's the limit for today. You can comment again tomorrow."
    : /give two different answers/.test(m) ? "Make the two answers different."
    : /answers are 1 to 30/.test(m) ? "Keep each answer to 30 letters."
    : /photos are off/.test(m) ? "Photo posts are switched off right now."
    : /bad photo/.test(m) ? "That photo couldn't be sent. Try a different one."
    : /at most 2 photos/.test(m) ? "Two photos at most."
    : /photo posts/.test(m) ? "Photo posts go to friends, answered Yes or No."
    : /create_post|PGRST202|function/i.test(m) ? "Your own answers need one more setup step. Leave them empty for Yes and No for now."
    : /wait a moment/.test(m) ? "Wait a moment before the next one."
    : /are \d+ to 200 characters/.test(m) ? m[0].toUpperCase() + m.slice(1) + "."
    : /set your place/.test(m) ? "Add your city and state on the Me page first."
    : /closed/.test(m) ? "Posting is paused right now."
    : /judge it first/.test(m) ? "Vote first, then say why."
    : /no such post/.test(m) ? "That post isn't up anymore."
    : /blocked for you/.test(m) ? "Posting is blocked for this account right now."
    : /sign in|age needed|13 and older/.test(m) ? null
    : "Couldn't send it. Check your connection and try again.";
}
// Me: signing in, and the review queue for moderators.
async function renderAccount(){
  const sec = $("account");
  if (!backend || !backend.signIn || !signInReady || under13()){ sec.hidden = true; $("review").hidden = true; return; }
  sec.hidden = false;
  let a = null; try{ a = await backend.account(); }catch{}
  const real = !!(a && a.real), b = $("acctBtn");
  $("acctNote").textContent = real ? "Signed in with Google. Your name is never shown to anyone." : "Sign in to post and comment. Your name is never shown to anyone. Answering and friends work without it.";
  b.hidden = real; b.disabled = false;
  b.onclick = async () => { if (await gate("me")) renderAccount(); };
  renderReview(a);
}
const REASONS = ["Personal info", "Mean or unsafe", "Not a yes or no question", "Spam"];
async function renderReview(a){
  const sec = $("review"); sec.hidden = !(a && a.moderator); if (sec.hidden) return;
  let q; try{ q = await backend.review.queue(); }catch{ $("reviewNote").textContent = "Couldn't load what's waiting. Check your connection."; $("reviewList").replaceChildren(); return; }
  // With auto_approve on, nothing needs a moderator: posts go live at once and slurs are refused before they're saved.
  // Only what people reported is listed, and Review stays hidden when nothing was reported.
  const first = q.review_first !== false;
  if (!first){
    if (!q.reported.length){ sec.hidden = true; return; }
    $("reviewNote").textContent = q.reported.length + (q.reported.length === 1 ? " was" : " were") + " reported. Everything else goes live by itself, and slurs are blocked.";
    $("reviewList").replaceChildren(...q.reported.map(x => reviewRow(x, "reported"))); return;
  }
  const parts = [q.waiting.length ? q.waiting.length + " waiting" : "", q.reported.length ? q.reported.length + " reported" : ""].filter(Boolean);
  $("reviewNote").textContent = !parts.length ? "Nothing waiting. New posts and comments show up here before anyone else sees them."
    : parts.join(" and ") + ". Nothing new shows to others until you approve it.";
  $("reviewList").replaceChildren(...q.waiting.map(x => reviewRow(x, "waiting")), ...q.reported.map(x => reviewRow(x, "reported")));
}
// how: "waiting" (only its writer sees it) or "reported" (it's up, and people reported it).
function reviewRow(x, how){
  const d = el("div", "ritem"), acts = el("div", "racts"), w = x.writer || {};
  // The writer's record counts this one too once it's up, so leave it out.
  const ok = Math.max(0, (w.approved || 0) - (how === "waiting" ? 0 : 1)), no = w.turned_down || 0;
  d.append(el("div", "rmeta", [x.kind === "post" ? (x.photos ? "Photo post" : "Post") : "Comment",
    how === "reported" ? x.reports + (x.reports === 1 ? " report" : " reports") + (x.hidden ? ", hidden until you decide" : "")
      : ago(x.t) + " ago",
    ok + no ? ok + " approved and " + no + " turned down before" : "First one from this writer"].join(" · ")));
  if (x.on) d.append(el("p", "ron", "On “" + x.on + "”"));
  d.append(el("p", "", x.body));
  // A photo post's photos, blurred until the moderator taps them, so nothing is seen by surprise.
  if (x.photos && backend.review.photos){
    const ph = el("button", "rphotos"); ph.setAttribute("aria-label", "Show the photos"); d.append(ph);
    ph.onclick = () => { ph.classList.add("open"); ph.setAttribute("aria-label", "Photos"); };
    backend.review.photos(x.id).then(list => ph.replaceChildren(...(list.length
      ? [...list.map((b, i) => { const im = el("img"); im.src = "data:image/jpeg;base64," + b; im.alt = "Photo " + (i + 1); return im; }), el("span", "rtap", "Tap to see")]
      : [el("span", "rmeta", "The photos were deleted 30 days after it was posted.")]))).catch(() => ph.replaceChildren(el("span", "rmeta", "Couldn't load the photos.")));
  }
  const done = async fn => {
    for (const k of acts.querySelectorAll("button")) k.disabled = true;
    try{ await fn(); }catch(e){ toast(/already decided/.test((e && e.message) || "") ? "That one was already decided." : "Couldn't save that. Try again."); }
    renderReview(await backend.account(true).catch(() => null)); if (ask.api && ask.api.refresh) ask.api.refresh();
  };
  const btn = (label, cls, fn) => { const b = el("button", cls, label); b.onclick = fn; acts.append(b); return b; };
  const why = decision => {
    acts.replaceChildren(el("span", "rmeta", "Why? The writer sees this."));
    REASONS.forEach(r => btn(r, "b2 soft", () => done(() => backend.review.decide(x.kind, x.id, decision, r))));
    btn("Cancel", "lnk", () => d.replaceWith(reviewRow(x, how)));
  };
  if (how === "reported"){ btn("Keep", "b2", () => done(() => backend.review.decide(x.kind, x.id, "keep"))); btn("Remove", "b2 soft", () => why("remove")); }
  else { btn("Approve", "b2", () => done(() => backend.review.decide(x.kind, x.id, "approve"))); btn("Reject", "b2 soft", () => why("reject")); }
  const blk = btn("Block writer for 7 days", "b2 soft", () => {
    if (!blk.dataset.armed){ blk.dataset.armed = "1"; blk.textContent = "Tap again to block for 7 days"; return; }
    done(() => backend.review.block(x.kind, x.id, 7, "Blocked for 7 days by a moderator"));
  });
  d.append(acts); return d;
}

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
  if (fresh){ store.set("badges", had); if (had.length > 1){ setTimeout(() => { toast("New badge: " + fresh); haptics.badge(); }, 1400); } }
}
function renderMe(){
  const s = streakNow(), p = profile();
  $("meta").textContent = "No. " + (today + 1);
  $("streak").textContent = s.current;
  $("streakNote").textContent = streakNote(streakState(), today, p.nAnswered);
  $("otype").textContent = p.type || "–";
  $("otypeNote").textContent = p.type ? "your opinion type" : "opinion type, " + (3 - p.nTyped) + " more to unlock";
  $("agree").textContent = p.judged ? p.maj + "/" + p.judged : "–";
  $("answered").textContent = p.nAnswered;
  // Only badges you have. No locked ones to collect, and none for features that are switched off.
  const earned = BADGES.filter(([, , test]) => test(p));
  $("badges").replaceChildren(...earned.map(([, label]) => el("span", "", label))); $("badgesNote").hidden = earned.length > 0;
  const r = recapData(), rb = $("recapBody"); $("recap").hidden = !r || r.answered < 2; rb.innerHTML = "";
  if (r){ const row = (a, b) => { const d = el("div"); d.append(el("b", "", a), el("span", "", b)); rb.append(d); };
    row("Days answered", r.answered + " of 7"); if (r.known) row("With the majority", r.maj + " of " + r.known); row("Streak", r.s + (r.s === 1 ? " day" : " days"));
    if (r.rarest !== undefined){ const v = myVotes[dayKey(r.rarest)], [q, o] = qFor(r.rarest); row("Rarest take", o[v.choice] + ", " + v.share + "%"); } }
  renderFriends(); renderRequests(); renderAccount();
}
// Your friend code. On the live site it exists once you've answered (that's when your account is made).
function showCode(){
  const put = c => { const ok = /^[A-Z2-9]{6}$/.test(c || ""); $("mycode").textContent = ok ? c : "······"; $("copycode").hidden = !ok; $("codeNote").hidden = ok; };
  put(myCode());
  if (backend) backend.profile().then(p => { if (p && p.code){ store.set("myCode:" + backend.mode, p.code); put(p.code); } }).catch(() => {});
}
$("copycode").onclick = () => { const c = myCode(); if (c) copyOrShow(c, "Code copied. Your friend types it in Add a friend."); };
// Your friends and how often you agree. Placeholder rows show while the matches load.
// A match needs you both to have added each other, and 3 past questions you both answered.
let friendsCall = 0;
async function renderFriends(){
  const fl = friends(), box = $("flist"), call = ++friendsCall, live = !!backend && backend.mode === "live", old = c => live && addedIn(c) !== "live";
  // by: undefined while loading, null when it can't be checked yet, else the matches by code
  const draw = (by, failed) => {
    box.innerHTML = "";
    fl.map(c => { const r = by && by[c]; return { c, r, m: r && r.agree !== null && r.shared ? pct(r.agree, r.shared) : null }; })
      .sort((a, b) => (b.m ?? -1) - (a.m ?? -1))
      .forEach(({ c, r, m }) => {
        const t = old(c) ? "Added before Verd went live. Send them your new invite link." : failed ? "" : by === undefined ? "Loading"
          : by === null ? (live ? "Matches start after your first answer." : "When Verd goes live, swap new invite links to compare.")
          : !r ? (live ? "Request sent. Waiting for them to accept." : "No shared answers yet")
          : m === null ? (r.shared ? r.shared + " shared " + (r.shared === 1 ? "answer" : "answers") + " so far" : "No shared answers yet")
          : (m >= 80 ? "Same brain, " : m <= 30 ? "Opposites, " : "") + m + "% match";
        const d = el("div"), x = el("button", "fx", "×"), who = el("div", "who"); x.setAttribute("aria-label", "Remove " + (nick(c) || "this friend")); x.onclick = () => removeFriend(c);
        who.append(el("b", "", nick(c) || "New friend"));
        d.append(who, el("span", by === undefined && !failed && !old(c) ? "sk" : "", t), x); box.append(d); });
    if (failed) box.append(el("p", "note", "Couldn't load your matches. Check your connection."));
  };
  if (!fl.length){ box.innerHTML = ""; return; }
  draw(undefined);
  let rows = null, failed = false;
  try{ if (backend) rows = await backend.friendMatch(live ? liveFriends() : fl); keepNames(rows); }catch{ failed = true; }
  if (call === friendsCall) draw(rows ? Object.fromEntries(rows.map(r => [r.code, r])) : null, failed);
}
$("recapShare").onclick = () => { const r = recapData(), p = profile(); if (!r) return;
  copyOrShow("My week on Verd\n" + r.answered + "/7 days answered" + (r.known ? ", with the majority " + r.maj + " of " + r.known + " times" : "") + "\n" + (p.type ? "I'm a " + p.type + ". " : "") + r.s + " day streak\nWhat are you? " + inviteUrl(), "Copied. Post it anywhere."); };
// ---------- Invites ----------
// Your invite link is the site plus #f=CODE&n=Name. Nothing after the # is ever sent to a server, and the
// name is optional. Opening a friend's link adds them on your phone; the link is then cleared from the address bar.
const cleanName = s => String(s || "").normalize("NFC").replace(/[^\p{L}\p{M} '’-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 24);
// tok: an invite from the database. Whoever joins with it is your friend both ways, with no request to accept.
function inviteUrl(tok){
  const c = myCode(), n = cleanName(store.get("myName", ""));
  return siteUrl() + (/^[A-Z2-9]{6}$/.test(c) ? "#" + (tok ? "i=" + tok + "&" : "") + "f=" + c + (n ? "&n=" + encodeURIComponent(n) : "") : "");
}
// Your name is needed before you invite, add or accept anyone, so friends always see a name, never a code.
function needName(){
  if (cleanName(store.get("myName", ""))) return false;
  const e = $("nameErr"); e.hidden = false; $("myname").focus(); $("myname").scrollIntoView({ block: "center" });
  return true;
}
$("invite").onclick = async () => {
  if (needName()) return;
  if (!/^[A-Z2-9]{6}$/.test(myCode())){ toast("Your invite link is ready after your first answer."); return; }
  const tok = backend && backend.myInvite ? await backend.myInvite() : null;
  const text = tok ? "Join me on Verd. Sign in and we're friends right away." : "Answer today's question on Verd, then we can see how often we agree.", url = inviteUrl(tok);
  try{ if (navigator.share){ await navigator.share({ title: "What's the Verd?", text, url }); return; } }catch(e){ if (e && e.name === "AbortError") return; }
  copyOrShow(text + " " + url, "Invite link copied. Send it to a friend.");
};
$("joinInv").onclick = () => joinInvite();
$("myname").value = store.get("myName", "");
$("myname").onchange = () => { if (blockedText($("myname").value)){ toast(BLOCK_MSG); $("myname").value = store.get("myName", ""); return; }
  const v = cleanName($("myname").value); $("myname").value = v; store.set("myName", v); if (v) $("nameErr").hidden = true; if (backend && backend.setName) backend.setName(); };
$("myname").oninput = () => { if (cleanName($("myname").value)) $("nameErr").hidden = true; };
function takeInvite(){
  const h = new URLSearchParams(location.hash.slice(1)), code = (h.get("f") || "").trim().toUpperCase();
  if (!h.has("f")) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (!/^[A-Z2-9]{6}$/.test(code)) return;
  if (ownCode(code)){ toast("That's your own invite link."); return; }
  const name = cleanName(h.get("n")), tok = (h.get("i") || "").toLowerCase();
  if (name) store.set("nicks", { ...store.get("nicks", {}), [code]: name });
  addFriend(code);
  // An invite from the database: joining makes you friends both ways. Offered once Verd knows whether Google is on.
  if (/^[0-9a-f]{32}$/.test(tok) && modeNow() === "live"){ store.set("invite", { tok, code, name }); if (inviteReady) joinInvite(); return; }
  // Before Verd is live there's nothing to compare yet, so the toast doesn't promise it.
  toast("Added " + (name || "your friend") + "." + sentLine(name));
  if (!$("me").hidden) renderMe();
}
addEventListener("hashchange", takeInvite);
// What happens after you add someone: on the live site they get a friend request to accept. That goes out once
// you have an account (your first answer), since nothing is sent before that.
function sentLine(name){
  if (modeNow() === "device") return "";
  return backend && backend.hasAccount && backend.hasAccount() ? " " + (name || "They") + " will see your friend request on their Me tab."
    : " Answer today's question and " + (name || "they") + " will get your friend request.";
}
// Joining from an invite link. 13 or older: the month and year, then Google, and you're friends. Under 13, or
// with Google sign-in off: one tap to join, with no Google. Nothing happens until you tap, so opening a link
// still makes no account. Not now keeps the invite until you join from Me.
let inviteReady = false;
async function joinInvite(){
  const inv = store.get("invite", null); if (!inv || !backend || !backend.acceptInvite) return;
  const born = /^(\d{4})-(\d{2})$/.test(store.get("born", ""));
  let real = false; try{ real = signInReady && !!(await backend.account(true)).real; }catch{}
  const named = !!cleanName(store.get("myName", ""));
  if (real && named) return acceptInvite();
  if (!born) return openAcct("age", "invite");
  if (real) return openAcct("join", "invite");
  openAcct(signInReady && !under13() ? "signin" : "join", "invite");
}
async function acceptInvite(){
  const inv = store.get("invite", null); if (!inv) return;
  closeAcct();
  try{
    const r = await backend.acceptInvite(inv.tok); store.set("invite", null);
    if (r && r.own){ toast("That's your own invite link."); return; }
    keepNames([r]); if (!friends().includes(r.code)) addFriend(r.code);
    toast("You and " + (r.name || inv.name || "your friend") + " are friends now."); checkBadges();
  }catch(e){
    if (/invite expired/.test((e && e.message) || "")){ store.set("invite", null); toast("That invite has run out. Ask " + (inv.name || "your friend") + " for a new link."); }
    else toast("Couldn't join. Check your connection and try again.");
  }
  showCode(); renderMe(); order = []; renderFeed();
}
// Friend requests on Me: Accept adds them back (that's all a match needs), Not now hides it on this phone.
let reqCall = 0;
async function renderRequests(){
  const box = $("freqs"), call = ++reqCall;
  let rows = null; try{ if (backend && backend.friendRequests) rows = await backend.friendRequests(); }catch{}
  if (call !== reqCall) return;
  keepNames(rows);
  // Someone who joined from your invite link is added back by itself: your link was your yes.
  const joined = (rows || []).filter(r => r.invited && !friends().includes(r.code) && !ownCode(r.code));
  if (joined.length){ for (const r of joined) addFriend(r.code); toast(joined.length === 1 ? (joined[0].name || "Someone") + " joined from your invite. You're friends now." : joined.length + " friends joined from your invite."); checkBadges(); renderFriends(); }
  const inv = store.get("invite", null); $("joinInv").hidden = !inv;
  if (inv) $("joinInv").textContent = "Join " + (inv.name || "your friend") + "'s invite";
  const no = store.get("declined", []), fl = friends();
  const list = (rows || []).filter(r => !fl.includes(r.code) && !no.includes(r.code) && !ownCode(r.code));
  $("meDot").hidden = !list.length; box.hidden = !list.length; box.replaceChildren(); if (!list.length) return;
  box.append(el("div", "clabel", list.length === 1 ? "1 friend request" : list.length + " friend requests"));
  for (const r of list){
    const row = el("div", "freq"), top = el("div", "line"), ok = el("button", "b2", "Accept"), x = el("button", "b2 soft", "Not now"), who = r.name || "Someone";
    top.append(el("b", "rname", who), el("span", "note", "added you " + ago(r.t) + " ago"));
    ok.onclick = () => { if (needName()) return;
      addFriend(r.code); toast("You and " + who + " are friends now."); checkBadges(); renderMe(); order = []; renderFeed(); };
    x.onclick = () => { store.set("declined", [...no.filter(c => c !== r.code), r.code]); renderRequests(); };
    const acts = el("div", "line"); acts.append(ok, x); row.append(top, acts); box.append(row);
  }
}
// Add a friend: their 6-character code, or their whole invite link pasted in. Spaces, dashes and lower case are fine.
// What went wrong is said right under the box, so a name typed in the wrong box is easy to spot.
function readFriend(raw){
  const v = String(raw || "").trim(), link = /[#&?]f=([^&\s]*)/i.exec(v);
  if (link){ const n = /[#&?]n=([^&\s]*)/i.exec(v); let name = ""; try{ name = n ? decodeURIComponent(n[1].replace(/\+/g, " ")) : ""; }catch{}
    return { code: link[1].toUpperCase(), name: cleanName(name) }; }
  return { code: v.toUpperCase().replace(/[\s-]/g, ""), name: "" };
}
function friendError(v){
  const { code } = readFriend(v);
  if (!code) return "Type your friend's code, or paste their invite link.";
  if (/\s/.test(v.trim()) && /^[\p{L} '’-]+$/u.test(v.trim()) || /^[\p{L}'’-]+$/u.test(v.trim()) && v.trim().length > 6)
    return "That looks like a name. Your name goes in the Your name box above. Here, type the 6-character code your friend sees on their Me tab.";
  if (/[^A-Z0-9]/.test(code)) return "A code is only letters and numbers, like K7MPX2.";
  if (code.length !== 6) return "A code is 6 letters and numbers. That one has " + code.length + ".";
  if (/[01IO]/.test(code)) return "Codes never use 0, 1, I or O. Check the code with your friend.";
  if (code === $("mycode").textContent || ownCode(code)) return "That's your own code. Type your friend's code instead.";
  return "";
}
const showFerr = m => { $("ferr").textContent = m; $("ferr").hidden = !m; $("fcode").setAttribute("aria-invalid", m ? "true" : "false"); };
$("fcode").oninput = () => { if (!$("ferr").hidden) showFerr(""); };
$("fform").onsubmit = e => { e.preventDefault();
  if (needName()) return;
  const v = $("fcode").value, err = friendError(v); if (err){ showFerr(err); $("fcode").focus(); return; }
  const r = readFriend(v), name = cleanName($("fnick").value) || r.name, had = friends().includes(r.code);
  if (name) store.set("nicks", { ...store.get("nicks", {}), [r.code]: name });
  if (!had) addFriend(r.code);
  $("fcode").value = $("fnick").value = ""; showFerr(""); document.activeElement && document.activeElement.blur();
  const who = name || "your friend", mine = myCode();
  toast(had ? (name ? "Renamed to " + name + "." : who + " is already on your list.") : "Added " + who + "." + sentLine(name));
  checkBadges(); renderMe(); order = []; renderFeed(); };
function ageOptions(month, year){
  const pick = (s, label) => { const o = new Option(label, "", true, true); o.disabled = true; s.add(o); };
  pick(month, "Month"); pick(year, "Year");
  ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    .forEach((m, i) => month.add(new Option(m, String(i + 1).padStart(2, "0"))));
  for (let y = new Date().getFullYear(); y >= 1920; y--) year.add(new Option(String(y), String(y)));
}
// The age answer on this phone. Under 13: state and city are cleared and no longer used.
function saveBorn(v){
  store.set("born", v);
  if (!ageOk()){ store.set("state", ""); store.set("city", ""); $("mystate").value = $("mycity").value = ""; if (ask.scope === "state" || ask.scope === "city") ask.scope = "world"; }
  drawPlace(); renderTop(); order = []; renderFeed();
}
function setupPlace(){
  const sel = $("country");
  Object.entries(COUNTRIES).sort((a, b) => a[0] === "XX" ? 1 : b[0] === "XX" ? -1 : a[1].localeCompare(b[1])).forEach(([cc, name]) => sel.add(new Option(flag(cc) + "  " + name, cc)));
  sel.value = guessCountry(); $("mycity").value = store.get("city", ""); $("mystate").value = store.get("state", "");
  const changed = () => { order = []; renderFeed(); };
  sel.onchange = () => { store.set("country", sel.value); changed(); };
  $("mycity").onchange = () => { store.set("city", $("mycity").value.trim()); changed(); };
  $("mystate").onchange = () => { store.set("state", $("mystate").value.trim()); changed(); };
  // The age question: month and year, nothing chosen until you choose.
  ageOptions($("bmonth"), $("byear")); ageOptions($("amonth"), $("ayear"));
  $("bmonth").onchange = $("byear").onchange = () => { if ($("bmonth").value && $("byear").value) saveBorn($("byear").value + "-" + $("bmonth").value); };
  drawPlace();
}
function drawPlace(){
  const asked = bornAt() != null, ok = ageOk();
  $("ageAsk").hidden = asked; $("placeFields").hidden = !ok; if (under13()) $("suggest").hidden = true;
  $("placeNote").textContent = asked && !ok ? "State and city are for people 13 and older, so Verd only uses your country."
    : "Used to compare answers with people near you. Never your exact location.";
}

// ---------- Search ----------
const SEARCH_ICON = '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>';
const CLOCK_ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>';
const searchable = () => ask.api ? ask.posts.filter(p => visible(p, true)) : [];
const heat = p => totalOf(p) + 2 * liveComments(p).length;
function remember(q){ q = q.trim(); if (q.length < 2) return; store.set("recentQ", [q, ...store.get("recentQ", []).filter(x => norm(x) !== norm(q))].slice(0, 8)); }
function highlight(text, words){
  const frag = document.createDocumentFragment(); if (!words.length){ frag.append(text); return frag; }
  const re = new RegExp("(" + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "ig");
  text.split(re).forEach((part, i) => frag.append(i % 2 ? el("mark", "", part) : part)); return frag;
}
function openPost(id){
  pickedScope = true;
  if (id === "daily"){ ask.scope = "world"; order = []; renderTop(); showPage("feed"); renderFeed(); $("feed").scrollTop = 0; return; }
  const p = ask.posts.find(x => x.id === id); if (!p) return;
  ask.scope = p.scope; order = []; jumpTo = id; renderTop(); showPage("feed"); renderFeed();
}
function resultRow(p, words, onTap){
  const b = el("button", "res"), mini = el("div", "mini"), rb = el("div", "rb");
  hue(mini, p.colorPair || COLORS[(typeof p.color === "number" ? p.color : hash(p.id)) % COLORS.length]);
  if (p.imgs && p.imgs.length){ const im = el("img"); im.src = p.imgs[0]; im.alt = ""; mini.append(im); } else mini.append(el("span", "", p.badge || "?"));
  const t = el("div", "rt"); t.append(highlight(p.text, words));
  rb.append(t, el("div", "rm", p.meta)); b.append(mini, rb); b.onclick = onTap; return b;
}
const badgeOf = p => { const t = totalOf(p); return (ask.myVotes[p.id] || p.author === ask.api.me) && t && p.yes != null ? pct(p.yes, t) + "%" : "?"; };
function postMeta(p){
  const total = totalOf(p), nC = liveComments(p).length, seenIt = ask.myVotes[p.id] || p.author === ask.api.me, lab = sideLabels(p);
  return [placeLabel(p), total + (total === 1 ? " vote" : " votes"), nC ? nC + (nC === 1 ? " comment" : " comments") : "", seenIt && total && p.yes != null ? pct(p.yes, total) + "% " + lab[0] : "Tap to judge"].filter(Boolean).join(" · ");
}
function section(title, action){ const sec = el("div"), h = el("div", "shd"); h.append(el("h3", "", title)); if (action) h.append(action); sec.append(h); return sec; }
function renderSearch(){
  const raw = $("q").value, q = norm(raw), box = $("sres"); box.innerHTML = ""; $("qclear").hidden = !raw;
  const posts = searchable(), days = aired();
  if (!q){
    const recent = store.get("recentQ", []);
    if (recent.length){
      const clr = el("button", "lnk", "Clear"); clr.onclick = () => { store.set("recentQ", []); renderSearch(); };
      const sec = section("Recent", clr);
      for (const r of recent){ const row = el("div", "rrow"); row.innerHTML = CLOCK_ICON; const go = el("span", "", r); go.style.cursor = "pointer"; go.onclick = () => { $("q").value = r; renderSearch(); };
        const x = el("button", "rx", "×"); x.setAttribute("aria-label", "Remove"); x.onclick = () => { store.set("recentQ", recent.filter(y => y !== r)); renderSearch(); }; row.append(go, x); sec.append(row); }
      box.append(sec);
    }
    // Topics with questions out so far or debates, then the ones coming up next. Never a dead "Be the first".
    const stats = TOPICS.map(([id, name, , ci], i) => { const ps = posts.filter(p => p.cat === id), nq = days.filter(n => topicOfDay(n) === id).length;
        return { id, name, ci, i, nq, n: ps.length, heat: ps.reduce((a, p) => a + heat(p), 0), soon: daysUntil(d => topicOfDay(d) === id) }; })
      .filter(t => t.nq || t.n || t.soon)
      .sort((a, b) => b.heat - a.heat || (b.nq + b.n) - (a.nq + a.n) || (a.soon || 99) - (b.soon || 99) || a.i - b.i).slice(0, 6);
    const trending = stats.some(t => t.heat > 0), sec = section(trending ? "Trending topics" : "Topics"), grid = el("div", "topics");
    stats.forEach((t, i) => { const b = hue(el("button", "topic"), COLORS[t.ci]);
      if (trending){ const rk = el("span", "rk", String(i + 1)); rk.setAttribute("aria-hidden", "true"); b.append(rk); }
      const what = [t.nq ? t.nq + (t.nq === 1 ? " question" : " questions") : "", t.n ? t.n + (t.n === 1 ? " debate" : " debates") : ""].filter(Boolean).join(" · ");
      b.append(el("b", "", t.name), el("small", "", what || "Next one " + inDays(t.soon)));
      b.onclick = () => { $("q").value = t.name; remember(t.name); renderSearch(); }; grid.append(b); });
    sec.append(grid); box.append(sec);
    const qs = section("Questions so far"); for (const n of days.slice(0, 6)) qs.append(dayRow(n, [], "")); box.append(qs);
    const hot = posts.filter(p => heat(p) > 0).sort((a, b) => heat(b) - heat(a)).slice(0, 5);
    if (hot.length){ const hs = section("Hot debates"); for (const p of hot) hs.append(resultRow({ ...p, meta: postMeta(p), badge: badgeOf(p) }, [], () => openPost(p.id))); box.append(hs); }
    return;
  }
  const words = q.split(/\s+/).filter(w => w.length > 0), topic = TOPICS.find(([id, name]) => norm(name) === q || norm(name).startsWith(q) && q.length >= 3 || id === q);
  const hasWords = d => words.every(w => norm(qFor(d)[0]).includes(w));
  const qHits = days.filter(n => hasWords(n) || (topic && topicOfDay(n) === topic[0]));
  const hits = posts.map(p => { const t = norm(p.text), m = words.filter(w => t.includes(w)).length, on = topic && p.cat === topic[0];
      return { p, score: (m === words.length ? 10 : m * 2) + (on ? 6 : 0) + Math.log1p(heat(p)) }; })
    .filter(h => h.score >= 6).sort((a, b) => b.score - a.score).map(h => h.p);
  const out = section(topic ? topic[1] : "Results");
  for (const n of qHits) out.append(dayRow(n, topic ? [] : words, raw));
  for (const p of hits.slice(0, 30)) out.append(resultRow({ ...p, meta: postMeta(p), badge: badgeOf(p) }, topic && !words.some(w => norm(p.text).includes(w)) ? [] : words, () => { remember(raw); openPost(p.id); }));
  const found = out.children.length > 1; if (found) box.append(out);
  // A question that hasn't dropped yet is announced, never shown: "Something on pizza is coming up."
  const soon = qHits.length ? 0 : daysUntil(d => topic ? topicOfDay(d) === topic[0] : hasWords(d)), e = el("div", "sempty");
  if (soon) e.append(el("h2", "", (topic ? topic[1] + " questions are" : "Something on “" + raw.trim() + "” is") + " coming up."), el("p", "note", "The next one drops " + inDays(soon) + "."));
  else {
    e.append(el("h2", "", found ? "Got a take on " + raw.trim() + "?" : "Nothing on “" + raw.trim() + "” yet."));
    // Where posting isn't open, the next step is suggesting it as a question for everyone.
    const act = postingOpen() ? ["Start a debate", found ? "Put it up and let people decide." : "Be the first. Ask it and let people decide.", () => { remember(raw); openCompose(topic ? "" : asQuestion(raw)); }]
      : canSuggest() ? ["Suggest it as a daily question", "Good ones become the question for everyone.", () => { remember(raw); suggestFrom(topic ? "" : asQuestion(raw)); }] : null;
    if (act){ const go = el("button", "b2", act[0]); go.onclick = act[2]; e.append(el("p", "note", act[1]), go); }
  }
  box.append(e);
}
const asQuestion = s => s.trim().replace(/\?*$/, "") + "?";
function suggestFrom(text){ $("sq").value = text; showPage("me"); setTimeout(() => $("suggest").scrollIntoView({ block: "center", behavior: calm() ? "auto" : "smooth" }), 350); }
// A daily question in search: today's opens the feed, an older one opens its final verdict.
function dayRow(n, words, raw){
  const [dq, o] = qFor(n), mine = myVotes[dayKey(n)], counted = !backend || backend.mode !== "device";
  const meta = [n === today ? "Today's question" : dateLabel(n), n === today && res && res.world && res.world.n ? num(res.world.n) + " answers" : "",
    mine ? "You said " + o[mine.choice] : n === today ? "Tap to answer" : counted ? "See the verdict" : ""].filter(Boolean).join(" · ");
  return resultRow({ id: "day" + n, text: dq, colorPair: COLORS[n % COLORS.length], badge: "No." + (n + 1), meta }, words, () => { if (raw.trim()) remember(raw); if (n === today) openPost("daily"); else openDay(n); });
}

// ---------- A past question: its final verdict, full screen ----------
let dayOpen = -1;
function openDay(n){
  const key = dayKey(n), cached = store.get("res:" + key, null);
  dayOpen = n; drawDay(n, cached || undefined); $("dayview").hidden = false; paintStatusBar();
  if (!backend || !backend.results) return;
  backend.results(key, qFor(n)[1].length, myPlace()).then(r => { if (dayOpen === n) drawDay(n, r || null); }, () => { if (dayOpen === n && !cached) drawDay(n, null); });
}
function closeDay(){ dayOpen = -1; $("dayview").hidden = true; paintStatusBar(); }
const drawDay = (n, r) => $("dayslot").replaceChildren(daySlide(n, r));
// r: that day's results. undefined while they load, null if they couldn't be loaded.
function daySlide(n, r){
  const [dq, o] = qFor(n), mine = myVotes[dayKey(n)], c = r ? countsOf(r.world) : null, total = r && r.world ? r.world.n : 0;
  const s = shell("past", COLORS[n % COLORS.length]), body = el("div", "sbody");
  body.append(el("div", "kicker", "No. " + (n + 1) + " · " + dateLabel(n)), el("h2", "stext" + sizeClass(dq), dq));
  let lines;
  if (r === undefined) lines = ["Loading the verdict…"];
  else if (r === null) lines = ["Couldn't load the verdict.", "Check your connection and try again."];
  else if (c) lines = [finalLine(c, o, mine)];
  else if (r.mode === "device") lines = [mine ? "You said " + o[mine.choice] + "." : "You didn't answer this one.", "Live results weren't switched on yet, so there's no verdict."];
  else if (!total) lines = ["Nobody answered this one on Verd."];
  else lines = ["Not enough answers for a verdict.", num(total) + (total === 1 ? " person" : " people") + " answered. A verdict needs " + num((r.min && r.min.world) || CONFIG.min.world) + "."];
  body.append(el("p", "sverdict", lines[0])); if (lines[1]) body.append(el("p", "ssub", lines[1]));
  if (r === null){ const b = el("button", "cta ghost", "Try again"); b.onclick = () => openDay(n); body.append(b); }
  const box = answers("past", o, c ? shares(c) : null, mine ? mine.choice : -1, () => {}, false);
  for (const b of box.children) b.disabled = true;
  if (r === undefined) box.classList.add("wait");
  const foot = el("div", "sfoot"); foot.append(el("span", "sinfo", total ? num(total) + (total === 1 ? " answer" : " answers") : ""), el("div", "sacts"));
  s.append(body, box, foot); return s;
}
$("dclose").onclick = closeDay;
$("q").oninput = renderSearch;
$("q").onkeydown = e => { if (e.key === "Enter"){ remember($("q").value); $("q").blur(); } };
$("qclear").onclick = () => { $("q").value = ""; renderSearch(); $("q").focus(); };
$("qcancel").onclick = () => { $("q").value = ""; showPage("feed"); };

// ---------- Works offline ----------
// sw.js keeps Verd on the phone, so it opens with no connection and answers wait in the outbox (notes in sw.js).
// Only the real site registers it: the claude.ai preview has no manifest.
if ("serviceWorker" in navigator && document.querySelector('link[rel="manifest"]')){
  const register = () => navigator.serviceWorker.register("sw.js").catch(() => {});
  if (document.readyState === "complete") register(); else addEventListener("load", register);
}

// ---------- Navigation ----------
function showPage(name){ withTransition(() => showPageNow(name)); }
// Installed on an iPhone, the status bar takes the page's theme colour. It matches whatever fills the top of the
// screen: black over the feed, a past question and a new post; the page's own background over Me and Search.
const themeMeta = document.querySelector('meta[name="theme-color"]');
function paintStatusBar(){
  if (!themeMeta) return;
  const paged = document.querySelector(".app").classList.contains("paged") && $("dayview").hidden && $("compose").hidden;
  themeMeta.content = getComputedStyle(document.documentElement).getPropertyValue(paged ? "--bg" : "--feed-bg").trim();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", paintStatusBar);
function showPageNow(name){
  $("me").hidden = name !== "me"; $("search").hidden = name !== "search"; document.querySelector(".app").classList.toggle("paged", name !== "feed");
  $("navHome").classList.toggle("on", name === "feed"); $("navSearch").classList.toggle("on", name === "search"); $("navMe").classList.toggle("on", name === "me");
  if (name === "search"){ renderSearch(); $("search").scrollTop = 0; setTimeout(() => $("q").focus(), 60); }
  if (name === "me"){ renderMe(); $("me").scrollTop = 0; }
  paintStatusBar();
}
$("navSearch").onclick = () => showPage("search");
$("navHome").onclick = () => { if ($("me").hidden && $("search").hidden) $("feed").scrollTo({ top: 0, behavior: "smooth" }); showPage("feed"); };
$("navMe").onclick = () => showPage("me");
$("navPlus").onclick = openCompose;
// Every 30 s the countdowns move on. When a new day starts while Verd is open it reloads for the new question,
// unless you're in the middle of writing something (then on the next tick, or when you come back to it).
function tick(){
  if (dayNum() !== today){ const a = document.activeElement; if ($("compose").hidden && $("sheet").hidden && $("acct").hidden && !(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) location.reload(); return; }
  setFoot($("feed").querySelector('.slide[data-id="daily"] .sinfo'), dailyFoot());
  for (const e of document.querySelectorAll("[data-tick=drop]")) e.textContent = dropLine();
}
setInterval(tick, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
document.addEventListener("keydown", e => { if (e.key !== "Escape") return; if (!$("acct").hidden) closeAcct(); else if (!$("dayview").hidden) closeDay(); else if (!$("sheet").hidden) closeSheet(); else if (!$("compose").hidden) closeCompose(); });

(async function start(){
  setupPlace(); renderTop(); renderFeed(); takeInvite();
  // Answered on the page painted from index.html, before this file arrived? It counts: same frame, no flash.
  const early = window.verdTap; window.verdTap = null;
  if (early && early.day === todayKey) vote(early.i, $("feed").querySelectorAll('.slide[data-id="daily"] .ans')[early.i], true);
  ready = pickBackend(); backend = await ready;
  // Back from signing in with Google? Finish that before anything asks the database who you are.
  const signedIn = backend.finishSignIn ? await backend.finishSignIn() : null;
  if (signedIn === "away") return;
  $("mode").textContent = backend.label;
  showCode(); renderNet();
  if (friends().length && backend.setFriends) backend.setFriends();
  renderRequests();
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") renderRequests(); });
  // People's posts. The + button shows only where posting is open.
  const watchPosts = () => { ask.api = backend.ask; $("navPlus").hidden = !postingOpen();
    ask.api.watch((posts, mv, mr) => { ask.posts = posts; ask.myVotes = { ...mv, ...ask.myVotes }; ask.myReports = { ...mr, ...ask.myReports }; checkFlips(); renderTop(); renderFeed(); if (sheetPost) renderSheet(); if (!$("search").hidden) renderSearch(); $("navPlus").hidden = !postingOpen(); }); };
  if (backend.ask && !backend.ask.live) watchPosts();
  // On the live site, posts load only once Google sign-in is switched on. Until then the site is exactly the
  // daily question; after that, posting itself opens when Verd has a moderator (the database decides).
  // Google on before the posting part of setup.sql is installed (the setup done in another order): the first
  // load finds no get_posts, so sign-in stays hidden until the database can keep an account.
  if (backend.authSettings) (async () => {
    const s = await backend.authSettings(); signInReady = !!(s && s.external && s.external.google);
    if (signInReady){ watchPosts(); await backend.ask.refresh(); if (backend.ask.missing){ signInReady = false; $("navPlus").hidden = true; } }
    if (signInReady){ const a = await backend.account().catch(() => null); signedInReal = !!(a && a.real); if (signedInReal){ renderTop(); friendsFirst(); } }
    renderEnd(); if (!$("me").hidden) renderAccount();
    if (signedIn !== "ok"){ inviteReady = true; joinInvite(); }
    if (signedIn === "ok"){
      toast("Signed in."); showCode();
      const then = store.get("afterSignIn", "me"); store.set("afterSignIn", null);
      if (then === "invite"){ inviteReady = true; acceptInvite(); }
      else if (signInReady){
        await ask.api.refresh();
        const ok = await gate(then);
        if (then === "me") showPage("me"); else if (ok) resume(then);
      }
    } else if (signedIn === "failed") toast("Signing in didn't finish. Try again.");
  })();
  if (backend.suggest){
    $("suggest").hidden = !canSuggest();
    $("sform").onsubmit = async e => { e.preventDefault();
      const q = $("sq").value.trim(), a = $("sa").value.split(",").map(s => s.trim()).filter(Boolean);
      if (a.length < 2 || a.length > 4){ toast("Give 2 to 4 answers, separated by commas."); return; }
      $("ssend").disabled = true;
      try{ await backend.suggest(q, a); $("sform").reset(); toast("Sent. Watch for it."); }catch{ toast("Couldn't send it. Try again."); }
      $("ssend").disabled = false; };
  }
  backend.watch(todayKey, options.length, myPlace(), onToday);
  if (today > 0){
    const yKey = dayKey(today - 1), yo = qFor(today - 1)[1];
    backend.watch(yKey, yo.length, myPlace(), r => { if (!r) return; yres = r; noteShare(yKey, r); renderFeed(); });
  }
  // Answered today before the database was switched on? Send it now (the database keeps only one).
  if (backend.mode === "live" && myVotes[todayKey] && store.get("sent") !== todayKey)
    backend.vote(todayKey, myVotes[todayKey].choice, options.length, myPlace()).then(ok => { if (ok) store.set("sent", todayKey); });
  renderFeed(); checkBadges();
})();
