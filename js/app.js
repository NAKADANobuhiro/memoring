import { log, meta, uuid, deviceId } from "./store.js";
import * as dbx from "./dropbox.js";
import { deckStates, pickQueue, categoryScores, overallScore, streaks, dailyCounts } from "./srs.js";

const app = document.getElementById("app");
const titleEl = document.getElementById("deckTitle");
const stateEl = document.getElementById("syncState");
const KEYS = ["ア", "イ", "ウ", "エ", "オ", "カ"];

let catalog = [];
let deck = null;
let logs = [];
let states = new Map();
let dev = "?";
let quiz = [], idx = 0, answers = [], picks = new Set();
let opts = { cats: null, dir: "mix", size: 10 };

const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const shuffle = a => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[x[i], x[j]] = [x[j], x[i]]; } return x; };
const pct = v => Math.round(v * 100);
const same = (a, b) => a.size === b.size && [...a].every(v => b.has(v));

function setSync(text, cls = "") { stateEl.textContent = text; stateEl.className = "syncState " + cls; }

/* ---------- 出題の共通インタフェース ----------
   デッキの項目は2種類ある。
   ・用語項目  {id, c, t, d, n}             … 同分野から誤答を自動生成して四択にする
   ・設問項目  {id, c, type, q, choices[]}  … 選択肢を明示。type は "single" / "multi"
   以下の3つがその差を吸収する。                                              */
const isQuestion = item => !!item.type;
const optLabel = (q, o) => isQuestion(q.item) ? o.t : (q.dir === "t2d" ? o.d : o.t);
const optCorrect = (q, o) => isQuestion(q.item) ? !!o.ok : o.id === q.item.id;

/* ---------- 起動 ---------- */
async function boot() {
  dev = await deviceId();
  try { await dbx.completeAuth(); } catch (e) { console.warn(e); }

  catalog = await fetch("./decks/index.json").then(r => r.json());
  const lastId = await meta.get("lastDeck");
  await loadDeck((catalog.find(d => d.id === lastId) || catalog[0]).id);

  if (await dbx.isLinked()) {
    setSync("同期中", "busy");
    try { await dbx.sync(t => setSync(t, "busy")); await refresh(); setSync(await syncLabel()); }
    catch { setSync("同期できず", "bad"); }
  } else {
    setSync("ローカルのみ");
  }
  home();
}

async function syncLabel() {
  const at = await dbx.lastSyncedAt();
  if (!at) return "未同期";
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "同期済み";
  if (m < 60) return `${m}分前に同期`;
  return `${Math.round(m / 60)}時間前に同期`;
}

async function loadDeck(id) {
  const entry = catalog.find(d => d.id === id) || catalog[0];
  deck = await fetch(`./decks/${entry.file}`).then(r => r.json());
  deck.id = deck.id || entry.id;
  await meta.set("lastDeck", deck.id);
  titleEl.textContent = deck.title;
  opts.cats = null;
  if (deck.dir) opts.dir = deck.dir;      // 語彙デッキは既定の出題方向を指定できる
  await refresh();
}

async function refresh() {
  logs = await log.byDeck(deck.id);
  states = deckStates(deck, logs);
}

