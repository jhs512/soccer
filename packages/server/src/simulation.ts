/**
 * 권위 서버의 경기 시뮬레이션.
 *
 * 웹 클라이언트도 이 모듈을 그대로 불러와 온라인 표시 보정의 예측에 사용한다.
 * 물리가 한 곳에만 있어야 예측과 판정이 어긋나지 않으므로 Node 전용 API는 쓰지 않는다.
 */

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 800;
export const GOAL_TOP = 275;
export const GOAL_BOTTOM = 525;
/**
 * 2026-08-25: 선수를 1/3로 줄였다(28 → 9.33).
 *
 * 공(15)보다 작아졌다는 뜻이다. 공을 몸으로 미는 맛은 줄고 위치를 정확히 잡아야 하는 게임이 된다.
 * 벽 여유·선수 간 최소 거리·충격탄 발사 오프셋이 전부 이 값에서 나오므로 밸런스가 함께 움직인다.
 */
export const PLAYER_RADIUS = 28 / 3;
export const BALL_RADIUS = 15;
export const POST_RADIUS = 9;
export const KICKOFF_FREEZE_SECONDS = 0.9;

export type SweptHit = { normalX: number; normalY: number; incidence: number };

/** 발사체 이동 선분과 공의 최초 접촉점을 구해 중심 통과 뒤 역방향 충격을 막는다. */
export function sweptProjectileBallHit(
  previousX: number,
  previousY: number,
  nextX: number,
  nextY: number,
  ballX: number,
  ballY: number,
  combinedRadius: number,
): SweptHit | null {
  const dx = nextX - previousX;
  const dy = nextY - previousY;
  const speedSquared = dx * dx + dy * dy;
  if (speedSquared < 1e-9) return null;
  const startX = previousX - ballX;
  const startY = previousY - ballY;
  const c = startX * startX + startY * startY - combinedRadius * combinedRadius;
  const b = 2 * (startX * dx + startY * dy);
  const discriminant = b * b - 4 * speedSquared * c;
  if (discriminant < 0) return null;
  const entry = (-b - Math.sqrt(discriminant)) / (2 * speedSquared);
  const startedInside = c <= 0;
  if ((!startedInside && entry < 0) || entry > 1) return null;
  const impactX = previousX + dx * entry;
  const impactY = previousY + dy * entry;
  const normalX = (ballX - impactX) / combinedRadius;
  const normalY = (ballY - impactY) / combinedRadius;
  const speed = Math.sqrt(speedSquared);
  return { normalX, normalY, incidence: Math.max(0, (dx * normalX + dy * normalY) / speed) };
}

/** 서버와 클라이언트가 동일한 궤적을 그리려면 같은 크기로 적분해야 한다. */
export const SUB_STEP_SECONDS = 1 / 120;
/** 한 번의 호출이 따라잡을 수 있는 최대 경기 시간. 스톨 뒤 폭주를 막는다. */
export const MAX_CATCH_UP_SECONDS = 0.25;

