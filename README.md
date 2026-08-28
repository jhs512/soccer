# Blob Soccer ⚽

가입 없이 바로 시작하는 1:1 온라인 축구 게임. 운영 중: **https://soccer.oa.gg**

용어 정의는 [CONTEXT.md](CONTEXT.md)에, 배포 절차는 [docs/agents/handoff-adsense-and-deployment.md](docs/agents/handoff-adsense-and-deployment.md)에 있다.

## 저장소 상태 (2026-08-25)

이 저장소는 **복구 중**이다. 원본 작업 루트(`C:\Users\jangk\Documents\Codex\2026-08-07\matt-pocock-setup`)가 삭제됐고, 운영 중인 소스는 아래와 같이 절반만 되찾은 상태다.

| 패키지 | 상태 |
|---|---|
| `packages/server` | ✅ **원본 소스 전체.** Lightsail 배포 이미지(`game-server.14`)에서 추출했다. `pnpm --filter @blob-soccer/server build` 결과가 배포 산출물과 **MD5 단위로 일치**한다. |
| `packages/web` | 🚧 **재작성 중.** 원본 소스는 유실됐다. 월드(이동·채팅·리더보드·미니맵)와 온라인 경기(스냅샷 보간·로컬 예측·킥 선발동)까지 동작한다. 남은 것은 아래 참조. |
| `packages/game` | ❌ **소스 유실.** `package.json`만 남아있다. 물리는 `packages/server/src/simulation.ts`에 있고 웹이 그 모듈을 직접 import한다(복제 금지). |

재작성의 기준 문서: [docs/protocol.md](docs/protocol.md)(소켓 계약, 서버 소스에서 추출), [docs/web-ui.md](docs/web-ui.md)(운영 화면 DOM 구조 관찰).

`packages/web`에 아직 없는 것 — 모바일 조이스틱, 진행 중 경기 목록(`.world-live-games`), 도전 수락 카드(`.challenge-card`), 관전 화면, 이모지, AI 연습, 관리자 대시보드(`/admin`).

프런트 재작성에 쓸 근거 자료는 `.scratch/`에 모아뒀다 (git 추적 대상 아님).

| 경로 | 내용 |
|---|---|
| `.scratch/live-build/` | 라이브에 배포된 빌드 산출물. `assets/game-C4lVv5at.js`(54KB 미니파이)가 현재 운영 중인 프런트 전체, `assets/game-BDkWVUZk.css`(28.9KB)가 스타일 전문 |
| `.scratch/live-image/` | Lightsail 이미지에서 추출한 원본 (`packages/server/src` + 워크스페이스 매니페스트) |
| `.scratch/legacy-front/` | 세션 전사에서 복원한 **구세대** 프런트 소스. 라이브와 다른 세대지만 캔버스 렌더링·WebAudio·로컬 게임 루프는 재작성의 출발점으로 쓸 수 있다 |
| `.scratch/recovered/` | 전사 복원 전체 결과 (`scripts/recover_claude_session_v3.py` 출력) |

## 실행

```bash
pnpm install
```

```bash
pnpm test
```

```bash
pnpm --filter @blob-soccer/server build && pnpm --filter @blob-soccer/server start
```

## 라이브 앱 구성

`packages/server/src/server.ts`가 처리하는 소켓 이벤트 기준.

- **LIVE WORLD** — 접속자가 돌아다니는 로비 월드(섹터 A1~J10, 미니맵, ping). `world-input` / `world-state` / `world-minimap` / `world-resume`
- **로비 채팅** — 전체(`world`)·주변(`sector`) 스코프. `lobby-chat` / `lobby-chat-history`
- **도전** — 월드에서 상대를 직접 지목해 1:1 신청. `challenge-request` / `challenge-response` / `challenge-cancel`
- **관전** — 진행 중인 경기 구경. `spectate-request` / `spectate-state` / `spectate-leave`
- **리더보드** — 이번 접속의 성적표. 재접속하면 리셋된다
- **퀵매치** — 자동매칭 1:1. `join-queue` / `match-found` / `match-start`
- **AI 연습** — 오프라인 연습 경기

경기 규칙은 경기장 800×800, 제한시간 150초, 대시 + **FIRE 발사체**(`abilityGauge` 충전 후 발사, `PROJECTILE_SPEED = 960`). 물리 판정은 전부 권위 서버(`simulation.ts`)가 한다.

## 배포

**이 저장소에서 배포하지 않는다.** `gh-pages` 브랜치와 Lightsail `blob-soccer-server`는 운영 중인 서비스다. 절차는 핸드오프 문서에 있으나, 실행은 명시적 승인 뒤에만 한다.

## 이전 프로토타입

`prototype/index.html` — 의존성 0의 오프라인 초안(2026-08-06). 현재 앱과 직접 연결되지 않지만, 밸런스 상수의 원본 기록으로 남겨둔다.