/* ---------- ホーム ---------- */
function home() {
  const cs = categoryScores(deck, states);
  const line = deck.pass || 0.75;
  const st = streaks(logs);
  const dueCount = [...states.values()].filter(s => s.seen > 0 && s.due <= Date.now()).length;
  const unseen = [...states.values()].filter(s => s.seen === 0).length;
  const unit = deck.unit || "語";
  const hasTerms = deck.items.some(i => !isQuestion(i));

  const bars = [...cs.entries()].sort((a, b) => a[1].score - b[1].score).map(([c, g]) => {
    const cat = deck.categories[c] || { label: c, color: "var(--c-base)" };
    return `<div class="bd" style="--tab:${cat.color}">
      <div class="row"><span class="${g.score < line ? "weak" : ""}">${esc(cat.label)}</span>
      <span class="r">${pct(g.score)}％<span class="muted"> / ${g.n}${unit}</span></span></div>
      <div class="bar"><i style="width:${pct(g.score)}%"></i><span class="line" style="left:${pct(line)}%"></span></div>
    </div>`;
  }).join("");

  const dirs = [["t2d", (deck.dirLabels || ["用語 → 説明", "説明 → 用語"])[0]],
                ["d2t", (deck.dirLabels || ["用語 → 説明", "説明 → 用語"])[1]],
                ["mix", "ミックス"]];
  const dirField = hasTerms ? `
    <div class="field">
      <p class="q">出題のしかた</p>
      <div class="seg" id="dir">${dirs.map(([k, l]) =>
        `<button data-dir="${k}" aria-pressed="${opts.dir === k}">${esc(l)}</button>`).join("")}</div>
    </div>` : "";

  app.innerHTML = `
  <div class="card">
    <p class="score">${pct(overallScore(deck, states))}<small>％</small></p>
    <p class="rate">到達度（目標 ${pct(line)}％）　未出題 ${unseen}${unit}・要復習 ${dueCount}${unit}</p>
    ${bars}
  </div>

  <div class="card">
    <p class="blockhead">学習の記録<span class="sub">直近12週</span></p>
    <div class="streak">
      <div><div class="num">${st.current}</div><div class="lab">連続日数</div></div>
      <div><div class="num">${st.best}</div><div class="lab">最長</div></div>
      <div><div class="num">${st.total}</div><div class="lab">学習した日</div></div>
    </div>
    ${calendar()}
  </div>

  <div class="card">
    <div class="field">
      <p class="q">出題数</p>
      <div class="seg" id="size">${[[10, "10問"], [20, "20問"], [40, "40問"]].map(([k, l]) =>
        `<button data-size="${k}" aria-pressed="${opts.size === k}">${l}</button>`).join("")}</div>
    </div>
    ${dirField}
    <div class="field">
      <p class="q">範囲（未選択なら全分野）</p>
      <div class="chips" id="cats">${Object.entries(deck.categories).map(([k, v]) => {
        const n = deck.items.filter(x => x.c === k).length;
        const on = opts.cats ? opts.cats.includes(k) : false;
        return `<button class="chip" data-cat="${k}" aria-pressed="${on}" style="--tab:${v.color}">
          <span class="dot"></span>${esc(v.label)}<span class="n">${n}</span></button>`;
      }).join("")}</div>
    </div>
    <button class="start" id="go">はじめる</button>
    <div class="actions"><button class="ghost" id="settings">同期とデータ</button></div>
  </div>`;

  app.querySelector("#size").onclick = e => { const b = e.target.closest("button"); if (b) { opts.size = +b.dataset.size; home(); } };
  const dirEl = app.querySelector("#dir");
  if (dirEl) dirEl.onclick = e => { const b = e.target.closest("button"); if (b) { opts.dir = b.dataset.dir; home(); } };
  app.querySelector("#cats").onclick = e => {
    const b = e.target.closest(".chip"); if (!b) return;
    const cur = opts.cats || [];
    const next = cur.includes(b.dataset.cat) ? cur.filter(x => x !== b.dataset.cat) : cur.concat(b.dataset.cat);
    opts.cats = next.length ? next : null;
    home();
  };
  app.querySelector("#go").onclick = start;
  app.querySelector("#settings").onclick = settings;
}