// 2026-08-08: 온라인 반응 여유를 위해 공은 절반, 플레이어는 추가로 1/3
// (원본 420 대비 1/6). 가속·대시는 비례 유지해 반응 곡선의 느낌은 같다.
const PLAYER_ACCELERATION = 433;
const PLAYER_MAX_SPEED = 70;
const PLAYER_DASH_MAX_SPEED = PLAYER_MAX_SPEED * 5.8;
const PLAYER_DRAG = 5.2;
const PLAYER_DASH_DRAG = 1.5;
const MOVE_RESPONSE_SECONDS = 0.09;
const PLAYER_BOUNCE = 0.42;
const PLAYER_WALL_BOUNCE = 0.3;
// 일반 대시 자체를 이전보다 강하게 하고, 별도 타이밍 보너스는 두지 않는다.
const DASH_IMPULSE = 320;
const DASH_TIME = 0.36;
export const ABILITY_RECHARGE_SECONDS = 0.9;
// 온라인 친화 튜닝: 지연 오차는 공 속도에 비례한다(오차 = 속도 × 표시 지연).
// 드리블(일반 킥 ~530px/s)은 그대로 두고 대포알 슛과 핀볼 난반사만 줄여
// 양쪽 화면의 경합 판정이 일치하고 슛에 반응할 시간이 생기게 한다.
const BALL_DRAG = 1.05;
const BALL_MAX_SPEED = 632.5;
const WIN_SCORE = 3;
const BALL_BOUNCE = 0.55;
const WALL_BOUNCE = 0.62;
const PLAYER_MASS = 5;
const BALL_MASS = 1;
const KICK_PUSH = 85;
const KICK_DASH_BOOST = 1.7;
const PROJECTILE_SPEED = 960;
export const PROJECTILE_RADIUS = 14;
const PROJECTILE_BALL_IMPULSE = 760;
const KICKOFF_BALL_OFFSET = 40;
/** 모서리 45° 면의 크기. 각 벽을 따라 이만큼 안쪽에서 대각선으로 깎는다. */
const CORNER_BEVEL = 60;

export type SimInput = { moveX: number; moveY: number; dash: boolean; fire: boolean };
export type SimPlayer = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashCooldown: number;
  dashTime: number;
  /** 대시와 충격탄이 함께 쓰는 0..1 공용 자원. */
  abilityGauge: number;
  face: -1 | 1;
  moveX: number;
  moveY: number;
};
export type SimBall = { x: number; y: number; vx: number; vy: number };
export type SimProjectile = { owner: 0 | 1; x: number; y: number; vx: number; vy: number };
export type SimState = {
  players: [SimPlayer, SimPlayer];
  ball: SimBall;
  projectiles: SimProjectile[];
  score: [number, number];
  status: "playing" | "finished";
  /** 킥오프 우위: 실점한 쪽이 준비할 동안 양쪽이 제자리에서 기다리는 남은 시간. */
  kickoffRemaining: number;
  lastScorer: 0 | 1 | null;
  /** 득점이 확정될 때마다 증가한다. 클라이언트가 득점 연출을 놓치지 않는 기준. */
  goalCount: number;
  /**
   * 경기 시작 이후 흐른 시뮬레이션 시간(초). 클라이언트 스냅샷 보간의
   * 시간축으로 쓰여 패킷 도착 지터를 표시에서 분리한다.
   */
  simTime: number;
};

export type SimStepReport = {
  /** 다음 호출로 넘길 잔여 시간. */
  accumulator: number;
  /** 이번 호출에서 실제로 진행한 고정 스텝 수. */
  steps: number;
  /** 이번 호출에서 발생한 선수-공 접촉 수. */
  kicks: number;
  /** 이번 호출에서 확정된 득점 수. */
  goals: number;
};

export const createSimInput = (): SimInput => ({ moveX: 0, moveY: 0, dash: false, fire: false });

export const createSimPlayer = (left: boolean): SimPlayer => ({
  x: left ? FIELD_WIDTH * 0.25 : FIELD_WIDTH * 0.75,
  y: FIELD_HEIGHT / 2,
  vx: 0,
  vy: 0,
  dashCooldown: 0,
  dashTime: 0,
  abilityGauge: 1,
  face: left ? 1 : -1,
  moveX: 0,
  moveY: 0,
});

export const createSimState = (): SimState => ({
  players: [createSimPlayer(true), createSimPlayer(false)],
  ball: { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: 0, vy: 0 },
  projectiles: [],
  score: [0, 0],
  status: "playing",
  kickoffRemaining: 0,
  lastScorer: null,
  goalCount: 0,
  simTime: 0,
});

export function cloneSimState(state: SimState): SimState {
  return {
    players: [{ ...state.players[0] }, { ...state.players[1] }],
    ball: { ...state.ball },
    projectiles: (state.projectiles ?? []).map((projectile) => ({ ...projectile })),
    score: [state.score[0], state.score[1]],
    status: state.status,
    kickoffRemaining: state.kickoffRemaining ?? 0,
    lastScorer: state.lastScorer ?? null,
    goalCount: state.goalCount ?? 0,
    simTime: state.simTime ?? 0,
  };
}

