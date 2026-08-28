/**
 * 월드 좌표 ↔ 화면 좌표 변환. **여기가 유일한 정의다.**
 *
 * 뷰포트를 재지 않는다. 가로 100%가 월드 1600단위, 세로 100%가 1000단위인 고정 상수이고,
 * 창 크기가 바뀌면 보이는 범위가 줄어드는 게 아니라 같은 범위가 눌린다(운영 화면 관찰값).
 * 측정 기반으로 만들면 측정값이 0인 환경에서 모든 것이 좌상단에 겹친다 — `docs/web-ui.md`.
 *
 * DOM 요소(아바타·섹터 라벨)는 퍼센트로, 배경 캔버스는 논리 픽셀로 놓기 때문에
 * 두 단위가 모두 필요하다. 둘이 어긋나면 라벨과 격자가 따로 논다.
 */
export const VIEW_SPAN_X = 1_600;
export const VIEW_SPAN_Y = 1_000;

/** 배경 캔버스의 논리 해상도. 화면 크기와 무관하게 고정이고 CSS가 늘린다. */
export const BACKDROP_WIDTH = 1_200;
export const BACKDROP_HEIGHT = 760;

export const BACKDROP_SCALE_X = BACKDROP_WIDTH / VIEW_SPAN_X;
export const BACKDROP_SCALE_Y = BACKDROP_HEIGHT / VIEW_SPAN_Y;

export const leftPercent = (worldX: number, cameraX: number) => `${50 + ((worldX - cameraX) / VIEW_SPAN_X) * 100}%`;
export const topPercent = (worldY: number, cameraY: number) => `${50 + ((worldY - cameraY) / VIEW_SPAN_Y) * 100}%`;

export const backdropX = (worldX: number, cameraX: number) =>
  (worldX - cameraX) * BACKDROP_SCALE_X + BACKDROP_WIDTH / 2;
export const backdropY = (worldY: number, cameraY: number) =>
  (worldY - cameraY) * BACKDROP_SCALE_Y + BACKDROP_HEIGHT / 2;
