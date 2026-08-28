import { WORLD_CELL_SIZE, WORLD_HEIGHT, WORLD_WIDTH } from "../backend/protocol.js";
import {
  BACKDROP_HEIGHT,
  BACKDROP_SCALE_X,
  BACKDROP_SCALE_Y,
  BACKDROP_WIDTH,
  backdropX,
  backdropY,
} from "./view-space.js";

/**
 * 월드 배경을 한 프레임 그린다.
 *
 * 섹터(A1~J10)가 **사각형으로 보이는 것**이 이 배경의 존재 이유다. 옅은 격자만 깔면 어디서
 * 구역이 갈리는지 알 수 없고, 채팅의 "주변 F6"이 화면의 어느 범위를 말하는지 대응이 안 된다.
 *
 * 값은 운영 캔버스의 픽셀을 직접 읽어 맞췄다(`docs/web-ui.md`). 1200×760에 선 몇십 개라
 * 매 프레임 다시 그려도 비용이 거의 없다 — 그래서 카메라를 프레임마다 부드럽게 따라갈 수 있다.
 */
const BACKGROUND = "#06140f";
const GRID_COLOR = "rgba(110, 231, 183, 0.05)";
const SECTOR_COLOR = "rgba(110, 231, 183, 0.35)";
/**
 * 작은 칸은 섹터를 **정확히 8등분**한 월드 단위다(800 / 8 = 100).
 *
 * 화면 정사각형(80px)으로 잡으면 섹터와 7.5 : 1 이 되어 칸 경계가 섹터 경계와 어긋난다.
 * 세로 배율이 가로보다 1.3% 작아 화면상 75×76px로 아주 살짝 눌리지만, 섹터 자체도 같은 이유로
 * 600×608px이라 격자와 섹터가 같은 비율로 눌린다 — 즉 정수비가 유지된다.
 */
const SUB_CELLS_PER_SECTOR = 8;
/** 맵 바깥. 서버가 좌표를 0~8000으로 잘라내므로 여기로는 못 나간다 — 그 사실이 보여야 한다. */
const OUTSIDE_COLOR = "#0a1512";
const OUTSIDE_HATCH_COLOR = "rgba(148, 163, 184, 0.09)";
const OUTSIDE_HATCH_STEP = 22;
const BOUNDARY_COLOR = "rgba(248, 113, 133, 0.55)";

export function drawBackdrop(context: CanvasRenderingContext2D, camera: { x: number; y: number }) {
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, BACKDROP_WIDTH, BACKDROP_HEIGHT);

  const halfSpanX = BACKDROP_WIDTH / 2 / BACKDROP_SCALE_X;
  const halfSpanY = BACKDROP_HEIGHT / 2 / BACKDROP_SCALE_Y;

  /** 월드 좌표에 못 박힌 세로/가로선을 긋는다. 카메라를 따라 흐르고, 맵 밖은 건너뛴다. */
  const gridLines = (step: number, color: string, width: number) => {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    for (
      let index = Math.floor((camera.x - halfSpanX) / step);
      index <= Math.ceil((camera.x + halfSpanX) / step);
      index += 1
    ) {
      const worldX = index * step;
      if (worldX < 0 || worldX > WORLD_WIDTH) continue;
      const x = backdropX(worldX, camera.x);
      context.moveTo(x, 0);
      context.lineTo(x, BACKDROP_HEIGHT);
    }
    for (
      let index = Math.floor((camera.y - halfSpanY) / step);
      index <= Math.ceil((camera.y + halfSpanY) / step);
      index += 1
    ) {
      const worldY = index * step;
      if (worldY < 0 || worldY > WORLD_HEIGHT) continue;
      const y = backdropY(worldY, camera.y);
      context.moveTo(0, y);
      context.lineTo(BACKDROP_WIDTH, y);
    }
    context.stroke();
  };

  // 작은 칸 8개가 정확히 섹터 하나를 채운다. 두 격자가 같은 월드 좌표계 위에 있으므로
  // 섹터 경계선은 언제나 작은 칸 경계와 겹친다.
  gridLines(WORLD_CELL_SIZE / SUB_CELLS_PER_SECTOR, GRID_COLOR, 1);
  gridLines(WORLD_CELL_SIZE, SECTOR_COLOR, 2);

  // 맵 바깥. 격자를 덮어 죽은 영역으로 칠하고 경계선을 긋는다. 이게 없으면 가장자리에서
  // 벽에 막혔는데 화면은 계속 이어져 보여서, 조작이 먹통이 된 것처럼 느껴진다.
  const left = backdropX(0, camera.x);
  const right = backdropX(WORLD_WIDTH, camera.x);
  const top = backdropY(0, camera.y);
  const bottom = backdropY(WORLD_HEIGHT, camera.y);

  const outside: Array<[number, number, number, number]> = [];
  if (left > 0) outside.push([0, 0, left, BACKDROP_HEIGHT]);
  if (right < BACKDROP_WIDTH) outside.push([right, 0, BACKDROP_WIDTH - right, BACKDROP_HEIGHT]);
  if (top > 0) outside.push([0, 0, BACKDROP_WIDTH, top]);
  if (bottom < BACKDROP_HEIGHT) outside.push([0, bottom, BACKDROP_WIDTH, BACKDROP_HEIGHT - bottom]);
  if (outside.length === 0) return;

  // 새까맣게 두면 낭떠러지처럼 보인다. 안쪽보다 조금 밝게 깔고 빗금을 그어
  // "빈 공간"이 아니라 "갈 수 없는 구역"으로 읽히게 한다.
  context.fillStyle = OUTSIDE_COLOR;
  for (const [x, y, width, height] of outside) context.fillRect(x, y, width, height);

  context.save();
  context.beginPath();
  for (const [x, y, width, height] of outside) context.rect(x, y, width, height);
  context.clip();
  context.strokeStyle = OUTSIDE_HATCH_COLOR;
  context.lineWidth = 1;
  context.beginPath();
  const diagonal = BACKDROP_WIDTH + BACKDROP_HEIGHT;
  for (let offset = -BACKDROP_HEIGHT; offset < diagonal; offset += OUTSIDE_HATCH_STEP) {
    context.moveTo(offset, 0);
    context.lineTo(offset + BACKDROP_HEIGHT, BACKDROP_HEIGHT);
  }
  context.stroke();
  context.restore();

  context.strokeStyle = BOUNDARY_COLOR;
  context.lineWidth = 3;
  context.strokeRect(left, top, right - left, bottom - top);
}