function fireProjectile(state: SimState, owner: 0 | 1, input: SimInput) {
  const player = state.players[owner];
  if (!input.fire || player.abilityGauge < 1) return;
  const magnitude = Math.hypot(input.moveX, input.moveY);
  const movementMagnitude = Math.hypot(player.moveX, player.moveY);
  const directionX = magnitude > 0 ? input.moveX / magnitude : movementMagnitude > 0.05 ? player.moveX / movementMagnitude : player.face;
  const directionY = magnitude > 0 ? input.moveY / magnitude : movementMagnitude > 0.05 ? player.moveY / movementMagnitude : 0;
  const offset = PLAYER_RADIUS + PROJECTILE_RADIUS + 3;
  state.projectiles.push({
    owner,
    x: player.x + directionX * offset,
    y: player.y + directionY * offset,
    vx: directionX * PROJECTILE_SPEED,
    vy: directionY * PROJECTILE_SPEED,
  });
  player.abilityGauge = 0;
  player.dashCooldown = ABILITY_RECHARGE_SECONDS;
}

function advanceProjectiles(state: SimState, dt: number) {
  for (let index = state.projectiles.length - 1; index >= 0; index -= 1) {
    const projectile = state.projectiles[index]!;
    const previousX = projectile.x;
    const previousY = projectile.y;
    projectile.x += projectile.vx * dt;
    projectile.y += projectile.vy * dt;
    const hit = sweptProjectileBallHit(previousX, previousY, projectile.x, projectile.y, state.ball.x, state.ball.y, BALL_RADIUS + PROJECTILE_RADIUS);
    if (hit) {
      // 당구처럼 맞은 각도만큼만 전달한다.
      //
      // 맞은 공은 언제나 두 중심을 잇는 선(법선)을 따라 나가고, 그 속도는 충격탄 속도의
      // **법선 성분**만큼이다. 정면이면 전부, 스치면 거의 0. 예전에는 `0.75 + incidence * 0.25`라
      // 스치듯 맞아도 75%가 들어가서 각도가 사실상 의미가 없었다.
      //
      // 공이 이미 움직이고 있으면 상대속도를 봐야 한다. 공이 충격탄에서 멀어지는 중이면
      // 따라잡지 못한 것이므로 힘이 실리지 않는다.
      const relativeNormalSpeed =
        (projectile.vx - state.ball.vx) * hit.normalX + (projectile.vy - state.ball.vy) * hit.normalY;
      if (relativeNormalSpeed > 0) {
        const impulse = PROJECTILE_BALL_IMPULSE * (relativeNormalSpeed / PROJECTILE_SPEED);
        state.ball.vx += hit.normalX * impulse;
        state.ball.vy += hit.normalY * impulse;
      }
    }
    if (hit || projectile.x < 0 || projectile.x > FIELD_WIDTH || projectile.y < 0 || projectile.y > FIELD_HEIGHT) {
      state.projectiles.splice(index, 1);
    }
  }
}

/**
 * 한 선수를 한 스텝 진행한다. 클라이언트 예측도 이 함수를 그대로 사용해
 * 서버 판정과 같은 궤적을 그린다.
 */
