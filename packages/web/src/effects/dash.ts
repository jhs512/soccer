/**
 * 대시 연출의 **단일 정의**.
 *
 * 월드는 DOM+CSS(`live.css`)로, 경기 화면은 캔버스로 그린다. 그리는 수단이 달라도 보이는 것은
 * 같아야 해서, 개수·간격·주기·불투명도를 여기 한 곳에 두고 양쪽이 참조한다. 이 값이 갈라지면
 * 같은 대시가 로비에서와 경기에서 다르게 보인다.
 *
 * 원본 수치는 `live.css`의 `.dash-ghost` / `world-dash-wave` / `world-speed-line`에서 가져왔다.
 */

/** 잔상 5개. 뒤로 갈수록 옅어진다(`.dash-ghost:nth-of-type(n)`의 opacity). */
export const GHOST_OPACITIES = [0.62, 0.43, 0.28, 0.16, 0.07] as const;
/** 잔상 간격 = 반지름 × 이 값. 아바타 크기가 바뀌어도 비례가 유지된다. */
export const GHOST_SPACING_RATIO = 0.62;

/**
 * 연출 상자의 크기 = 몸 반지름 × 이 값.
 *
 * CSS의 `.dash-fx`는 원래 아바타 박스(이름표까지 포함한 74px)를 기준으로 잡혀 있었다.
 * 아바타를 1/3로 줄이자 몸 대비 오라가 과하게 커지고, 상자가 정사각형이 아니라서 파동이
 * 타원이 됐다. 양쪽 모두 몸 반지름에서 출발하도록 바꿔 크기와 모양을 맞춘다.
 */
export const AURA_RADIUS_RATIO = 4;
/** 속도선이 깔리는 영역 — 몸 반지름 대비 가로/세로 배수. */
export const SPEED_FIELD_WIDTH_RATIO = 6;
export const SPEED_FIELD_HEIGHT_RATIO = 4;

/** 퍼지는 파동 2개. 0.42초 주기로 반복하고 두 번째는 반 박자 늦다. */
export const WAVE_PERIOD_SECONDS = 0.42;
export const WAVE_DELAYS = [0, 0.2] as const;
export const WAVE_SCALE_FROM = 0.72;
export const WAVE_SCALE_TO = 1.65;
export const WAVE_OPACITY_FROM = 0.9;

/** 진행 반대 방향으로 흐르는 속도선 4개. 굵기·세로 위치는 `.dash-speed-line`을 따랐다. */
export const SPEED_LINE_PERIOD_SECONDS = 0.28;
export const SPEED_LINES = [
  { lengthRatio: 0.72, offsetRatio: -0.84, delay: -0.08 },
  { lengthRatio: 0.96, offsetRatio: -0.3, delay: -0.2 },
  { lengthRatio: 0.84, offsetRatio: 0.3, delay: -0.14 },
  { lengthRatio: 0.58, offsetRatio: 0.84, delay: -0.02 },
] as const;

/** 대시가 이 시간 이상 남아 있으면 최대 강도. 남은 시간이 줄면 연출도 같이 잦아든다. */
export const FULL_STRENGTH_SECONDS = 0.2;

/**
 * 색과 알파. `live.css`의 16진 알파를 그대로 옮긴 값이다.
 *
 * 잔상만 몸 색을 따라가고(자신=초록, 상대=장미) 파동·속도선은 양쪽 모두 고정 초록이다.
 * 월드가 원래 그렇게 되어 있으므로 경기 화면도 같은 규칙을 쓴다.
 */
export const DASH_COLORS = {
  /** `.dash-ghost` — background #10b981**24**, border #6ee7b7**8f** */
  selfGhostFill: 0x24 / 255,
  selfGhostFillColor: "#10b981",
  selfGhostEdgeColor: "#6ee7b7",
  selfGhostEdge: 0x8f / 255,
  /** `.world-avatar:not(.is-self) .dash-ghost` — #f43f5e**1a** / #fb7185**73** */
  otherGhostFill: 0x1a / 255,
  otherGhostFillColor: "#f43f5e",
  otherGhostEdgeColor: "#fb7185",
  otherGhostEdge: 0x73 / 255,
  /** `.dash-wave` — #a7f3d0**b8** */
  waveColor: "#a7f3d0",
  waveAlpha: 0xb8 / 255,
  /** `.dash-speed-line` — 끝단 #d1fae5**eb** */
  speedLineColor: "#d1fae5",
  speedLineAlpha: 0xeb / 255,
  /** `.world-avatar.is-dashing .world-cell` 의 발광 링. */
  glowColor: "#6ee7b7",
} as const;

/** `@keyframes world-dash-lunge` — 진행 방향으로 늘어나고 옆으로 눌린다. */
export const LUNGE_STRETCH = 1.13;
export const LUNGE_SQUASH = 0.9;

/**
 * 대시 중인 몸.
 *
 * 월드에서는 `.world-cell`이 CSS로 채도·밝기를 올리고 발광 링을 두르며 lunge 애니메이션으로
 * 늘어난다. 캔버스에는 그 셋이 없어서 같은 대시인데도 경기 화면 쪽이 밋밋했다.
 * 호출한 쪽은 이 함수가 세팅한 변환 안에서 몸을 그리고 `context.restore()` 하면 된다.
 */
