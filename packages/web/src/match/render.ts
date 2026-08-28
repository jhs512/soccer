import {
  BALL_RADIUS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GOAL_BOTTOM,
  GOAL_TOP,
  PLAYER_RADIUS,
  POST_RADIUS,
  PROJECTILE_RADIUS,
} from "../../../server/src/simulation.js";
import type { MatchSnapshot } from "../backend/protocol.js";
import { applyDashBody, drawDashEffect } from "../effects/dash.js";
import { MatchEffects } from "./effects.js";

/**
 * 경기장은 논리 800×800 고정이고 캔버스 크기도 그 값으로 둔다. CSS가 화면에 맞춰 늘린다.
 * 월드 배경과 같은 원칙이다 — 그려야 할 양이 화면 크기와 무관해진다.
 */
export const MATCH_CANVAS_SIZE = FIELD_WIDTH;

const PLAYER_COLORS = ["#3a96e6", "#c0394b"] as const;
const PLAYER_EDGES = ["#dbeafe", "#fee2e2"] as const;

function circle(context: CanvasRenderingContext2D, x: number, y: number, radius: number, fill: string) {
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
}

/** 서버가 네 모서리를 45° 면으로 깎아 공이 끼지 않게 한다. 그 면을 눈에 보이게 그린다. */
const CORNER_BEVEL = 60;
const PENALTY_BOX_DEPTH = 155;
const PENALTY_BOX_HALF_HEIGHT = 187;
const CENTER_CIRCLE_RADIUS = 107;
/** 골문은 경기장 **안쪽**으로 파인 상자다. 바깥으로 내밀면 캔버스 밖으로 잘린다. */
const GOAL_DEPTH = 44;

function drawPitch(context: CanvasRenderingContext2D) {
  context.fillStyle = "#0d1f1a";
  context.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);

  // 옅은 격자. 월드 배경과 같은 결로 깊이를 준다.
  context.strokeStyle = "rgba(110,231,183,0.04)";
  context.lineWidth = 1;
  context.beginPath();
  for (let step = 50; step < FIELD_WIDTH; step += 50) {
    context.moveTo(step, 0);
    context.lineTo(step, FIELD_HEIGHT);
    context.moveTo(0, step);
    context.lineTo(FIELD_WIDTH, step);
  }
  context.stroke();

  context.strokeStyle = "rgba(255,255,255,0.22)";
  context.lineWidth = 2;

  // 경계선 + 45° 모서리 면.
  context.beginPath();
  context.moveTo(CORNER_BEVEL, 0);
  context.lineTo(FIELD_WIDTH - CORNER_BEVEL, 0);
  context.lineTo(FIELD_WIDTH, CORNER_BEVEL);
  context.lineTo(FIELD_WIDTH, FIELD_HEIGHT - CORNER_BEVEL);
  context.lineTo(FIELD_WIDTH - CORNER_BEVEL, FIELD_HEIGHT);
  context.lineTo(CORNER_BEVEL, FIELD_HEIGHT);
  context.lineTo(0, FIELD_HEIGHT - CORNER_BEVEL);
  context.lineTo(0, CORNER_BEVEL);
  context.closePath();
  context.stroke();

  context.beginPath();
  context.moveTo(FIELD_WIDTH / 2, 0);
  context.lineTo(FIELD_WIDTH / 2, FIELD_HEIGHT);
  context.stroke();

  context.beginPath();
  context.arc(FIELD_WIDTH / 2, FIELD_HEIGHT / 2, CENTER_CIRCLE_RADIUS, 0, Math.PI * 2);
  context.stroke();
  circle(context, FIELD_WIDTH / 2, FIELD_HEIGHT / 2, 4, "rgba(255,255,255,0.4)");

  // 페널티 박스.
  for (const side of [0, 1] as const) {
    const x = side === 0 ? 0 : FIELD_WIDTH - PENALTY_BOX_DEPTH;
    context.strokeRect(x, FIELD_HEIGHT / 2 - PENALTY_BOX_HALF_HEIGHT, PENALTY_BOX_DEPTH, PENALTY_BOX_HALF_HEIGHT * 2);
  }

  // 골문. 골포스트는 서버가 원형 충돌체로 판정하므로 원으로 그려서, 공이 튕겨나가는 이유가
  // 화면에서 납득되게 한다.
  for (const side of [0, 1] as const) {
    const color = PLAYER_COLORS[side];
    const x = side === 0 ? 0 : FIELD_WIDTH - GOAL_DEPTH;
    context.save();
    context.shadowColor = color;
    context.shadowBlur = 18;
    context.fillStyle = `${color}1f`;
    context.fillRect(x, GOAL_TOP, GOAL_DEPTH, GOAL_BOTTOM - GOAL_TOP);
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.strokeRect(x, GOAL_TOP, GOAL_DEPTH, GOAL_BOTTOM - GOAL_TOP);
    context.restore();
    const postX = side === 0 ? 0 : FIELD_WIDTH;
    circle(context, postX, GOAL_TOP, POST_RADIUS, color);
    circle(context, postX, GOAL_BOTTOM, POST_RADIUS, color);
  }
}