export function advanceSimPlayer(player: SimPlayer, input: SimInput, dt: number) {
  const magnitude = Math.hypot(input.moveX, input.moveY);
  const scale = magnitude > 1 ? 1 / magnitude : 1;
  const directionX = input.moveX * scale;
  const directionY = input.moveY * scale;
  const response = 1 - Math.exp(-dt / MOVE_RESPONSE_SECONDS);
  player.moveX += (directionX - player.moveX) * response;
  player.moveY += (directionY - player.moveY) * response;
  if (directionX || directionY) {
    player.vx += player.moveX * PLAYER_ACCELERATION * dt;
    player.vy += player.moveY * PLAYER_ACCELERATION * dt;
    if (directionX) player.face = directionX > 0 ? 1 : -1;
  }

  player.abilityGauge = Math.min(1, player.abilityGauge + dt / ABILITY_RECHARGE_SECONDS);
  player.dashCooldown = (1 - player.abilityGauge) * ABILITY_RECHARGE_SECONDS;
  player.dashTime = Math.max(0, player.dashTime - dt);
  if (input.dash && player.abilityGauge >= 1) {
    let dashX = directionX;
    let dashY = directionY;
    if (!dashX && !dashY) {
      const speed = Math.hypot(player.vx, player.vy);
      if (speed > 20) {
        dashX = player.vx / speed;
        dashY = player.vy / speed;
      } else {
        dashX = player.face;
      }
    }
    player.vx += dashX * DASH_IMPULSE;
    player.vy += dashY * DASH_IMPULSE;
    player.abilityGauge = 0;
    player.dashCooldown = ABILITY_RECHARGE_SECONDS;
    player.dashTime = DASH_TIME;
  }

  const drag = 1 / (1 + (player.dashTime > 0 ? PLAYER_DASH_DRAG : PLAYER_DRAG) * dt);
  player.vx *= drag;
  player.vy *= drag;
  const maximum = player.dashTime > 0 ? PLAYER_DASH_MAX_SPEED : PLAYER_MAX_SPEED;
  const speed = Math.hypot(player.vx, player.vy);
  if (speed > maximum) {
    player.vx = player.vx / speed * maximum;
    player.vy = player.vy / speed * maximum;
  }

  player.x += player.vx * dt;
  player.y += player.vy * dt;
  if (player.x < PLAYER_RADIUS) { player.x = PLAYER_RADIUS; player.vx = Math.abs(player.vx) * PLAYER_WALL_BOUNCE; }
  if (player.x > FIELD_WIDTH - PLAYER_RADIUS) { player.x = FIELD_WIDTH - PLAYER_RADIUS; player.vx = -Math.abs(player.vx) * PLAYER_WALL_BOUNCE; }
  if (player.y < PLAYER_RADIUS) { player.y = PLAYER_RADIUS; player.vy = Math.abs(player.vy) * PLAYER_WALL_BOUNCE; }
  if (player.y > FIELD_HEIGHT - PLAYER_RADIUS) { player.y = FIELD_HEIGHT - PLAYER_RADIUS; player.vy = -Math.abs(player.vy) * PLAYER_WALL_BOUNCE; }
}

function collidePlayers(first: SimPlayer, second: SimPlayer) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  const minimum = PLAYER_RADIUS * 2;
  if (distance >= minimum || distance < 0.0001) return;
  const nx = dx / distance;
  const ny = dy / distance;
  const overlap = (minimum - distance) / 2;
  first.x -= nx * overlap;
  first.y -= ny * overlap;
  second.x += nx * overlap;
  second.y += ny * overlap;
  const normalVelocity = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
  if (normalVelocity > 0) return;
  const impulse = -(1 + PLAYER_BOUNCE) * normalVelocity / 2;
  first.vx -= nx * impulse;
  first.vy -= ny * impulse;
  second.vx += nx * impulse;
  second.vy += ny * impulse;
}

/**
 * 선수-공 충돌을 처리하고 접촉했으면 true를 돌려준다.
 * 클라이언트도 이 함수로 내 킥을 즉시 예측한다(선발동 후보강).
 */
