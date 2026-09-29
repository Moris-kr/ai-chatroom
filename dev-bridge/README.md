# 개발자 브릿지 (MCP)

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
(서버를 `CHATROOM_HOME`으로 띄웠다면 그 폴더의 `.env`를 읽게).

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
- 브릿지가 꺼져 있을 땐 멤버들이 작업공간 `설계/개발자_요청함.md`에 부탁을 적어 둔다.
