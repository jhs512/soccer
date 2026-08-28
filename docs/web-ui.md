# 월드 화면 구조

운영 중인 `https://soccer.oa.gg/`의 DOM을 직접 관찰해 적었다(2026-08-25). `packages/web` 소스가 유실됐으므로 재작성의 기준은 이 관찰과 `src/styles/live.css`(배포된 스타일시트 전문)다.

## 좌표계 — 측정하지 않는다

이게 이 화면 설계의 핵심이다. **JS로 뷰포트 크기를 재지 않는다.**

- 자기 아바타는 항상 `left: 50%; top: 50%`. 카메라가 곧 자신이므로 계산이 필요 없다.
- 나머지 월드 요소는 **퍼센트**로 놓는다. 월드 단위와 퍼센트의 환산은 **고정 상수**다.

```
left% = 50 + (worldX - cameraX) / 1600 * 100
top%  = 50 + (worldY - cameraY) / 1000 * 100
```

가로 100% = 월드 1600단위, 세로 100% = 월드 1000단위. 창 크기를 800×600으로 줄여도 이 값은 그대로였다(섹터 간격 가로 50%, 세로 80% 유지). 즉 화면이 좁아지면 보이는 월드 범위가 줄어드는 게 아니라 **같은 범위가 눌려 들어간다**.

가로 1600은 서버의 `WORLD_INTEREST_RADIUS`와 같은 값이다. 서버가 반경 1600 안쪽만 보내주므로 화면 밖 플레이어는 애초에 오지 않는다.

이 설계 덕분에 `window.innerWidth`나 `ResizeObserver`에 의존하지 않는다. 숨겨진 탭이나 임베드 프레임처럼 측정값이 0이거나 관찰 콜백이 안 오는 환경에서도 화면이 정상이다. 측정 기반으로 만들면 그런 환경에서 모든 아바타가 좌상단에 겹쳐 그려진다.

## `.world-shell` 직계 자식 순서

`<section class="world-shell">`

1. `<canvas class="world-canvas">` — 배경. **논리 해상도 1200×760 고정**이고 CSS로 늘린다(창을 줄여도 `width`/`height` 속성은 안 변한다). 자세한 내용은 아래 "배경 캔버스".
2. `<div class="world-title"><small>LIVE WORLD</small><strong>사커.오아지지</strong></div>`
3. `<div class="world-tip">` — `<small>TIP</small>` + 문구. 예: "상대방을 클릭하면 대전 신청이 됩니다." 일정 시간 뒤 사라진다.
4. `<div class="world-sectors">` — `<span>` 100개(A1~J10). 각각 인라인 퍼센트 위치.
5. **아바타들** — `<div class="world-avatar ...">`. `world-canvas` 안이 아니라 shell의 **직계 자식**이다.
6. `<aside class="world-chat">`
7. `<aside class="world-leaderboard">`
8. `<button class="random-match-button">`
9. `<button class="ai-practice-button">AI 연습</button>`
10. `<div class="world-minimap">`
11. `<div class="world-joystick">`
12. `<button class="world-dash-button">`

`.world-live-games`(진행 중 경기 목록)와 `.challenge-card`/`.challenge-pending`은 해당 상황에서만 나타난다.

## 배경 캔버스

논리 1200×760 고정. 가로 1200px가 월드 1600단위이므로 **0.75 px/단위**, 세로 760px가 1000단위이므로 **0.76 px/단위**다.

두 겹으로 그린다. 운영 캔버스의 픽셀을 직접 읽어 얻은 값이다.

| 요소 | 값 |
|---|---|
| 바탕 | `#06140F` |
| 옅은 격자 | **80 논리px 정사각형**, `rgba(110,231,183,0.05)`, 1px |
| 섹터 경계 | 가로 600px / 세로 608px 간격(= 월드 800단위), `rgba(110,231,183,0.35)`, 2px |