export function collideSimPlayerWithBall(ball: SimBall, player: SimPlayer) {
  const dx = ball.x - player.x;
  const dy = ball.y - player.y;
  const distance = Math.hypot(dx, dy);
  const minimum = PLAYER_RADIUS + BALL_RADIUS;
  if (distance >= minimum || distance < 0.0001) return false;
  const nx = dx / distance;
  const ny = dy / distance;
  ball.x = player.x + nx * minimum;
  ball.y = player.y + ny * minimum;
  const normalVelocity = (ball.vx - player.vx) * nx + (ball.vy - player.vy) * ny;
  const inverseMass = 1 / BALL_MASS + 1 / PLAYER_MASS;
  const impulse = -(1 + BALL_BOUNCE) * Math.min(normalVelocity, 0) / inverseMass;
  const push = (KICK_PUSH + Math.hypot(player.vx, player.vy) * 0.85) * (player.dashTime > 0 ? KICK_DASH_BOOST : 1);
  ball.vx += nx * (impulse / BALL_MASS + push);
  ball.vy += ny * (impulse / BALL_MASS + push);
  player.vx -= nx * (impulse / PLAYER_MASS) * 0.5;
  player.vy -= ny * (impulse / PLAYER_MASS) * 0.5;
  return true;
}

function collidePost(ball: SimBall, x: number, y: number) {
  const dx = ball.x - x;
  const dy = ball.y - y;
  const distance = Math.hypot(dx, dy);
  const minimum = BALL_RADIUS + POST_RADIUS;
  if (distance >= minimum || distance < 0.0001) return;
  const nx = dx / distance;
  const ny = dy / distance;
  ball.x = x + nx * minimum;
  ball.y = y + ny * minimum;
  const normalVelocity = ball.vx * nx + ball.vy * ny;
  ball.vx -= (1 + WALL_BOUNCE) * normalVelocity * nx;
  ball.vy -= (1 + WALL_BOUNCE) * normalVelocity * ny;
}

/**
 * 공을 진행시키고, 골라인을 완전히 넘었으면 득점한 플레이어 번호를 돌려준다.
 * 클라이언트는 표시 전용 공 예측에 재사용한다(득점 반환값은 무시).
 */
export function advanceSimBall(ball: SimBall, dt: number): 0 | 1 | null {
  const drag = 1 / (1 + BALL_DRAG * dt);
  ball.vx *= drag;
  ball.vy *= drag;
  const speed = Math.hypot(ball.vx, ball.vy);
  if (speed > BALL_MAX_SPEED) {
    ball.vx = ball.vx / speed * BALL_MAX_SPEED;
    ball.vy = ball.vy / speed * BALL_MAX_SPEED;
  }
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y < BALL_RADIUS) { ball.y = BALL_RADIUS; ball.vy = -ball.vy * WALL_BOUNCE; }
  if (ball.y > FIELD_HEIGHT - BALL_RADIUS) { ball.y = FIELD_HEIGHT - BALL_RADIUS; ball.vy = -ball.vy * WALL_BOUNCE; }

  // 골문 높이 안에서는 옆선을 벽으로 막지 않는다. 막으면 골라인 앞에서 튕겨
  // 나가 득점이 확정되지 않는다.
  const inGoalMouth = ball.y > GOAL_TOP && ball.y < GOAL_BOTTOM;
  if (!inGoalMouth) {
    if (ball.x < BALL_RADIUS) { ball.x = BALL_RADIUS; ball.vx = -ball.vx * WALL_BOUNCE; }
    if (ball.x > FIELD_WIDTH - BALL_RADIUS) { ball.x = FIELD_WIDTH - BALL_RADIUS; ball.vx = -ball.vx * WALL_BOUNCE; }
  } else {
    if (ball.x < -BALL_RADIUS * 0.5) return 1;
    if (ball.x > FIELD_WIDTH + BALL_RADIUS * 0.5) return 0;
  }

  for (const postX of [0, FIELD_WIDTH]) {
    collidePost(ball, postX, GOAL_TOP);
    collidePost(ball, postX, GOAL_BOTTOM);
  }

  // 구석 포켓 방지: 네 모서리를 45° 면으로 깎는다. 90° 포켓은 공을 가두지만
  // 45° 면의 법선은 경기장 안쪽을 향해 공이 항상 필드로 되튀어 나온다.
  for (const [cornerX, cornerY] of [[0, 0], [FIELD_WIDTH, 0], [0, FIELD_HEIGHT], [FIELD_WIDTH, FIELD_HEIGHT]] as const) {
    const signX = cornerX === 0 ? 1 : -1;
    const signY = cornerY === 0 ? 1 : -1;
    const along = (ball.x - cornerX) * signX + (ball.y - cornerY) * signY;
    const penetration = BALL_RADIUS - (along - CORNER_BEVEL) * Math.SQRT1_2;
    if (penetration <= 0) continue;
    const nx = signX * Math.SQRT1_2;
    const ny = signY * Math.SQRT1_2;
    ball.x += nx * penetration;
    ball.y += ny * penetration;
    const normalVelocity = ball.vx * nx + ball.vy * ny;
    if (normalVelocity < 0) {
      ball.vx -= (1 + WALL_BOUNCE) * normalVelocity * nx;
      ball.vy -= (1 + WALL_BOUNCE) * normalVelocity * ny;
    }
  }
  return null;
}

