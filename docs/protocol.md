# 소켓 프로토콜

`packages/server/src/server.ts`에서 직접 추출한 계약이다. 프런트 소스가 유실됐으므로, 재작성의 기준은 이 문서가 아니라 **서버 소스와 `packages/server/src/server.integration.test.ts`(873줄)** 다. 이 문서는 그 요약이며 서버와 어긋나면 서버가 옳다.

## 접속

1. `POST {backend}/anonymous-profile` → `201 { token, nickname }`. 토큰은 `localStorage`에 보관한다.
2. `io(backend, { auth: { token } })`.
3. 접속 직후 서버가 밀어주는 것: `lobby-chat-history`, `leaderboard`.

접속만으로는 월드에 등장하지 않는다. `player-active`를 보내야 활성 상태(`presence {state:"active"}`)가 되고 아바타가 생긴다. 그 전까지 클라이언트는 `world-state.preview === true`인 관람 카메라만 받는다.

`GET {backend}/health` → `{ status: "ok" }`.

## 월드

맵 8000×8000. 섹터는 10×10(`WORLD_CELL_SIZE = 800`) — A1~J10. 서버 틱 50ms.

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| C→S | `world-input` | `{ moveX, moveY, dash? }` — `hypot(moveX,moveY) <= 1.001`. 초과하면 **조용히 버려진다** |
| C→S | `world-resume` | 이전 `world-state.resumeToken` 문자열. 활성화 **전에만** 받는다 |
| C→S | `world-pong` | `world-ping`으로 받은 nonce 그대로 |
| S→C | `world-state` | `{ map, selfId, preview, camera, players[], resumeToken? }` (50ms) |
| S→C | `world-minimap` | 3초 간격 |
| S→C | `world-ping` | nonce (2초 간격). 왕복이 ping 측정이며 EMA 0.25로 평활된다 |

`world-state.players`는 **카메라 반경 1600 이내만** 담긴다(관심 영역). 각 항목은 `{ id, nickname, x, y, moveX, moveY, pingMs, dashActive, dashGauge, activity }`. 좌표는 소수 2자리로 반올림돼 온다.

월드 이동: 속도 660, 대시 2.2배 0.28초, 게이지 재충전 0.9초. 대시는 `dashGauge >= 1`일 때만 발동한다.

`resumeToken`은 서버가 HMAC으로 서명한 위치다. 재접속 시 이걸 `world-resume`으로 돌려주면 마지막 위치에서 시작한다. 클라이언트가 좌표를 임의로 지어낼 수 없다.

## 채팅

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| C→S | `lobby-chat` | `{ message, scope: "world" \| "sector" }` (문자열만 보내면 `world`로 간주) |
| S→C | `lobby-chat` | `LobbyChatMessage` |
| S→C | `lobby-chat-history` | `LobbyChatMessage[]` |

`sector` 스코프는 같은 섹터가 아니라 **인접 섹터까지**(체비쇼프 거리 1 이내, 즉 3×3) 전달된다. 섹터가 바뀌면 서버가 `lobby-chat-history`를 다시 보낸다. 경기 중(`socketSessionIds`에 있음)에는 전송이 거부된다.

## 도전

월드에서 **반경 280 이내**의 상대만 지목할 수 있다. 초과하면 `challenge-status {state:"too-far"}`.

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| C→S | `challenge-request` | `{ targetId }` — `world-state.players[].id` |
| C→S | `challenge-response` | `{ challengeId, accept }` |
| C→S | `challenge-cancel` | `{ challengeId }` |
| S→C | `challenge-received` | `{ challengeId, from, expiresInMs }` |
| S→C | `challenge-status` | `{ challengeId?, state, opponent? }` — `pending` \| `accepted` \| `declined` \| `cancelled` \| `expired` \| `too-far` |

수락되면 바로 온라인 세션이 열린다(대기열을 거치지 않는다). 기본 만료 10초.

## 매칭과 경기

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| C→S | `join-queue` / `leave-queue` | 없음 |
| C→S | `join-match` | `sessionId` |
| C→S | `input` | `{ moveX, moveY, dash, fire? }` |
| C→S | `emote` | 인덱스 (화이트리스트 + 속도 제한) |
| C→S | `leave` | 없음 — 즉시 몰수패 |
| S→C | `queue-status` | `{ state: "searching" \| "idle", reason? }` |
| S→C | `match-found` | `{ matchId, startsInMs, opponent: { nickname } }` (기본 3초 뒤 시작) |
| S→C | `match-start` | `{ matchId, sessionId, playerIndex, opponent: { nickname }, state }` |
| S→C | `session` | `sessionId` |
| S→C | `state` | `serializeState()` 결과 (60Hz) |
| S→C | `result` / `forfeit` | 종료 |
| S→C | `opponent-disconnected` | `{ graceSeconds: 15 }` |

`state` 스냅샷 구조 — `players[2]`는 `{ x, y, vx, vy, dashCooldown, dashTime, abilityGauge, face, moveX, moveY }`, 그 외 `ball`, `projectiles[]`(`{owner,x,y,vx,vy}`), `score`, `status`, `kickoffRemaining`, `lastScorer`, `goalCount`, `t`.

**`t`가 시뮬레이션 시각(초)이며 클라이언트 스냅샷 보간의 시간축이다.** 도착 시각이 아니라 이 값을 기준으로 보간해야 한다(도착 시점 기준 lerp는 패킷 지터가 속도 요동으로 번져서 폐기된 접근이다 — `memory/blob-soccer-architecture.md` 참조).

## 관전

| 방향 | 이벤트 | 페이로드 |
|---|---|---|
| C→S | `spectate-request` | `{ targetId }` |
| C→S | `spectate-leave` | 없음 |
| S→C | `spectate-start` | `{ mode: "online" \| "ai", sessionId, names, state }` |
| S→C | `spectate-state` | `SpectatorState` |
| S→C | `spectate-ended` | `{ reason: "left" \| "unavailable" }` |

AI 연습도 관전 대상이다. 그 경우 호스트 클라이언트가 `game-presence {mode:"ai"}`로 알린 뒤 `ai-spectator-state`로 자기 화면 상태를 올려주고, 서버는 검증만 해서 중계한다. 경기를 끝내면 `game-presence {mode:"idle"}`.

## 자리 비움

`player-inactive`를 보내면 월드에서 사라지고 대기열에서 빠진다(`queue-status {state:"idle", reason:"afk"}`). 서버도 `queueAfkMs`(기본 90초) 무입력이면 대기열에서 제외한다. `player-active`로 복귀한다.

## 운영 대시보드

`/admin` 네임스페이스. 접속 시 `admin-snapshot`을 받고, 이후 변경마다 200ms 병합해 다시 받는다. `avgTickMs`가 서버 과부하 신호다.
