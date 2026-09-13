// Dropbox 同期。
// ・認証は OAuth 2.0 + PKCE（client secret を持たない）
// ・ログは追記のみなので、マージは id の和集合。衝突したら取り直して再実行するだけでよい。
import { meta, log } from "./store.js";

const REMOTE_PATH = "/log.jsonl";   // App folder 配下。ASCII に限定しておく（ヘッダに載るため）
const AUTH = "https://www.dropbox.com/oauth2/authorize";
const TOKEN = "https://api.dropboxapi.com/oauth2/token";
const RPC = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

const redirectUri = () => location.origin + location.pathname;

/* ---------- PKCE ---------- */
function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function challenge(verifier) {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
}
function randomVerifier() {
  return b64url(crypto.getRandomValues(new Uint8Array(64)));
}

export async function appKey() { return (await meta.get("dbxAppKey")) || ""; }
export async function setAppKey(k) { return meta.set("dbxAppKey", k.trim()); }

export async function isLinked() { return !!(await meta.get("dbxRefresh")); }

export async function beginAuth() {
  const key = await appKey();
  if (!key) throw new Error("Dropbox の App key が未設定です");
  const v = randomVerifier();
  sessionStorage.setItem("dbxVerifier", v);
  const q = new URLSearchParams({
    client_id: key,
    response_type: "code",
    code_challenge: await challenge(v),
    code_challenge_method: "S256",
    token_access_type: "offline",       // refresh token を受け取る
    redirect_uri: redirectUri(),
  });
  location.href = `${AUTH}?${q}`;
}

// 認証後のリダイレクトを処理する。取り込んだら URL からコードを消す。
export async function completeAuth() {
  const p = new URLSearchParams(location.search);
  const code = p.get("code");
  if (!code) return false;
  const v = sessionStorage.getItem("dbxVerifier");
  history.replaceState(null, "", redirectUri());
  if (!v) return false;
  const key = await appKey();
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, grant_type: "authorization_code", client_id: key,
      code_verifier: v, redirect_uri: redirectUri(),
    }),
  });
  if (!r.ok) throw new Error("トークンの取得に失敗しました（" + r.status + "）");
  const j = await r.json();
  await meta.set("dbxRefresh", j.refresh_token);
  await meta.set("dbxAccess", { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  sessionStorage.removeItem("dbxVerifier");
  return true;
}

export async function unlink() {
  await meta.del("dbxRefresh");
  await meta.del("dbxAccess");
  await meta.del("dbxRev");
}

async function accessToken() {
  const cur = await meta.get("dbxAccess");
  if (cur && cur.exp > Date.now()) return cur.token;
  const refresh = await meta.get("dbxRefresh");
  if (!refresh) throw new Error("Dropbox が未連携です");
  const key = await appKey();
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: key }),
  });
  if (!r.ok) { await unlink(); throw new Error("再連携が必要です"); }
  const j = await r.json();
  const next = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  await meta.set("dbxAccess", next);
  return next.token;
}

/* ---------- ファイル操作 ---------- */
async function download() {
  const t = await accessToken();
  const r = await fetch(`${CONTENT}/files/download`, {
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Dropbox-API-Arg": JSON.stringify({ path: REMOTE_PATH }) },
  });
  if (r.status === 409) return { text: "", rev: null };   // まだファイルが無い
  if (!r.ok) throw new Error("ダウンロードに失敗（" + r.status + "）");
  const info = JSON.parse(r.headers.get("dropbox-api-result") || "{}");
  return { text: await r.text(), rev: info.rev || null };
}

async function upload(text, rev) {
  const t = await accessToken();
  const mode = rev ? { ".tag": "update", update: rev } : { ".tag": "add" };
  const r = await fetch(`${CONTENT}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({ path: REMOTE_PATH, mode, autorename: false, mute: true }),
    },
    body: new Blob([text]),
  });
  if (r.status === 409) return { conflict: true };
  if (!r.ok) throw new Error("アップロードに失敗（" + r.status + "）");
  const j = await r.json();
  return { rev: j.rev };
}

/* ---------- 同期本体 ---------- */
const parse = text => text.split("\n").map(l => l.trim()).filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const serialize = rows => rows
  .slice().sort((a, b) => a.ts - b.ts)
  .map(r => JSON.stringify(r)).join("\n") + "\n";

/**
 * 取得 → 和集合でマージ → 書き戻し。衝突したら最初からやり直す。
 * マージが冪等なので、何度リトライしても結果は変わらない。
 */
export async function sync(onState = () => {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    onState(attempt === 0 ? "同期中" : `再試行 ${attempt}`);
    const remote = await download();
    const remoteRows = parse(remote.text);
    const pulled = await log.merge(remoteRows);

    const localRows = await log.all();
    const remoteIds = new Set(remoteRows.map(r => r.id));
    const pushed = localRows.filter(r => !remoteIds.has(r.id)).length;

    if (pushed === 0) {
      await meta.set("dbxRev", remote.rev);
      await meta.set("dbxSyncedAt", Date.now());
      return { pulled, pushed: 0, total: localRows.length };
    }
    const res = await upload(serialize(localRows), remote.rev);
    if (res.conflict) continue;                 // 他端末が先に書いた。取り直す
    await meta.set("dbxRev", res.rev);
    await meta.set("dbxSyncedAt", Date.now());
    return { pulled, pushed, total: localRows.length };
  }
  throw new Error("同期が競合し続けました。時間をおいて再実行してください");
}

export async function lastSyncedAt() { return meta.get("dbxSyncedAt"); }
