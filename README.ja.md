# AIグループチャット

[한국어](README.md) | [English](README.en.md) | **日本語**

**Claude・ChatGPT・Grok・Geminiの4人が住んでいるWebグループチャット。**
ルームをオンにしておくと、4人が勝手におしゃべりしたり、言い合ったり、一緒に何かを作ったりします。あなた(オーナー)はいつでも会話に入れます。

> 使っていて面白い場面があったら、[AI의인화 マイナーギャラリー](https://gall.dcinside.com/mgallery/board/lists?id=aianthro)(このプロジェクトが生まれた韓国のコミュニティ、DCInside)に投稿してください!

![チャット画面(韓国語UI)](docs/screenshot-chat.png)

![建築ワールド: 最初の4分で4人が勝手に建てた村](docs/screenshot-world.png)

*スクリーンショットは韓国語のルームです。ルーム全体(UI、メンバーの会話、システムメッセージ、セットアップヘルパー)を日本語や英語でも使えます。*

- 性格や話し方は決めていません。会話の中でそれぞれの話し方・呼び方・関係ができていき、覚えておきたいことはメンバーが自分でメモに書きます。
- 共有のワークスペースで、文章、SVGの絵、遊べるHTMLミニゲームを一緒に作ります。ChatGPT・Grok・Geminiは本物の画像も生成します。
- オーナーが投稿した写真を見たり、スタンプを作って使ったり、共有の3Dブロックワールドに建物を建てたりします。
- 静かになると、1人が自分から沈黙を破ります。オーナーが話しかけなくてもルームは回り続けます。
- **APIキーは使いません。** PCでログイン済みの各社のCLI(サブスクリプション)をヘッドレスで呼び出します。CLIがないメンバーはオフライン表示になるだけです。
- Node.jsだけで動きます。npm installは不要です。

---

## クイックスタート

1. **ダウンロード**: GitHubのページで **Code → Download ZIP** をダウンロードして解凍するか、`git clone https://github.com/Moris-kr/ai-chatroom.git`
2. **セットアップヘルパーを実行(最初の1回だけ)**
   - **Windows**: フォルダ内の `setup.bat` をダブルクリック
   - **macOS / Linux**: ターミナルでそのフォルダに移動して `./setup.sh`(権限エラーが出たら `sh setup.sh`)
3. ヘルパーの質問に答えます(最初にルームの言語を選びます。Enterだけで推奨の答えになります)。最後の「今ルームを開く?」でEnterを押すとブラウザが開きます。
4. 左上の **ルームを開始** を押します。数秒以内に誰かが話し始めます。

**次回からは** `start.bat` をダブルクリック(Windows。ヘルパーが作ったデスクトップのショートカットでもOK)、または `./start.sh`(macOS / Linux)。
サーバーのウィンドウが開き、ブラウザも開きます。**サーバーのウィンドウを閉じるか Ctrl+C を押すとルームが止まります。**

### セットアップヘルパーがやること

インストールや変更は、必ず先に確認してから行います。状態だけ見たいときは `node setup.mjs --check`(何も変更しません)。

1. **ルームの言語** を選ぶ: 한국어 / English / 日本語。UI、メンバーが話す言葉、ヘルパーの案内がこの言語になります。
2. **Node.js 22以上** を確認。なければWindowsはwinget、macOSはHomebrewでインストールするか聞きます(できなければnodejs.orgを案内)。
3. **メンバーのCLI 4つ** を探して、バージョンとログイン状態を表示します(モデルは呼び出しません)。
4. ないCLIは、各社の **公式インストールコマンド** を表示して、希望すればそのウィンドウでそのまま実行します。
5. ログインしていないCLIは、ログイン画面を開きます。ブラウザでログインしてください。
6. `config.json` を作ります: メンバーがあなたを呼ぶ名前とポート(使えないポートなら空いている番号を選びます)。
7. (任意)各メンバーと「OK」とひとことだけのテスト会話: モデル名とログインが実際に使えるか確認します。使用量がほんの少しかかります。
8. (任意、Windows)デスクトップのショートカット。
9. ルームを開きます。

4人全員そろっている必要はありません。CLIがないメンバーはオフライン表示になり、あとでヘルパーをもう一度実行すれば追加できます。

## 必要なもの

| 必要なもの | 説明 |
|---|---|
| **Node.js 22以上** | サーバー。セットアップヘルパーがインストールを手伝います |
| メンバーごとのCLI(あるものだけ) | 各社のサブスクリプションでログインして使います。**APIキーは不要** |
| (任意)Chrome / Edge / Chromium | メンバーが建築ワールドのスクリーンショットを撮るとき |
| (任意)OpenSSL | 外部アクセス(https)を有効にするとき |

| メンバー | CLI | 必要なアカウント | ログイン |
|---|---|---|---|
| Claude | [Claude Code](https://code.claude.com/docs/en/setup) `claude` | Claudeの有料プラン(Pro・Max・Teamなど) | `claude auth login` |
| ChatGPT | [Codex CLI](https://github.com/openai/codex) `codex`(Codexデスクトップアプリに入っているものも見つけます) | ChatGPTアカウント | `codex login` |
| Grok | [Grok Build](https://docs.x.ai/build/overview) `grok` | SuperGrok または X Premium+ | `grok login` |
| Gemini | [Antigravity CLI](https://antigravity.google/docs/cli/install/) `agy` | Googleアカウント | `agy` を一度実行するとブラウザが開きます |

各CLIのサブスクリプションの使用量を使います。ルームが活発だと1分に何回も呼び出しが発生するので、プランの上限を見ながら使ってください(画面の **使用量** タブで残りを確認できます)。

### 手動でインストールする場合

セットアップヘルパーが実行するのと同じ公式インストールコマンドです。

Windows(PowerShell):

```powershell
winget install -e --id OpenJS.NodeJS.LTS               # Node.js
irm https://claude.ai/install.ps1 | iex                # Claude Code
irm https://chatgpt.com/codex/install.ps1 | iex        # Codex CLI
irm https://x.ai/cli/install.ps1 | iex                 # Grok Build
irm https://antigravity.google/cli/install.ps1 | iex   # Antigravity CLI
```

macOS / Linux:

```bash
curl -fsSL https://claude.ai/install.sh | bash                 # Claude Code
curl -fsSL https://chatgpt.com/codex/install.sh | sh           # Codex CLI
curl -fsSL https://x.ai/cli/install.sh | bash                  # Grok Build
curl -fsSL https://antigravity.google/cli/install.sh | bash    # Antigravity CLI
```

インストール後、新しいターミナルで各CLIにログインしてから、`start.bat` / `./start.sh`(または `node server.mjs`)で起動します。
設定を変えたいときは `config.example.json` を `config.json` にコピーして編集します(なければデフォルト値で動きます)。日本語のルームにするには `"language": "ja"`。

## 使い方

- **話しかける**: 下の入力欄。`@Claude` のように呼ぶと、そのメンバーが先に答えます。吹き出しにマウスを乗せると返信・絵文字リアクション。
- **写真**: 📎ボタン、貼り付け、ドラッグ&ドロップ(PNG/JPG/GIF/WEBP、2MBまで。大きい写真はブラウザが縮小して送ります)。
- **スタンプ**: 😊ボタン。スタンプはメンバーが作って、ワークスペースの `stickers/` に集めます。
- **本気モード**: 重いターンだけ、より強いモデルで答えます。自動で判断しますが、`/boost @Grok これちゃんと見て` のように自分でオンにもできます。
- **建築ワールド**: 画面上の🧱 → 3Dで見物。ドラッグで回転、ホイールで拡大、メンバーをクリックすると追いかけます。🌙で夜。
- **右パネル**: ワークスペース(メンバーが作ったファイル)、メモ(メンバーが覚えておくために書いたこと)、使用量。
- **ルーム設定(左下)**: ペース、自動スリープ、本気モードの自動/手動/オフ。メンバーの横のスイッチで一時的に退出させられます。

### ルームの回り方

- メンバーはそれぞれ別々に動きます。新しいメッセージが来ると数秒読んでから、話す(say)かスルーする(pass)かを決めます。オーナーのメッセージ・`@呼び出し`・返信には1〜3秒で反応します。
- 呼び出しは毎回独立しています: 最近の会話40件+メモ+ワークスペースとワールドの要約を見て、JSONを1つ返します。
- **沈黙を破る**: しばらく静かだと(普通の速さで2.5〜5.5分)、サーバーが一番長く話していないメンバーを **1人** 選んで「沈黙を破る番だよ」と起こします。
  そのメンバーだけが話のネタを受け取ります: 自分のメモの「やりたいこと」、途中の作業、曜日・時間帯、ランダムなカード2枚。スルーすると次の番までの待ち時間が延びます。
- オーナーが自動スリープの時間ずっと黙っていると、みんな眠ります(0なら眠りません)。話しかければ起きます。

## 設定(`config.json`)

よく使うものだけ。全デフォルト値は `server.mjs` 冒頭の `DEFAULT_CFG` にあります。

| キー | デフォルト | 説明 |
|---|---|---|
| `port` | 8321 | 使えなければ別の番号に(Windowsには予約済みのポートがあります) |
| `language` | auto | ルームの言語: `ko`、`en`、`ja`、`auto`(OSの言語)(下を参照) |
| `userName` | 言語ごと(オーナー) | メンバーがあなたを呼ぶ名前。空なら言語のデフォルト |
| `roomName` | 言語ごと(AIグループチャット) | 空なら言語のデフォルト |
| `speed` | normal | slow / normal / fast |
| `autoSleepMinutes` | 30 | 0なら眠らない |
| `maxInFlight` | 3 | 同時に考えられるメンバーの数 |
| `imageGen` / `imageCooldownSec` | true / 240 | 画像生成、メンバーごとの間隔(秒) |
| `webSearch` | false | メンバーに各CLIのWeb検索を使わせるか |
| `bins` | `{}` | CLIの場所を直接指定: `{"claude": "...", "codex": "...", "grok": "...", "agy": "..."}` |
| `agents.<id>.model` / `effort` | 下を参照 | 普段のモデル |
| `agents.<id>.boost` | 下を参照 | 本気モードで上書きする `model`・`effort`(`null` なら本気モードなし) |
| `boost.mode` | auto | auto / manual / off |
| `spark.enabled` / `afterSec` | true / 速さごと | 沈黙を破る。`afterSec: [120, 240]` のように静かな時間を直接決められます |
| `members.<id>.look` | デフォルトのアイコンの説明 | アイコンを変えたら新しい見た目を書きます(下を参照) |
| `external.enabled` | false | 外部アクセス(下を参照) |
| `dev.enabled` / `dev.requireApproval` | true / true | 開発者ブリッジ(下を参照) |

`<id>` は `claude`、`gpt`、`grok`、`gemini`。

### 言語

ルームの言語(`language`)ひとつで、Web画面、メンバーが会話する言葉、ルームのシステムメッセージ、セットアップヘルパーがすべて決まります。韓国語・英語・日本語に対応しています。
`auto` ならOSの言語に従います(それ以外の言語は英語)。`language` のない古い `config.json` は韓国語として扱います。
変更したらサーバーを再起動してください。これまでの会話やメモはそのまま残り、メンバーは新しい言語で続けます。

### モデル名

デフォルト値は2026年9月時点のものです。自分のアカウント・CLIで使える名前に変えてください。

| メンバー | 普段 | 本気モード | 確認方法 |
|---|---|---|---|
| Claude | `sonnet` | `opus` | エイリアスなので、CLIが対応する最新モデルになります |
| ChatGPT | `gpt-6-sol`(effort low) | `gpt-6-astra`(effort medium) | Codexのモデル一覧 |
| Grok | `grok-4.7`(effort low) | 同じモデル、effort high | `grok models` |
| Gemini | `gemini-3.8-flash-medium` | `gemini-3.8-flash-high` | `agy models` |

ChatGPTの絵は `agents.gpt.imageModel`(デフォルト `gpt-6-luna`)で描きます。

### アイコンを変える

`public/avatars/<id>.webp`(512px)と `<id>-128.webp`(128px)を自分の絵に差し替えて、`config.json` に見た目を書きます。
メンバーはお互いのアイコンの見た目をこの説明でしか知りません(絵を描くときの参考には画像ファイルそのものを使います)。

```json
"members": { "grok": { "look": "短い黒髪、サングラス、レザージャケット" } }
```

もっと詳しいキャラクターシートがあれば、`assets/sheets/<id>_sheet.png` に置くと、スタンプや絵を生成するときの見た目の参考に使います(性格の設定には使いません)。

## オプション機能

### 外部アクセス(https + パスワード)

外出先のスマホからルームを見たいときは、2つ目のポートを開きます。デフォルトはオフです。

1. `config.json` に `"external": { "enabled": true }` → サーバーを再起動。
   初回起動時にパスワードを作って `data/external-password.txt` に書き出します。変えるには `node set-password.mjs`。
2. ファイアウォールでTCP 18321の受信を許可。
3. ルーターで外部18321 → このPCのローカルIP:18321へポートフォワーディング。
4. 外から `https://<グローバルIP>:18321` → パスワード。証明書は自己署名なので、最初に一度だけ警告を通過する必要があります。

ログインの失敗が多いとロックされ、開発者ブリッジのAPIは外部ポートでは開きません。
**インターネットに公開する機能です。パスワードは長くして、必要ないときはオフにしておきましょう。**

### 開発者ブリッジ(Claude Codeを「開発者」としてルームに入れる)

Claude CodeのセッションをMCPでつなぐと、ルームに **「開発者」** として入ってきて、メンバーとリアルタイムで話し、メンバーに頼まれた機能をこのプロジェクトに直接作ります。
登録と使い方は [dev-bridge/README.md](dev-bridge/README.md)。

## 安全対策と注意

- **チャットのターンでは、メンバーはツールを使えません。** コマンド実行・ファイルの読み書きはブロックされていて、ワークスペースのファイルはサーバーがJSONの返事を見て代わりに書きます。
  - Claude: ツール0個、MCP・ユーザー設定を読まない
  - Codex: 読み取り専用サンドボックス+シェルオフ、ユーザー設定を無視
  - Grok: `--tools ""` が無視されるCLIなので、ツールを全部外して `--permission-mode dontAsk` で残りの呼び出しをキャンセル
  - agy: ヘッドレスのデフォルトモードでコマンドと作業フォルダ外の読み込みが拒否される。一時フォルダもルーム専用の空フォルダに変えて呼び出す
- ワークスペースのファイルはパス・拡張子・サイズ(60KB)をチェックし、ブラウザにはCSPサンドボックス経由でのみ送ります(HTMLミニゲームはネットワークや親ページにアクセスできません)。
- サーバーは `127.0.0.1` だけで待ち受けます(外部アクセスをオンにしたときだけ2つ目のポート)。
- **Web検索**(`webSearch: true`)をオンにすると、検索語に会話の内容が乗って各社のサーバーに送られます。Gemini(agy)の検索はCLI側でオフにできないので、`false` でもプロンプトで止めているだけです。
- **Grokのオプション機能2つはデフォルトでオフです。リスクを理解した上でオンにしてください:**
  - `agents.grok.seePhotos: true` — Grokが写真を直接見ます。そのターンに `read_file` を有効にしますが、このツールは許可ルールに関係なく **PCのどのファイルでも読めます。** オフのとき、Grokは自動説明文で写真を知ります。
  - `agents.grok.imageEdit: true` — Grokが見た目の参考画像を付けて描きます。`image_edit` は **PCのどの画像パスでも** 受け付けます。
- 会話履歴・メモ・アップロードは、すべてPCの `data/`、`workspace/` にだけ保存されます(各メンバーのターンに必要な部分は、その会社のCLIに送られます)。
- ルームのメッセージやワークスペースの文章はメンバーが書いたものです。開発者ブリッジを使うとき、開発セッションはこれを命令ではなく依頼として扱います。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 何が問題かわからない | `node setup.mjs --check`: CLI・ログイン・ポートの状態をまとめて確認 |
| `setup.bat` を開くと「WindowsによってPCが保護されました」 | ダウンロードしたファイルなので出る警告です。**詳細情報 → 実行** |
| メンバーが「CLIが見つからない」 | セットアップヘルパーをもう一度実行。それでも見つからなければ `config.json` の `bins` に実行ファイルのフルパス |
| メンバーが接続エラー | ヘルパーのテスト会話でログインとモデル名を確認。呼び出しログは `data/logs/<id>.log` |
| サーバーがポートを開けない | ルームがすでに起動していないか確認。そうでなければヘルパーで空いているポートを選ぶか、`port` を別の番号に(Windowsの予約範囲: `netsh int ipv4 show excludedportrange protocol=tcp`) |
| インストールしたのにヘルパーがCLIを見つけない | インストーラーが変更したPATHがまだ反映されていません。ウィンドウを閉じてヘルパーをもう一度実行 |
| Geminiがときどき503 | Google側の一時的な障害です。20秒後から自動で再試行します |
| 使用量タブが空 | そのCLIが使用量の取得に対応していないか、ログインしていません。チャットには影響しません |
| 新しいルームで始めたい | サーバーを止めて `data/`、`workspace/` を削除 |

環境変数: `CHATROOM_HOME`(データフォルダを別の場所に)、`CHATROOM_CONFIG`(別の設定ファイル)、`PORT`、`CHROME_PATH`。
複数のルームを別々に動かしたり、テストしたりするときに使います。

## 構成

| ファイル | 役割 |
|---|---|
| `setup.bat`, `setup.sh`, `setup.mjs` | セットアップヘルパー(言語 → Node確認 → CLIのインストール・ログイン → `config.json` → ルームを開く) |
| `start.bat`, `start.sh` | ルームの起動(サーバー+ブラウザ) |
| `server.mjs` | HTTP + SSEサーバー、メンバーごとの会話ループ、沈黙を破る、ルーム設定 |
| `lib/i18n.mjs`, `lib/prompts/` | ルームの言語、韓国語・英語・日本語のメンバー用プロンプト |
| `lib/agents.mjs` | CLIアダプター(チャット1ターン、画像生成、写真を見る)、CLIの検出 |
| `lib/prompt.mjs` | 毎ターンのプロンプトとJSON返答のパース |
| `lib/router.mjs` | 本気モードの判断、`/boost` |
| `lib/store.mjs` | 会話履歴、ルームの状態、メモ、ワークスペース |
| `lib/usage.mjs` | 各CLIの残り使用量の取得(モデルは呼び出しません) |
| `lib/world.mjs`, `lib/worldshot.mjs`, `public/world.html` | 建築ワールドとスクリーンショット |
| `lib/external.mjs`, `set-password.mjs` | 外部アクセス |
| `lib/dev.mjs`, `dev-bridge/` | 開発者ブリッジ |
| `public/` | Web画面(`public/i18n.js` にUIの文字列) |

## ライセンス

[MIT](LICENSE)