function calendar() {
  const counts = dailyCounts(logs);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (83 + today.getDay()));
  let html = '<div class="cal">';
  for (let w = 0; w < 13; w++) {
    html += '<div class="week">';
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`;
      const n = counts.get(key) || 0;
      const lvl = cur > today ? "future" : n === 0 ? "" : n < 10 ? "l1" : n < 25 ? "l2" : n < 50 ? "l3" : "l4";
      html += `<span class="day ${lvl}" title="${key} ${n}問"></span>`;
    }
    html += "</div>";
  }
  return html + '</div><p class="callegend">濃いほどその日の解答数が多い</p>';
}

/* ---------- デッキ切り替え ---------- */
document.getElementById("deckSwitch").onclick = async () => {
  const all = await log.all();
  const rows = catalog.map(d => {
    const n = all.filter(r => r.deck === d.id).length;
    return `<button class="deckitem" data-id="${d.id}" aria-current="${d.id === deck.id}">
      <span><span class="t">${esc(d.title)}</span><span class="s">${esc(d.subtitle || "")}</span></span>
      <span class="r">${n ? n + "問" : "未着手"}</span></button>`;
  }).join("");
  app.innerHTML = `<div class="card">
    <p class="blockhead">デッキを選ぶ</p>
    <div class="decklist" id="decks">${rows}</div>
    <div class="actions"><button class="ghost" id="back">戻る</button></div>
  </div>`;
  app.querySelector("#decks").onclick = async e => {
    const b = e.target.closest(".deckitem"); if (!b) return;
    await loadDeck(b.dataset.id); home(); window.scrollTo(0, 0);
  };
  app.querySelector("#back").onclick = home;
};

/* ---------- 出題 ---------- */
function buildQuiz(items) {
  return items.map(item => {
    if (isQuestion(item)) {
      return { item, kind: item.type === "multi" ? "multi" : "single", options: shuffle(item.choices) };
    }
    const dir = opts.dir === "mix" ? (Math.random() < 0.5 ? "t2d" : "d2t") : opts.dir;
    let pool = deck.items.filter(x => !isQuestion(x) && x.c === item.c && x.id !== item.id);
    if (pool.length < 3) pool = pool.concat(deck.items.filter(x => !isQuestion(x) && x.id !== item.id && !pool.includes(x)));
    return { item, kind: "single", dir, options: shuffle([item, ...shuffle(pool).slice(0, 3)]) };
  });
}

function start() {
  const items = pickQueue(deck, states, { cats: opts.cats, size: opts.size });
  if (!items.length) { alert("この範囲に出題できる項目がありません"); return; }
  quiz = buildQuiz(shuffle(items));
  idx = 0; answers = [];
  question();
  window.scrollTo(0, 0);
}

function question() {
  if (idx >= quiz.length) return result();
  const q = quiz[idx];
  const cat = deck.categories[q.item.c] || { label: q.item.c, color: "var(--c-base)" };
  const multi = q.kind === "multi";
  const s = states.get(q.item.id) || { seen: 0 };
  picks = new Set();

  const stem = isQuestion(q.item) ? q.item.q : (q.dir === "t2d" ? q.item.t : q.item.d);
  const big = isQuestion(q.item) ? false : q.dir === "t2d";
  const asks = deck.asks || {};
  const ask = multi ? "正しいものをすべて選べ"
    : isQuestion(q.item) ? "最も適切なものを選べ"
    : q.dir === "t2d" ? (asks.t2d || "この用語の説明として正しいものは？")
    : (asks.d2t || "これにあてはまる用語は？");

  const bars = quiz.map((_, i) => {
    const a = answers[i];
    return `<span class="${i === idx ? "cur" : a ? (a.ok ? "ok" : "ng") : ""}"></span>`;
  }).join("");

  app.innerHTML = `
  <div class="progress">${bars}</div>
  <div class="counter"><span>${idx + 1} / ${quiz.length}</span><span>正解 ${answers.filter(a => a.ok).length}</span></div>
  <div class="card" style="--tab:${cat.color}">
    <span class="tab">${esc(cat.label)}</span>
    <p class="stem ${big ? "" : "small"}">${esc(stem)}</p>
    <p class="ask">${esc(ask)}${multi ? '<span class="pill">複数選択</span>' : ""}${s.seen === 0 ? '　<span class="muted">初出</span>' : ""}</p>
    <div class="choices" id="choices">
      ${q.options.map((o, i) => `<button class="choice" data-i="${i}">
        ${multi ? '<span class="box"></span>' : `<span class="key">${KEYS[i]}</span>`}
        <span>${esc(optLabel(q, o))}</span></button>`).join("")}
    </div>
    ${multi ? '<button class="submit" id="submit" disabled>判定する</button>' : ""}
    <div id="fb" aria-live="polite"></div>
  </div>`;

  app.querySelector("#choices").onclick = e => {
    const b = e.target.closest(".choice");
    if (!b || b.disabled) return;
    const i = +b.dataset.i;
    if (!multi) return answer([i]);
    if (picks.has(i)) { picks.delete(i); b.classList.remove("sel"); }
    else { picks.add(i); b.classList.add("sel"); }
    app.querySelector("#submit").disabled = picks.size === 0;
  };
  if (multi) app.querySelector("#submit").onclick = () => answer([...picks]);
}

async function answer(chosen) {
  const q = quiz[idx];
  const multi = q.kind === "multi";
  const correctIdx = new Set(q.options.map((o, i) => optCorrect(q, o) ? i : -1).filter(i => i >= 0));
  const pickedIdx = new Set(chosen);
  const ok = same(pickedIdx, correctIdx);            // 複数選択は完全一致のみ正解
  answers[idx] = { ok, picked: chosen, q };

  await log.add({ id: uuid(), deck: deck.id, q: q.item.id, ok, ts: Date.now(), dev });

  [...app.querySelectorAll(".choice")].forEach((b, i) => {
    b.disabled = true;
    const isAns = correctIdx.has(i), was = pickedIdx.has(i);
    if (was && isAns) b.classList.add("picked-ok");
    else if (was && !isAns) b.classList.add("picked-ng");
    else if (isAns) b.classList.add(multi ? "missed" : "reveal");
    else b.classList.add("dim");
  });
  const sub = app.querySelector("#submit");
  if (sub) sub.remove();
  app.querySelector(".progress").children[idx].className = ok ? "ok" : "ng";
  app.querySelector(".counter").children[1].textContent = "正解 " + answers.filter(a => a.ok).length;

  const body = isQuestion(q.item)
    ? `<p class="note">正解：${q.options.filter((o, i) => correctIdx.has(i)).map(o => esc(o.t)).join(" ／ ")}</p>`
    : `<p class="note"><span class="term">${esc(q.item.t)}</span> ── ${esc(q.item.d)}</p>`;
  const verdict = ok ? "正解"
    : (multi && [...pickedIdx].some(i => correctIdx.has(i))) ? "惜しい（過不足あり）" : "不正解";

  app.querySelector("#fb").innerHTML = `
  <div class="feedback">
    <p class="verdict ${ok ? "ok" : "ng"}">${verdict}</p>
    ${body}
    ${q.item.n ? `<p class="hint">${esc(q.item.n)}</p>` : ""}
    <button class="next" id="next">${idx + 1 < quiz.length ? "次の問題" : "結果を見る"}</button>
  </div>`;
  const nx = app.querySelector("#next");
  nx.onclick = () => { idx++; question(); };
  nx.focus();
}

/* ---------- 結果 ---------- */
async function result() {
  await refresh();
  const ok = answers.filter(a => a.ok).length;
  const misses = answers.filter(a => !a.ok);

  const byCat = {};
  answers.forEach(a => {
    const c = a.q.item.c;
    byCat[c] = byCat[c] || { ok: 0, n: 0 };
    byCat[c].n++; if (a.ok) byCat[c].ok++;
  });
  const bd = Object.entries(byCat).sort((a, b) => a[1].ok / a[1].n - b[1].ok / b[1].n).map(([c, g]) => {
    const cat = deck.categories[c] || { label: c, color: "var(--c-base)" };
    const p = Math.round(g.ok / g.n * 100);
    return `<div class="bd" style="--tab:${cat.color}">
      <div class="row"><span class="${p < 70 ? "weak" : ""}">${esc(cat.label)}</span><span class="r">${g.ok} / ${g.n}</span></div>
      <div class="bar"><i style="width:${p}%"></i></div></div>`;
  }).join("");

  const missBlock = misses.map(a => {
    const q = a.q;
    const head = isQuestion(q.item) ? q.item.q : q.item.t;
    const detail = isQuestion(q.item)
      ? "正解：" + q.options.filter(o => optCorrect(q, o)).map(o => o.t).join(" ／ ")
      : q.item.d;
    const chose = a.picked.map(i => optLabel(q, q.options[i])).join(" ／ ") || "（無選択）";
    return `<div class="miss">
      <div class="t">${esc(head)}</div>
      <div class="d">${esc(detail)}</div>
      <div class="y">選んだ答え：${esc(chose)}</div>
    </div>`;
  }).join("");

  app.innerHTML = `
  <div class="card">
    <p class="score">${ok}<small> / ${answers.length}</small></p>
    <p class="rate">正答率 ${Math.round(ok / answers.length * 100)}％　到達度 ${pct(overallScore(deck, states))}％</p>
    ${bd}
    <div class="review">
      <h2>${misses.length ? `取りこぼし（${misses.length}）` : "全問正解。この範囲は仕上がっています。"}</h2>
      ${missBlock}
    </div>
    <div class="actions">
      ${misses.length ? `<button class="primary" id="again">間違えた ${misses.length} 問をもう一度</button>` : ""}
      <button class="ghost" id="more">続けて解く</button>
      <button class="ghost" id="home">ホームへ</button>
    </div>
  </div>`;

  const again = app.querySelector("#again");
  if (again) again.onclick = () => { quiz = buildQuiz(shuffle(misses.map(a => a.q.item))); idx = 0; answers = []; question(); window.scrollTo(0, 0); };
  app.querySelector("#more").onclick = start;
  app.querySelector("#home").onclick = () => { home(); window.scrollTo(0, 0); };

  if (await dbx.isLinked()) {
    setSync("同期中", "busy");
    try { await dbx.sync(t => setSync(t, "busy")); setSync(await syncLabel()); }
    catch { setSync("同期できず", "bad"); }
  }
}

/* ---------- 設定 ---------- */
async function settings() {
  const key = await dbx.appKey();
  const linked = await dbx.isLinked();
  const all = await log.all();

  app.innerHTML = `
  <div class="card">
    <p class="blockhead">Dropbox 同期<span class="sub">${linked ? "連携済み" : "未連携"}</span></p>
    <div class="field">
      <p class="q">App key（Dropbox App Console で取得）</p>
      <input type="text" id="key" value="${esc(key)}" placeholder="例: ab12cd34ef56gh7" autocomplete="off" spellcheck="false">
    </div>
    <div class="actions">
      ${linked
        ? `<button class="primary" id="syncNow">いま同期する</button><button class="ghost" id="unlink">連携を解除</button>`
        : `<button class="primary" id="link">Dropbox と連携する</button>`}
    </div>
    <p class="muted" style="margin-top:14px">リダイレクト URI にこの URL を登録してください：<br>${esc(location.origin + location.pathname)}</p>
    <p class="err" id="err"></p>
  </div>

  <div class="card">
    <p class="blockhead">データ</p>
    <div class="kv"><span>この端末のID</span><span class="v">${dev}</span></div>
    <div class="kv"><span>回答ログ（全デッキ）</span><span class="v">${all.length} 件</span></div>
    <div class="kv"><span>最終同期</span><span class="v">${await syncLabel()}</span></div>
    <div class="actions">
      <button class="ghost" id="export">ログを書き出す（JSONL）</button>
      <button class="ghost" id="back">戻る</button>
    </div>
  </div>`;

  const err = app.querySelector("#err");
  const saveKey = () => dbx.setAppKey(app.querySelector("#key").value);
  app.querySelector("#key").onchange = saveKey;

  const link = app.querySelector("#link");
  if (link) link.onclick = async () => { await saveKey(); try { await dbx.beginAuth(); } catch (e) { err.textContent = e.message; } };
  const unlinkBtn = app.querySelector("#unlink");
  if (unlinkBtn) unlinkBtn.onclick = async () => { await dbx.unlink(); setSync("ローカルのみ"); settings(); };
  const syncNow = app.querySelector("#syncNow");
  if (syncNow) syncNow.onclick = async () => {
    setSync("同期中", "busy");
    try {
      const r = await dbx.sync(t => setSync(t, "busy"));
      await refresh(); setSync(await syncLabel());
      err.textContent = `取り込み ${r.pulled} 件 / 送信 ${r.pushed} 件 / 合計 ${r.total} 件`;
      err.style.color = "var(--ink-soft)";
    } catch (e) { setSync("同期できず", "bad"); err.textContent = e.message; err.style.color = ""; }
  };
  app.querySelector("#export").onclick = async () => {
    const rows = (await log.all()).sort((a, b) => a.ts - b.ts).map(r => JSON.stringify(r)).join("\n");
    const url = URL.createObjectURL(new Blob([rows], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url; a.download = "memoring-log.jsonl"; a.click();
    URL.revokeObjectURL(url);
  };
  app.querySelector("#back").onclick = home;
}

boot().catch(e => { app.innerHTML = `<div class="card"><p class="err">起動に失敗しました：${esc(e.message)}</p></div>`; });
