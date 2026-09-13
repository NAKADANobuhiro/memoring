// ログは事実の記録。記憶度も連続日数も到達度も、保存せずここで毎回算出する。
// 状態を持たないので、複数端末のログを混ぜても結果がぶれない。

const DAY = 86400000;
const BASE_INTERVAL = 1;          // 初回正解後に空ける日数
const MAX_INTERVAL = 120;

/** 1 項目の履歴（時刻昇順）から現在の状態を出す */
export function itemState(history, now = Date.now()) {
  if (!history.length) {
    return { seen: 0, streak: 0, recall: 0, due: 0, interval: 0, lastTs: 0, everWrong: false };
  }
  const rows = history.slice().sort((a, b) => a.ts - b.ts);
  let streak = 0, everWrong = false;
  for (const r of rows) {
    if (r.ok) streak++; else { streak = 0; everWrong = true; }
  }
  const lastTs = rows[rows.length - 1].ts;
  const interval = streak === 0
    ? 0.25                                             // 直近で間違えた項目はその日のうちに戻す
    : Math.min(BASE_INTERVAL * Math.pow(2, streak - 1), MAX_INTERVAL);
  const halfLife = Math.max(interval, 0.25);
  const elapsed = (now - lastTs) / DAY;
  const recall = Math.pow(0.5, elapsed / halfLife);    // 経過とともに減衰
  return {
    seen: rows.length, streak, everWrong, lastTs, interval,
    recall: Math.max(0, Math.min(1, recall)),
    due: lastTs + interval * DAY,
  };
}

/** デッキ全体の状態表を作る */
export function deckStates(deck, logs, now = Date.now()) {
  const byItem = new Map();
  logs.forEach(r => {
    if (!byItem.has(r.q)) byItem.set(r.q, []);
    byItem.get(r.q).push(r);
  });
  const map = new Map();
  deck.items.forEach(it => map.set(it.id, itemState(byItem.get(it.id) || [], now)));
  return map;
}

/**
 * 出題順。
 * 1. 期限切れ（超過が大きいもの優先）
 * 2. 未出題
 * 3. まだ期限前だが記憶度が低いもの
 */
export function pickQueue(deck, states, { cats, size, now = Date.now() }) {
  const pool = deck.items.filter(it => !cats || cats.includes(it.c));
  const scored = pool.map(it => {
    const s = states.get(it.id) || { seen: 0, due: 0, recall: 0 };
    let rank, key;
    if (s.seen === 0) { rank = 1; key = 0; }
    else if (s.due <= now) { rank = 0; key = -(now - s.due); }
    else { rank = 2; key = s.recall; }
    return { it, rank, key, s };
  });
  scored.sort((a, b) => a.rank - b.rank || a.key - b.key);
  return scored.slice(0, Math.min(size, scored.length)).map(x => x.it);
}

/** 分野別の到達度。記憶度で重みづけした「今この分野で取れる割合」 */
export function categoryScores(deck, states) {
  const out = new Map();
  deck.items.forEach(it => {
    if (!out.has(it.c)) out.set(it.c, { n: 0, sum: 0, due: 0, unseen: 0 });
    const g = out.get(it.c);
    const s = states.get(it.id) || { seen: 0, recall: 0, due: 0 };
    g.n++;
    g.sum += s.recall;
    if (s.seen === 0) g.unseen++;
    else if (s.due <= Date.now()) g.due++;
  });
  for (const g of out.values()) g.score = g.n ? g.sum / g.n : 0;
  return out;
}

/** デッキ全体の到達度（分野の出題比重があればそれで加重） */
export function overallScore(deck, states) {
  const cs = categoryScores(deck, states);
  let w = 0, acc = 0;
  for (const [c, g] of cs) {
    const weight = (deck.categories[c] && deck.categories[c].weight) || g.n;
    w += weight;
    acc += weight * g.score;
  }
  return w ? acc / w : 0;
}

/* ---------- 学習日 ---------- */
const dayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function dailyCounts(logs) {
  const m = new Map();
  logs.forEach(r => { const k = dayKey(r.ts); m.set(k, (m.get(k) || 0) + 1); });
  return m;
}

/** 連続日数。今日まだ解いていなくても、昨日解いていれば継続中として数える */
export function streaks(logs, now = Date.now()) {
  const days = dailyCounts(logs);
  if (!days.size) return { current: 0, best: 0, total: 0 };
  const has = k => days.has(k);
  const shift = (ts, n) => ts - n * DAY;

  let current = 0;
  const startOffset = has(dayKey(now)) ? 0 : (has(dayKey(shift(now, 1))) ? 1 : null);
  if (startOffset !== null) {
    let i = startOffset;
    while (has(dayKey(shift(now, i)))) { current++; i++; }
  }
  const sorted = [...days.keys()].sort();
  let best = 0, run = 0, prev = null;
  sorted.forEach(k => {
    const t = new Date(k + "T00:00:00").getTime();
    run = (prev !== null && t - prev === DAY) ? run + 1 : 1;
    best = Math.max(best, run);
    prev = t;
  });
  return { current, best, total: days.size };
}