옅은 격자는 월드 단위가 아니라 **화면 정사각형**이다. 가로세로 배율이 다르므로(0.75 vs 0.76) 월드 단위로 잡으면 격자가 찌그러진다. 대신 카메라를 따라 흘러야 한다 — 화면에 고정하면 움직여도 멈춰 보인다. 카메라를 움직이며 측정했을 때 격자 위치가 69px → 18px로 따라 이동했다.

**섹터 경계선이 이 배경의 존재 이유다.** 옅은 격자만 깔면 A1~J10 구역이 어디서 갈리는지 알 수 없고, 채팅의 "주변 F6"이 화면의 어느 범위를 말하는지 대응이 안 된다.

## 아바타

```html
<div class="world-avatar is-self " style="left:50%; top:50%;
     --trail-x-1:0px; --trail-y-1:0px; … --trail-x-5:0px; --trail-y-5:0px; --dash-angle:0deg;">
  <span class="world-cell-wrap"><span class="world-cell"></span></span>
  <b>다정한 판다</b>
  <small class="ping-great">8 ms</small>
</div>
```

`<button>`이 아니라 `<div>`다. 클릭은 있지만(대전 신청) 버튼 시맨틱을 쓰지 않는다.

상태 클래스: `is-self`, `is-dashing`, `is-playing`. 대시 잔상은 CSS 변수 `--trail-x-1..5` / `--trail-y-1..5`로 넘기고 `.dash-ghost:nth-of-type(n)`이 각각을 쓴다. `--dash-angle`은 `.dash-speed-field`의 회전이다. 경기 중이면 `<span class="world-game-status">`가 붙는다.

ping 클래스는 `ping-great` / `ping-good` / `ping-fair` / `ping-poor` / `ping-unknown`.

## 채팅

```html
<aside class="world-chat">
  <header>
    <span class="chat-heading"><b>CHAT</b><em>1</em></span>
    <span class="chat-header-actions">
      <button class="chat-minimize-button" aria-label="채팅 숨기기">숨기기</button>
      <button class="chat-expand-button" aria-label="채팅 전체화면으로 열기">확대</button>
    </span>
  </header>
  <div class="chat-filters" role="group" aria-label="채팅 필터">
    <button class="is-active" aria-label="전체 채팅 보기">전체</button>
    <button aria-label="주변 칸 -- 채팅만 보기">주변 --</button>
  </div>
  <div class="chat-feed">…</div>
  <form><input><button>전송</button></form>
</aside>
```

숨기기/확대 버튼은 CSS에서 모바일(`width<=640` 또는 `pointer:coarse`)에서만 보인다. 확대는 `.world-chat.is-expanded`로 전체화면이 되고, 그때 `--chat-viewport-top` / `--chat-viewport-height` CSS 변수를 쓴다(가상 키보드 대응).

## 미니맵

```html
<div class="world-minimap" data-testid="world-minimap" data-corners="square"
     data-precision="sector-center" role="img" aria-label="월드 미니맵">
  <div class="minimap-sectors"><span>A1</span>…<span>J10</span></div>
  <i class="is-self" style="left:95%; top:5%"></i>
</div>
```

점은 퍼센트로 놓는다. 서버가 좌표를 섹터 중심으로 뭉개서 보내므로(`precision: "sector-center"`) **보간하면 안 된다** — 3초마다 툭툭 옮겨 앉는 게 정상이다.

## 조작 UI

- `.world-joystick > span` — `transform: translate(x%, y%)`로 스틱을 옮긴다.
- `.world-dash-button` — `style="--dash-gauge: Ndeg"`로 게이지를 그리고(`conic-gradient`), `aria-pressed`로 활성 상태를 표시한다. 0~360deg가 0~1 게이지에 대응한다.

데스크톱(`pointer:fine`, `width>=800`)에서는 조이스틱이 `opacity:.32`로 흐려질 뿐 사라지지 않는다.
