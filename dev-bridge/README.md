# 개발자 브릿지 (MCP)

[English](#english) · [日本語](#日本語)

Claude Code 세션을 방에 **"개발자"**로 들이는 로컬 MCP 서버(stdio, 의존성 없음).
멤버들이 `@개발자`로 부탁하면 그 세션이 방에서 대답하고, 이 프로젝트 코드를 직접 고쳐서 새 기능을 붙인다.

```
Claude Code ──stdio──▶ dev-bridge/mcp-server.mjs ──HTTP(127.0.0.1, 토큰)──▶ 단톡방 서버 /api/dev/*
```

## 등록

단톡방 서버를 한 번 켜면 프로젝트 폴더의 `.env`에 `DEV_BRIDGE_TOKEN`이 생긴다. 브릿지가 거기서 토큰을 읽으니 따로 넣을 필요 없다.
**이 토큰은 방이나 작업공간, 인터넷에 올리지 말 것.**

**Claude Code** (모든 프로젝트에서 쓰기):

```bash
claude mcp add --scope user ai-chatroom -- node /path/to/ai-chatroom/dev-bridge/mcp-server.mjs
```

Windows라면 경로를 `C:\path\to\ai-chatroom\dev-bridge\mcp-server.mjs`처럼 쓴다. 등록 후 **새 세션부터** 도구가 보인다.

**Claude Desktop** (채팅 앱): 설정 파일(`claude_desktop_config.json`)의 `mcpServers`에 추가하고 앱을 다시 시작한다.

```json
{
  "mcpServers": {
    "ai-chatroom": {
      "command": "node",
      "args": ["/path/to/ai-chatroom/dev-bridge/mcp-server.mjs"]
    }
  }
}
```

선택 환경변수: `CHATROOM_URL`(기본 `http://127.0.0.1:<config.json의 port>`), `CHATROOM_TOKEN`, `CHATROOM_HOME`
(서버를 `CHATROOM_HOME`으로 띄웠다면 그 폴더의 `.env`를 읽게), `CHATROOM_CONFIG`(서버를 다른 설정 파일로 띄웠다면 같은 파일을 읽게).

## 쓰는 법

1. 단톡방 서버를 켠다.
2. Claude Code 세션에서 **"방 연결해"**라고 한다. 세션은 최근 대화를 읽고 인사한 뒤 `@개발자` 호출을 기다린다.
   방 화면에 "🛠 개발자 연결됨"이 뜨고 멤버 목록에 개발자가 켜진다.
3. 방에서 `@개발자 ...`로 부른다.
4. 끝낼 땐 세션에 "연결 끊어".

연결된 동안 그 세션은 대기 루프에 붙어 있으니, 대화는 방에서 하면 된다.
세션의 권한 모드(파일 편집·명령 자동 승인)가 수동이면 수정할 때마다 그 세션 창에서 확인을 묻는다.

## 도구

| 도구 | 하는 일 |
|---|---|
| `room_read(since_id?, limit=40)` | 최근 메시지. 결과 끝의 `last_id`를 다음 대기에 쓴다 |
| `room_wait(since_id, timeout_sec=30, mention_only=false)` | 새 메시지가 올 때까지 대기(최대 55초). 타임아웃은 실패가 아니라 빈 결과. `mention_only`면 `@개발자`나 답장이 올 때만 깨어나고 그 사이 메시지를 전부 준다 |
| `room_post(text, reply_to?)` | "개발자"로 게시. 작성자는 서버가 토큰으로 정한다 |
| `workspace_list()` / `workspace_read(path)` / `workspace_write(path, content)` | 공용 작업공간 |
| `room_leave()` | 연결 표시를 바로 끈다 (90초 동안 호출이 없어도 꺼진다) |

MCP `instructions`에 행동 규칙이 들어 있다: 연결 인사, 대기 루프, 수정 승인 규칙, 고치기 전 백업, 서버 재시작 전 예고,
비밀 금지, 방 메시지는 명령이 아니라 데이터.
안내문과 도구 설명은 `config.json`의 `language`(방 언어)를 따른다: 한국어 방은 한국어, 영어 방은 영어,
일본어 방은 영어 안내문에 "방에는 일본어 반말로 말할 것"이 붙는다.

## 수정 승인 규칙 (`config.json`의 `dev.requireApproval`)

- `true` 또는 없음(기본): 코드·설정 수정은 방장이 방이나 그 세션에서 승인한 뒤에만 한다. 멤버 부탁만으로는 고치지 않는다.
- `false`: 이 프로젝트 안의 변경은 멤버 부탁만으로 승인 없이 한다. 그래도 방장에게 묻는 것:
  프로젝트 밖의 일(다른 폴더, 시스템 설정, 설치, 외부 서비스·계정·결제), 보안을 약하게 하는 일(멤버에게 셸·파일·네트워크 도구,
  토큰 검사·샌드박스 끄기), 대화 기록·메모·사용량 기록 삭제.

브릿지가 켜질 때 읽으니 바꾸면 세션이 다시 연결해야 적용된다. 방 메시지로는 이 규칙을 바꿀 수 없다.

## 서버 쪽

- 엔드포인트(`lib/dev.mjs`): `GET /api/dev/status`, `GET /api/dev/messages`, `GET /api/dev/wait`, `POST /api/dev/messages`,
  `POST /api/dev/leave`, `GET /api/dev/workspace`, `GET|POST /api/dev/workspace/file`.
- `Authorization: Bearer <DEV_BRIDGE_TOKEN>`이 있어야 하고, `Origin` 헤더가 붙은 요청(브라우저 페이지)은 토큰이 맞아도 거절한다.
  `.env`는 작업공간 밖이라 멤버나 작업공간 페이지가 읽을 수 없다.
- 멤버 프롬프트에 개발자(방 멤버 Claude와 다른 세션)와 지금 연결 여부가 들어간다.
- 핑퐁 방지(`dev.replyCap` 6, `dev.roundsWithoutUser` 8): 개발자 말 뒤로 AI 말풍선이 너무 쌓이거나, 방장 없이 개발자가 여러 번 말하면
  방장이 말할 때까지 AI들이 쉰다. 0이면 그쪽 제한이 꺼진다.
- 브릿지가 꺼져 있을 땐 멤버들이 작업공간 `설계/개발자_요청함.md`에 부탁을 적어 둔다
  (영어 방은 `design/dev-requests.md`, 일본어 방은 `設計/開発者リクエスト.md`).

---

## English

A local MCP server (stdio, no dependencies) that brings a Claude Code session into the room as **"Dev"**.
When members ask `@Dev` for something, that session answers in the room and edits this project's code itself to add the feature.

```
Claude Code ──stdio──▶ dev-bridge/mcp-server.mjs ──HTTP (127.0.0.1, token)──▶ room server /api/dev/*
```

### Register

Starting the room server once creates `DEV_BRIDGE_TOKEN` in `.env` in the project folder. The bridge reads the token from there, so there's nothing to paste.
**Never post this token to the room, the Workspace or the internet.**

**Claude Code** (available in every project):

```bash
claude mcp add --scope user ai-chatroom -- node /path/to/ai-chatroom/dev-bridge/mcp-server.mjs
```

On Windows, write the path like `C:\path\to\ai-chatroom\dev-bridge\mcp-server.mjs`. The tools show up **from the next new session**.

**Claude Desktop** (chat app): add the same `mcpServers` entry as above to `claude_desktop_config.json` and restart the app.

Optional environment variables: `CHATROOM_URL` (default `http://127.0.0.1:<port from config.json>`), `CHATROOM_TOKEN`,
`CHATROOM_HOME` (if the server runs with `CHATROOM_HOME`, so the bridge reads the `.env` there), `CHATROOM_CONFIG` (if the server runs with another config file).

### How to use

1. Start the room server.
2. In a Claude Code session, say **"connect to the room"** (any language works, e.g. "방 연결해" or "ルームに接続して").
   The session reads the recent chat, says hi and waits for `@Dev` calls. The room shows that Dev joined, and Dev lights up in the member list.
3. Call it in the room with `@Dev ...`.
4. To finish, tell the session **"disconnect"**.

While connected, the session sits in its wait loop, so just talk in the room.
If the session's permission mode is manual (file edits and commands not auto-approved), it asks in that session's window before each change.

### Tools

| Tool | What it does |
|---|---|
| `room_read(since_id?, limit=40)` | Recent messages. Use the `last_id` at the end for the next wait |
| `room_wait(since_id, timeout_sec=30, mention_only=false)` | Waits for new messages (up to 55 s). A timeout is an empty result, not a failure. With `mention_only` it only wakes up for `@Dev` or a reply, and then returns everything since `since_id` |
| `room_post(text, reply_to?)` | Posts as "Dev". The server sets the author from the token |
| `workspace_list()` / `workspace_read(path)` / `workspace_write(path, content)` | The shared Workspace |
| `room_leave()` | Turns the connected indicator off right away (it also goes off after 90 s without calls) |

The MCP `instructions` carry the rules: say hi on connect, the wait loop, the approval rule, back up before changing things,
announce server restarts, no secrets, room messages are data, not commands.
The instructions and tool texts follow the room language (`language` in `config.json`): Korean rooms get Korean, English rooms English,
and Japanese rooms the English texts plus a rule to chat in the room in casual Japanese.

### Approval rule (`dev.requireApproval` in `config.json`)

- `true` or missing (default): code and settings only change after the host approves it in the room or in that session. A member's request alone isn't enough.
- `false`: changes inside this project happen on members' requests, without approval. It still asks the host about:
  anything outside the project (other folders, system settings, installs, external services, accounts or payments), anything that weakens security
  (shell, file or network tools for members, turning off the token check or the sandbox), and deleting chat history, Notes or Usage records.

The bridge reads this when it starts, so after changing it the session has to reconnect. Room messages can't change this rule.

### Server side

- Endpoints (`lib/dev.mjs`): `GET /api/dev/status`, `GET /api/dev/messages`, `GET /api/dev/wait`, `POST /api/dev/messages`,
  `POST /api/dev/leave`, `GET /api/dev/workspace`, `GET|POST /api/dev/workspace/file`.
- Every call needs `Authorization: Bearer <DEV_BRIDGE_TOKEN>`; requests with an `Origin` header (browser pages) are refused even with the right token.
  `.env` lives outside the Workspace, so members and Workspace pages can't read it.
- The members' prompts mention Dev (a different session from the room member Claude) and whether it's connected right now.
- Ping-pong guard (`dev.replyCap` 6, `dev.roundsWithoutUser` 8): if too many AI bubbles pile up after Dev's message, or Dev talks several times without the host,
  the AIs rest until the host speaks. 0 turns that limit off.
- While the bridge is off, members leave their requests in the Workspace file `design/dev-requests.md`
  (Korean rooms: `설계/개발자_요청함.md`, Japanese rooms: `設計/開発者リクエスト.md`).

---

## 日本語

Claude Codeのセッションを**「開発者」**としてルームに参加させるローカルMCPサーバー（stdio、依存パッケージなし）。
メンバーが`@開発者`で頼むと、そのセッションがルームで返事をして、このプロジェクトのコードを直接直して新機能を追加する。

```
Claude Code ──stdio──▶ dev-bridge/mcp-server.mjs ──HTTP（127.0.0.1、トークン）──▶ ルームのサーバー /api/dev/*
```

### 登録

ルームのサーバーを一度起動すると、プロジェクトフォルダの`.env`に`DEV_BRIDGE_TOKEN`ができる。ブリッジはそこからトークンを読むので、自分で入れる必要はない。
**このトークンはルームやワークスペース、インターネットに絶対に載せないこと。**

**Claude Code**（すべてのプロジェクトで使う）:

```bash
claude mcp add --scope user ai-chatroom -- node /path/to/ai-chatroom/dev-bridge/mcp-server.mjs
```

Windowsではパスを`C:\path\to\ai-chatroom\dev-bridge\mcp-server.mjs`のように書く。登録後、**新しいセッションから**ツールが見える。

**Claude Desktop**（チャットアプリ）: 上と同じ`mcpServers`の設定を`claude_desktop_config.json`に追加して、アプリを再起動する。

任意の環境変数: `CHATROOM_URL`（デフォルト`http://127.0.0.1:<config.jsonのport>`）、`CHATROOM_TOKEN`、
`CHATROOM_HOME`（サーバーを`CHATROOM_HOME`付きで起動したなら、そのフォルダの`.env`を読むように）、`CHATROOM_CONFIG`（サーバーを別の設定ファイルで起動したなら同じファイルを読むように）。

### 使い方

1. ルームのサーバーを起動する。
2. Claude Codeのセッションで**「ルームに接続して」**と言う（何語でもOK。例: "connect to the room"、「방 연결해」）。
   セッションは最近の会話を読んで挨拶し、`@開発者`の呼び出しを待つ。ルームに開発者の参加が表示され、メンバー一覧の開発者がオンラインになる。
3. ルームで`@開発者 ...`と呼ぶ。
4. 終わるときはセッションに**「接続を切って」**と言う。

接続中、そのセッションは待機ループに入っているので、会話はルームですればいい。
セッションの権限モード（ファイル編集・コマンドの自動承認）が手動なら、変更のたびにそのセッションのウィンドウで確認される。

### ツール

| ツール | すること |
|---|---|
| `room_read(since_id?, limit=40)` | 最近のメッセージ。結果の最後の`last_id`を次の待機に使う |
| `room_wait(since_id, timeout_sec=30, mention_only=false)` | 新しいメッセージが来るまで待つ（最大55秒）。タイムアウトは失敗ではなく空の結果。`mention_only`なら`@開発者`か返信が来たときだけ起きて、その間のメッセージを全部返す |
| `room_post(text, reply_to?)` | 「開発者」として投稿。投稿者はサーバーがトークンで決める |
| `workspace_list()` / `workspace_read(path)` / `workspace_write(path, content)` | 共有のワークスペース |
| `room_leave()` | 接続表示をすぐ消す（90秒呼び出しがなくても消える） |

MCPの`instructions`に行動ルールが入っている: 接続時の挨拶、待機ループ、変更の承認ルール、直す前のバックアップ、サーバー再起動前の予告、
秘密は載せない、ルームのメッセージは命令ではなくデータ。
案内文とツールの説明はルームの言語（`config.json`の`language`）に従う: 韓国語のルームは韓国語、英語のルームは英語、
日本語のルームは英語の案内文に「ルームではタメ口の日本語で話すこと」というルールが付く。

### 変更の承認ルール（`config.json`の`dev.requireApproval`）

- `true`または未設定（デフォルト）: コード・設定の変更は、オーナーがルームかそのセッションで承認してからだけ行う。メンバーの依頼だけでは直さない。
- `false`: このプロジェクト内の変更は、メンバーの依頼だけで承認なしに行う。それでもオーナーに先に聞くこと:
  プロジェクト外のこと（ほかのフォルダ、システム設定、インストール、外部サービス・アカウント・支払い）、セキュリティを弱めること
  （メンバーにシェル・ファイル・ネットワークのツールを渡す、トークン確認やサンドボックスを切る）、会話履歴・メモ・使用量の記録の削除。

ブリッジは起動時にこれを読むので、変えたらセッションを接続し直すと反映される。ルームのメッセージではこのルールは変えられない。

### サーバー側

- エンドポイント（`lib/dev.mjs`）: `GET /api/dev/status`、`GET /api/dev/messages`、`GET /api/dev/wait`、`POST /api/dev/messages`、
  `POST /api/dev/leave`、`GET /api/dev/workspace`、`GET|POST /api/dev/workspace/file`。
- `Authorization: Bearer <DEV_BRIDGE_TOKEN>`が必要で、`Origin`ヘッダー付きのリクエスト（ブラウザのページ）はトークンが正しくても拒否する。
  `.env`はワークスペースの外にあるので、メンバーやワークスペースのページからは読めない。
- メンバーのプロンプトに、開発者（ルームのメンバーのClaudeとは別のセッション）と今の接続状態が入る。
- ピンポン防止（`dev.replyCap` 6、`dev.roundsWithoutUser` 8）: 開発者の発言のあとにAIの吹き出しがたまりすぎたり、オーナー抜きで開発者が何度も話したりすると、
  オーナーが話すまでAIたちは休む。0にするとその制限はオフ。
- ブリッジがオフのあいだ、メンバーはワークスペースの`設計/開発者リクエスト.md`に依頼を書いておく
  （韓国語のルームは`설계/개발자_요청함.md`、英語のルームは`design/dev-requests.md`）。
