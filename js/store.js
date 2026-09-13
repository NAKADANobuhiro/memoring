// IndexedDB。回答ログは追記のみ、設定は key-value。
const DB = "shikaku-drill";
const VER = 1;
let _db = null;

function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("log")) {
        const s = db.createObjectStore("log", { keyPath: "id" });
        s.createIndex("deck", "deck");
        s.createIndex("ts", "ts");
      }
      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta");
      }
    };
    r.onsuccess = () => { _db = r.result; res(_db); };
    r.onerror = () => rej(r.error);
  });
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}

export const meta = {
  get: k => tx("meta", "readonly", s => s.get(k)),
  set: (k, v) => tx("meta", "readwrite", s => s.put(v, k)),
  del: k => tx("meta", "readwrite", s => s.delete(k)),
};

export const log = {
  // 1 件 = 1 回答。id は uuid で、これが同期時のマージキーになる。
  add(entry) {
    return tx("log", "readwrite", s => s.put(entry));
  },
  // 既知 id を避けて一括投入（Dropbox から取り込むときに使う）
  async merge(entries) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction("log", "readwrite");
      const s = t.objectStore("log");
      let added = 0;
      entries.forEach(e => {
        const q = s.get(e.id);
        q.onsuccess = () => { if (!q.result) { s.put(e); added++; } };
      });
      t.oncomplete = () => res(added);
      t.onerror = () => rej(t.error);
    });
  },
  all() {
    return tx("log", "readonly", s => s.getAll());
  },
  async byDeck(deckId) {
    const rows = await tx("log", "readonly", s => s.getAll());
    return rows.filter(r => r.deck === deckId);
  },
  clear() {
    return tx("log", "readwrite", s => s.clear());
  },
};

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export async function deviceId() {
  let d = await meta.get("deviceId");
  if (!d) { d = uuid().slice(0, 8); await meta.set("deviceId", d); }
  return d;
}