export function applyDashBody(
  context: CanvasRenderingContext2D,
  player: { x: number; y: number; vx: number; vy: number; dashTime: number },
  dashing = player.dashTime > 0,
) {
  context.save();
  if (!dashing) return;
  const speed = Math.hypot(player.vx, player.vy);
  if (speed < 1) return;

  const strength = clamp01(player.dashTime / FULL_STRENGTH_SECONDS);
  context.shadowColor = DASH_COLORS.glowColor;
  context.shadowBlur = 24 * strength;

  // 진행 방향으로 늘리고 옆으로 누른다. 회전시켜 축을 맞춘 뒤 스케일한다.
  context.translate(player.x, player.y);
  context.rotate(Math.atan2(player.vy, player.vx));
  const stretch = 1 + (LUNGE_STRETCH - 1) * strength;
  const squash = 1 - (1 - LUNGE_SQUASH) * strength;
  context.scale(stretch, squash);
  context.rotate(-Math.atan2(player.vy, player.vx));
  context.translate(-player.x, -player.y);
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 0~1 반복 위상. CSS animation의 진행도와 같은 역할이다. */
const phase = (nowSeconds: number, period: number, delay: number) => {
  const raw = ((nowSeconds - delay) % period) / period;
  return raw < 0 ? raw + 1 : raw;
};

type DashTarget = { x: number; y: number; vx: number; vy: number; dashTime: number };

/**
 * 캔버스에 대시 연출을 그린다. 월드의 CSS 연출과 같은 구성이다 —
 * 잔상 5개, 퍼지는 파동 2개, 뒤로 흐르는 속도선 4개.
 *
 * 강도는 서버가 보내주는 `dashTime`에서 나온다. 클라이언트가 따로 타이머를 돌리면 서버가
 * 대시를 끝낸 뒤에도 잔상이 남아 실제보다 오래 빠른 것처럼 보인다.
 */
export function drawDashEffect(
  context: CanvasRenderingContext2D,
  player: DashTarget,
  radius: number,
  self: boolean,
  nowSeconds: number,
) {
  if (player.dashTime <= 0) return;
  const speed = Math.hypot(player.vx, player.vy);
  if (speed < 1) return;

  const strength = clamp01(player.dashTime / FULL_STRENGTH_SECONDS);
  const backX = -player.vx / speed;
  const backY = -player.vy / speed;
  const spacing = radius * GHOST_SPACING_RATIO;

  context.save();

  // 잔상 — 지나온 자리에 몸이 남는다. 자신은 초록, 상대는 장미(월드 CSS와 같은 규칙).
  const fillColor = self ? DASH_COLORS.selfGhostFillColor : DASH_COLORS.otherGhostFillColor;
  const fillAlpha = self ? DASH_COLORS.selfGhostFill : DASH_COLORS.otherGhostFill;
  const edgeColor = self ? DASH_COLORS.selfGhostEdgeColor : DASH_COLORS.otherGhostEdgeColor;
  const edgeAlpha = self ? DASH_COLORS.selfGhostEdge : DASH_COLORS.otherGhostEdge;
  GHOST_OPACITIES.forEach((opacity, index) => {
    const distance = spacing * (index + 1);
    context.beginPath();
    context.arc(player.x + backX * distance, player.y + backY * distance, radius * (1 - index * 0.09), 0, Math.PI * 2);
    context.fillStyle = withAlpha(fillColor, fillAlpha * opacity * strength);
    context.fill();
    context.strokeStyle = withAlpha(edgeColor, edgeAlpha * opacity * strength);
    context.lineWidth = 2;
    context.stroke();
  });

  // 파동 — 몸에서 퍼져 나간다.
  for (const delay of WAVE_DELAYS) {
    const progress = phase(nowSeconds, WAVE_PERIOD_SECONDS, delay);
    const scale = WAVE_SCALE_FROM + (WAVE_SCALE_TO - WAVE_SCALE_FROM) * progress;
    context.beginPath();
    context.arc(player.x, player.y, radius * AURA_RADIUS_RATIO * scale, 0, Math.PI * 2);
    context.strokeStyle = withAlpha(DASH_COLORS.waveColor, DASH_COLORS.waveAlpha * WAVE_OPACITY_FROM * (1 - progress) * strength);
    context.lineWidth = 2;
    context.stroke();
  }

  // 속도선 — 진행 반대쪽으로 흘러간다.
  const acrossX = -backY;
  const acrossY = backX;
  for (const line of SPEED_LINES) {
    const progress = phase(nowSeconds, SPEED_LINE_PERIOD_SECONDS, line.delay);
    // 0 → 0.35 구간에서 밝아지고 이후 사라진다(`world-speed-line` 키프레임).
    const opacity = progress < 0.35 ? progress / 0.35 : 1 - (progress - 0.35) / 0.65;
    const field = radius * SPEED_FIELD_WIDTH_RATIO;
    const travel = field * (-0.55 + progress * 0.85);
    const start = radius * 1.2 + travel;
    const length = field * 0.5 * line.lengthRatio;
    const offset = radius * SPEED_FIELD_HEIGHT_RATIO * 0.5 * line.offsetRatio;
    context.beginPath();
    context.moveTo(
      player.x + backX * start + acrossX * offset,
      player.y + backY * start + acrossY * offset,
    );
    context.lineTo(
      player.x + backX * (start + length) + acrossX * offset,
      player.y + backY * (start + length) + acrossY * offset,
    );
    context.strokeStyle = withAlpha(DASH_COLORS.speedLineColor, DASH_COLORS.speedLineAlpha * clamp01(opacity) * strength);
    context.lineWidth = 2;
    context.lineCap = "round";
    context.stroke();
  }

  context.restore();
}

/** `#rrggbb` 에 알파를 붙인다. */
function withAlpha(hex: string, alpha: number) {
  const value = Math.round(clamp01(alpha) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${hex}${value}`;
}