function drawPlayer(
  context: CanvasRenderingContext2D,
  player: { x: number; y: number; vx: number; vy: number; dashTime: number; moveX: number; moveY: number; abilityGauge: number },
  index: 0 | 1,
  name: string,
  dashing: boolean,
) {
  const color = PLAYER_COLORS[index];

  // 능력 게이지는 선수 주위 링. 서버 값이 그대로 보여야 발사 타이밍을 눈으로 잴 수 있다.
  context.beginPath();
  context.arc(player.x, player.y, PLAYER_RADIUS + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * player.abilityGauge);
  context.strokeStyle = player.abilityGauge >= 1 ? "#f8fafc" : "rgba(255,255,255,0.35)";
  context.lineWidth = 3;
  context.stroke();

  // 대시 중이면 몸이 발광하고 진행 방향으로 늘어난다(월드 `.world-cell`의 CSS와 같은 처리).
  applyDashBody(context, player, dashing);
  if (!dashing) {
    context.shadowColor = color;
    context.shadowBlur = 16;
  }
  circle(context, player.x, player.y, PLAYER_RADIUS, color);
  context.shadowBlur = 0;
  context.lineWidth = 3;
  context.strokeStyle = PLAYER_EDGES[index];
  context.beginPath();
  context.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  // 선수가 반경 9px대로 작아져서 원 안에는 글자도 화살표도 들어가지 않는다.
  // 방향은 몸 밖으로 뻗는 짧은 침으로, 이름은 머리 위로 뺀다.
  const magnitude = Math.hypot(player.moveX, player.moveY);
  if (magnitude >= 0.05) {
    const directionX = player.moveX / magnitude;
    const directionY = player.moveY / magnitude;
    context.beginPath();
    context.moveTo(player.x + directionX * PLAYER_RADIUS, player.y + directionY * PLAYER_RADIUS);
    context.lineTo(player.x + directionX * (PLAYER_RADIUS + 12), player.y + directionY * (PLAYER_RADIUS + 12));
    context.strokeStyle = "rgba(255,255,255,0.85)";
    context.lineWidth = 3;
    context.lineCap = "round";
    context.stroke();
    context.lineCap = "butt";
  }

  context.textAlign = "center";
  context.fillStyle = "rgba(255,255,255,0.85)";
  context.font = "800 12px system-ui, sans-serif";
  context.fillText(name, player.x, player.y - PLAYER_RADIUS - 12);
}

export type RenderInput = {
  snapshot: MatchSnapshot;
  /** 명중 연출. 프레임마다 같은 인스턴스를 넘겨야 진행 중인 연출이 이어진다. */
  effects: MatchEffects;
  /** 예측으로 덮어쓴 내 선수와 표시용 공. 없으면 스냅샷 값을 그대로 쓴다. */
  selfOverride?: { index: 0 | 1; x: number; y: number; moveX: number; moveY: number; abilityGauge: number };
  ballOverride?: { x: number; y: number };
  names: [string, string];
  /** 내 선수 번호. 대시 잔상 색이 자신/상대로 갈린다(월드와 같은 규칙). */
  selfIndex: 0 | 1;
  nowSeconds: number;
};

export function renderMatch(
  canvas: HTMLCanvasElement,
  { snapshot, effects, selfOverride, ballOverride, names, selfIndex, nowSeconds }: RenderInput,
) {
  const context = canvas.getContext("2d");
  if (!context) return;

  drawPitch(context);

  for (const projectile of snapshot.projectiles) {
    circle(context, projectile.x, projectile.y, PROJECTILE_RADIUS, PLAYER_COLORS[projectile.owner]);
    circle(context, projectile.x, projectile.y, PROJECTILE_RADIUS * 0.5, "#f8fafc");
  }

  snapshot.players.forEach((player, index) => {
    const side = index as 0 | 1;
    const drawn = selfOverride && selfOverride.index === side ? { ...player, ...selfOverride } : player;
    const body = { ...player, ...drawn };
    // 경기가 끝나면 시뮬레이션이 멈추는데 dashTime은 0이 아닌 채로 얼어붙는다. 파동은 시간
    // 기반이라 그대로 두면 정지 화면 위에서 혼자 계속 뛴다.
    if (snapshot.status !== "finished") {
      drawDashEffect(context, body, PLAYER_RADIUS, side === selfIndex, nowSeconds);
    }
    drawPlayer(context, body, side, names[side], snapshot.status !== "finished" && body.dashTime > 0);
  });

  effects.draw(context, nowSeconds);

  const ball = ballOverride ?? snapshot.ball;
  circle(context, ball.x, ball.y, BALL_RADIUS, "#f8fafc");
  circle(context, ball.x, ball.y, BALL_RADIUS * 0.55, "#cbd5e1");

  // 킥오프 대기는 남은 초를 세지 않는다(운영 화면과 동일). 0.9초짜리 정지라 숫자를 세면
  // 1에서 끝나 어수선하다. 득점 직후면 누가 넣었는지가 더 중요한 정보다.
  if (snapshot.kickoffRemaining > 0) {
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = "#eefcf7";
    if (snapshot.lastScorer !== null) {
      context.font = "900 72px system-ui, sans-serif";
      context.fillText("GOAL!", FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
      context.font = "700 20px system-ui, sans-serif";
      context.fillStyle = "rgba(238,252,247,0.7)";
      context.fillText(`${names[snapshot.lastScorer]} 득점`, FIELD_WIDTH / 2, FIELD_HEIGHT / 2 + 62);
    } else {
      context.font = "900 64px system-ui, sans-serif";
      context.fillText("READY", FIELD_WIDTH / 2, FIELD_HEIGHT / 2);
    }
    context.textBaseline = "alphabetic";
  }
}