function startKickoff(state: SimState, scorer: 0 | 1) {
  state.score[scorer] += 1;
  state.lastScorer = scorer;
  state.goalCount += 1;
  if (state.score[scorer] >= WIN_SCORE) {
    state.status = "finished";
    state.kickoffRemaining = 0;
    return;
  }
  state.players = [createSimPlayer(true), createSimPlayer(false)];
  const concedingIsLeft = scorer === 1;
  state.ball = {
    x: FIELD_WIDTH / 2 + (concedingIsLeft ? -KICKOFF_BALL_OFFSET : KICKOFF_BALL_OFFSET),
    y: FIELD_HEIGHT / 2,
    vx: 0,
    vy: 0,
  };
  state.kickoffRemaining = KICKOFF_FREEZE_SECONDS;
}

function stepFixed(state: SimState, inputs: [SimInput, SimInput], dt: number, report: SimStepReport) {
  state.simTime += dt;
  if (state.kickoffRemaining > 0) {
    state.kickoffRemaining = Math.max(0, state.kickoffRemaining - dt);
    return;
  }

  advanceSimPlayer(state.players[0], inputs[0], dt);
  advanceSimPlayer(state.players[1], inputs[1], dt);
  fireProjectile(state, 0, inputs[0]);
  fireProjectile(state, 1, inputs[1]);
  collidePlayers(state.players[0], state.players[1]);

  advanceProjectiles(state, dt);

  const scorer = advanceSimBall(state.ball, dt);
  if (scorer !== null) {
    startKickoff(state, scorer);
    report.goals += 1;
    return;
  }
  if (collideSimPlayerWithBall(state.ball, state.players[0])) report.kicks += 1;
  if (collideSimPlayerWithBall(state.ball, state.players[1])) report.kicks += 1;
}

/**
 * 실제로 흐른 시간만큼 경기를 진행한다. 타이머가 밀려도 경기가 느려지지 않도록
 * 호출자는 벽시계 경과 시간을 그대로 넘기고, 남은 잔여 시간을 다음 호출에 다시 넘긴다.
 *
 * 소비한 대시 입력은 `inputs`에서 직접 해제하므로 호출자는 같은 객체를 계속 재사용하면 된다.
 */
export function advanceSimulation(
  state: SimState,
  inputs: [SimInput, SimInput],
  elapsedSeconds: number,
  accumulator = 0,
): SimStepReport {
  const report: SimStepReport = { accumulator, steps: 0, kicks: 0, goals: 0 };
  if (state.status === "finished") return report;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return report;

  report.accumulator = Math.min(report.accumulator + elapsedSeconds, MAX_CATCH_UP_SECONDS);
  while (report.accumulator >= SUB_STEP_SECONDS) {
    stepFixed(state, inputs, SUB_STEP_SECONDS, report);
    report.accumulator -= SUB_STEP_SECONDS;
    report.steps += 1;
    inputs[0].dash = false;
    inputs[1].dash = false;
    inputs[0].fire = false;
    inputs[1].fire = false;
    // stepFixed가 상태를 바꾸므로 좁혀진 타입 대신 현재 값을 다시 읽는다.
    if ((state.status as SimState["status"]) === "finished") break;
  }
  return report;
}
