# memoring

覚えたいものを四択で回す個人用アプリ。資格の用語も語学の単語も同じ器に入る。回答ログを Dropbox 経由で端末間に同期する。

- スマホでもPCでも、同じ進捗の続きから解ける
- 記憶度の低い項目と復習期限が来た項目から優先的に出る
- 四択のほか、「正しいものをすべて選べ」の複数選択に対応
- 分野別の到達度と、目標ラインとの距離が見える
- 資格・語学など、デッキを切り替えて使える

## セットアップ

### 1. GitHub Pages に置く

リポジトリを作り、この一式を push する。

```bash
git init && git add -A && git commit -m "init"
git branch -M main
git remote add origin git@github.com:<user>/<repo>.git
git push -u origin main
```

リポジトリの Settings → Pages → Source を `main` / `/ (root)` にする。
数分後 `https://<user>.github.io/<repo>/` で開ける。

**プライベートリポジトリでは Pages が使えないプランがある。**問題データを公開したくない場合は
Cloudflare Pages などに切り替えるか、公開してよい内容に留める。ログは Dropbox 側にあり、
リポジトリには含まれない。

### 2. Dropbox アプリを作る

1. https://www.dropbox.com/developers/apps → Create app
2. **Scoped access** → **App folder** を選ぶ（全ドライブへのアクセス権は渡さない）
3. Permissions タブで `files.content.read` と `files.content.write` にチェックし、Submit
4. Settings タブの **Redirect URIs** に、上で決まった URL をそのまま登録する
   例: `https://<user>.github.io/<repo>/`
5. 同じ画面の **App key** を控える

### 3. アプリ側で連携する

アプリを開き、ホーム下部の「同期とデータ」→ App key を貼り付け →「Dropbox と連携する」。
Dropbox の認可画面から戻ってくれば完了。ログは `/アプリ/<アプリ名>/log.jsonl` に置かれる。

2台目以降も同じ手順。App key は同じものを使う。

## 使い方

| 操作 | 場所 |
|---|---|
| デッキを切り替える | 画面上部のリンク |
| 出題数・出題方向・分野を変える | ホーム下部 |
| 同期の状態を見る | 画面右上 |
| ログを書き出す | 同期とデータ → ログを書き出す |

出題は**記憶度の低い順**。期限切れの復習 → 未出題 → 記憶が薄れてきたもの、の順に選ばれる。
分野を選ばなければ全分野から出る。

複数選択の問題は選択肢をタップして選び、「判定する」で確定する。**完全一致のみ正解**で部分点はない。

セッション終了時に自動で同期される。手動同期は「同期とデータ」から。

## 問題データを足す

`decks/` に JSON を置き、`decks/index.json` に登録する。書き方は `CLAUDE.md` を参照。
Claude Code に教材を渡して生成させる運用を想定している。

同梱のデッキ:

| デッキ | 中身 |
|---|---|
| `genai-passport` | 生成AIパスポートの用語 64語 |
| `au` | システム監査技術者の用語 28語＋複数選択 5問 |
| `vocab-en` | 英単語 32語（Duolingo で出会った語を追記していく器） |

## アーキテクチャ

```
  端末A ─┐
         ├─ IndexedDB（回答ログ）─ 和集合マージ ─ Dropbox /log.jsonl
  端末B ─┘

  記憶度・到達度・連続日数 ← ログから毎回算出（保存しない）
```

保存するのは「いつ・どの問題に・正解したか」という事実だけ。
回答は起きた事実であって後から変わらないので、マージは id の和集合で足り、衝突が原理的に起きない。
派生値を持たないため、複数端末のログを混ぜても結果がぶれない。

## 制約

- ES Modules を使うため `file://` では動かない（`python3 -m http.server` を使う）
- Dropbox 連携には https が必要。localhost では未連携のまま動作確認する
- ログを削除する機能は用意していない。消すと他端末から復活する
