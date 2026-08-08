/**
 * 권위 서버의 경기 시뮬레이션.
 *
 * 웹 클라이언트도 이 모듈을 그대로 불러와 온라인 표시 보정의 예측에 사용한다.
 * 물리가 한 곳에만 있어야 예측과 판정이 어긋나지 않으므로 Node 전용 API는 쓰지 않는다.
 */
export const FIELD_WIDTH = 1280;
export const FIELD_HEIGHT = 800;
export const GOAL_TOP = 275;
export const GOAL_BOTTOM = 525;
export const PLAYER_RADIUS = 28;
export const BALL_RADIUS = 15;
export const POST_RADIUS = 9;
export const MATCH_SECONDS = 150;
export const KICKOFF_FREEZE_SECONDS = 0.9;
/** 서버와 클라이언트가 동일한 궤적을 그리려면 같은 크기로 적분해야 한다. */
export const SUB_STEP_SECONDS = 1 / 120;
/** 한 번의 호출이 따라잡을 수 있는 최대 경기 시간. 스톨 뒤 폭주를 막는다. */
export const MAX_CATCH_UP_SECONDS = 0.25;
// 2026-08-08: 온라인 반응 여유를 위해 공은 절반, 플레이어는 추가로 1/3
// (원본 420 대비 1/6). 가속·대시는 비례 유지해 반응 곡선의 느낌은 같다.
const PLAYER_ACCELERATION = 433;
const PLAYER_MAX_SPEED = 70;
const PLAYER_DASH_MAX_SPEED = PLAYER_MAX_SPEED * 2.4;
const PLAYER_DRAG = 5.2;
const MOVE_RESPONSE_SECONDS = 0.09;
const PLAYER_BOUNCE = 0.42;
const PLAYER_WALL_BOUNCE = 0.3;
const DASH_IMPULSE = 117;
const DASH_TIME = 0.18;
const DASH_COOLDOWN = 1.5;
// 온라인 친화 튜닝: 지연 오차는 공 속도에 비례한다(오차 = 속도 × 표시 지연).
// 드리블(일반 킥 ~530px/s)은 그대로 두고 대포알 슛과 핀볼 난반사만 줄여
// 양쪽 화면의 경합 판정이 일치하고 슛에 반응할 시간이 생기게 한다.
const BALL_DRAG = 1.05;
const BALL_MAX_SPEED = 575;
const BALL_BOUNCE = 0.55;
const WALL_BOUNCE = 0.62;
const PLAYER_MASS = 5;
const BALL_MASS = 1;
const KICK_PUSH = 85;
const KICK_DASH_BOOST = 1.7;
const KICKOFF_BALL_OFFSET = 40;
/** 모서리 45° 면의 크기. 각 벽을 따라 이만큼 안쪽에서 대각선으로 깎는다. */
const CORNER_BEVEL = 60;
export const createSimInput = () => ({ moveX: 0, moveY: 0, dash: false });
export const createSimPlayer = (left) => ({
    x: left ? FIELD_WIDTH * 0.25 : FIELD_WIDTH * 0.75,
    y: FIELD_HEIGHT / 2,
    vx: 0,
    vy: 0,
    dashCooldown: 0,
    dashTime: 0,
    face: left ? 1 : -1,
    moveX: 0,
    moveY: 0,
});
export const createSimState = () => ({
    players: [createSimPlayer(true), createSimPlayer(false)],
    ball: { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: 0, vy: 0 },
    score: [0, 0],
    remainingSeconds: MATCH_SECONDS,
    status: "playing",
    kickoffRemaining: 0,
    lastScorer: null,
    goalCount: 0,
    simTime: 0,
});
export function cloneSimState(state) {
    return {
        players: [{ ...state.players[0] }, { ...state.players[1] }],
        ball: { ...state.ball },
        score: [state.score[0], state.score[1]],
        remainingSeconds: state.remainingSeconds,
        status: state.status,
        kickoffRemaining: state.kickoffRemaining ?? 0,
        lastScorer: state.lastScorer ?? null,
        goalCount: state.goalCount ?? 0,
        simTime: state.simTime ?? 0,
    };
}
/**
 * 한 선수를 한 스텝 진행한다. 클라이언트 예측도 이 함수를 그대로 사용해
 * 서버 판정과 같은 궤적을 그린다.
 */
export function advanceSimPlayer(player, input, dt) {
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
        if (directionX)
            player.face = directionX > 0 ? 1 : -1;
    }
    player.dashCooldown = Math.max(0, player.dashCooldown - dt);
    player.dashTime = Math.max(0, player.dashTime - dt);
    if (input.dash && player.dashCooldown <= 0) {
        let dashX = directionX;
        let dashY = directionY;
        if (!dashX && !dashY) {
            const speed = Math.hypot(player.vx, player.vy);
            if (speed > 20) {
                dashX = player.vx / speed;
                dashY = player.vy / speed;
            }
            else {
                dashX = player.face;
            }
        }
        player.vx += dashX * DASH_IMPULSE;
        player.vy += dashY * DASH_IMPULSE;
        player.dashCooldown = DASH_COOLDOWN;
        player.dashTime = DASH_TIME;
    }
    const drag = 1 / (1 + PLAYER_DRAG * dt);
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
    if (player.x < PLAYER_RADIUS) {
        player.x = PLAYER_RADIUS;
        player.vx = Math.abs(player.vx) * PLAYER_WALL_BOUNCE;
    }
    if (player.x > FIELD_WIDTH - PLAYER_RADIUS) {
        player.x = FIELD_WIDTH - PLAYER_RADIUS;
        player.vx = -Math.abs(player.vx) * PLAYER_WALL_BOUNCE;
    }
    if (player.y < PLAYER_RADIUS) {
        player.y = PLAYER_RADIUS;
        player.vy = Math.abs(player.vy) * PLAYER_WALL_BOUNCE;
    }
    if (player.y > FIELD_HEIGHT - PLAYER_RADIUS) {
        player.y = FIELD_HEIGHT - PLAYER_RADIUS;
        player.vy = -Math.abs(player.vy) * PLAYER_WALL_BOUNCE;
    }
}
function collidePlayers(first, second) {
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const distance = Math.hypot(dx, dy);
    const minimum = PLAYER_RADIUS * 2;
    if (distance >= minimum || distance < 0.0001)
        return;
    const nx = dx / distance;
    const ny = dy / distance;
    const overlap = (minimum - distance) / 2;
    first.x -= nx * overlap;
    first.y -= ny * overlap;
    second.x += nx * overlap;
    second.y += ny * overlap;
    const normalVelocity = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
    if (normalVelocity > 0)
        return;
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
export function collideSimPlayerWithBall(ball, player) {
    const dx = ball.x - player.x;
    const dy = ball.y - player.y;
    const distance = Math.hypot(dx, dy);
    const minimum = PLAYER_RADIUS + BALL_RADIUS;
    if (distance >= minimum || distance < 0.0001)
        return false;
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
function collidePost(ball, x, y) {
    const dx = ball.x - x;
    const dy = ball.y - y;
    const distance = Math.hypot(dx, dy);
    const minimum = BALL_RADIUS + POST_RADIUS;
    if (distance >= minimum || distance < 0.0001)
        return;
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
export function advanceSimBall(ball, dt) {
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
    if (ball.y < BALL_RADIUS) {
        ball.y = BALL_RADIUS;
        ball.vy = -ball.vy * WALL_BOUNCE;
    }
    if (ball.y > FIELD_HEIGHT - BALL_RADIUS) {
        ball.y = FIELD_HEIGHT - BALL_RADIUS;
        ball.vy = -ball.vy * WALL_BOUNCE;
    }
    // 골문 높이 안에서는 옆선을 벽으로 막지 않는다. 막으면 골라인 앞에서 튕겨
    // 나가 득점이 확정되지 않는다.
    const inGoalMouth = ball.y > GOAL_TOP && ball.y < GOAL_BOTTOM;
    if (!inGoalMouth) {
        if (ball.x < BALL_RADIUS) {
            ball.x = BALL_RADIUS;
            ball.vx = -ball.vx * WALL_BOUNCE;
        }
        if (ball.x > FIELD_WIDTH - BALL_RADIUS) {
            ball.x = FIELD_WIDTH - BALL_RADIUS;
            ball.vx = -ball.vx * WALL_BOUNCE;
        }
    }
    else {
        if (ball.x < -BALL_RADIUS * 0.5)
            return 1;
        if (ball.x > FIELD_WIDTH + BALL_RADIUS * 0.5)
            return 0;
    }
    for (const postX of [0, FIELD_WIDTH]) {
        collidePost(ball, postX, GOAL_TOP);
        collidePost(ball, postX, GOAL_BOTTOM);
    }
    // 구석 포켓 방지: 네 모서리를 45° 면으로 깎는다. 90° 포켓은 공을 가두지만
    // 45° 면의 법선은 경기장 안쪽을 향해 공이 항상 필드로 되튀어 나온다.
    for (const [cornerX, cornerY] of [[0, 0], [FIELD_WIDTH, 0], [0, FIELD_HEIGHT], [FIELD_WIDTH, FIELD_HEIGHT]]) {
        const signX = cornerX === 0 ? 1 : -1;
        const signY = cornerY === 0 ? 1 : -1;
        const along = (ball.x - cornerX) * signX + (ball.y - cornerY) * signY;
        const penetration = BALL_RADIUS - (along - CORNER_BEVEL) * Math.SQRT1_2;
        if (penetration <= 0)
            continue;
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
function startKickoff(state, scorer) {
    state.score[scorer] += 1;
    state.lastScorer = scorer;
    state.goalCount += 1;
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
function stepFixed(state, inputs, dt, report) {
    state.simTime += dt;
    state.remainingSeconds = Math.max(0, state.remainingSeconds - dt);
    if (state.remainingSeconds === 0) {
        state.status = "finished";
        return;
    }
    if (state.kickoffRemaining > 0) {
        state.kickoffRemaining = Math.max(0, state.kickoffRemaining - dt);
        return;
    }
    advanceSimPlayer(state.players[0], inputs[0], dt);
    advanceSimPlayer(state.players[1], inputs[1], dt);
    collidePlayers(state.players[0], state.players[1]);
    const scorer = advanceSimBall(state.ball, dt);
    if (scorer !== null) {
        startKickoff(state, scorer);
        report.goals += 1;
        return;
    }
    if (collideSimPlayerWithBall(state.ball, state.players[0]))
        report.kicks += 1;
    if (collideSimPlayerWithBall(state.ball, state.players[1]))
        report.kicks += 1;
}
/**
 * 실제로 흐른 시간만큼 경기를 진행한다. 타이머가 밀려도 경기가 느려지지 않도록
 * 호출자는 벽시계 경과 시간을 그대로 넘기고, 남은 잔여 시간을 다음 호출에 다시 넘긴다.
 *
 * 소비한 대시 입력은 `inputs`에서 직접 해제하므로 호출자는 같은 객체를 계속 재사용하면 된다.
 */
export function advanceSimulation(state, inputs, elapsedSeconds, accumulator = 0) {
    const report = { accumulator, steps: 0, kicks: 0, goals: 0 };
    if (state.status === "finished")
        return report;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0)
        return report;
    report.accumulator = Math.min(report.accumulator + elapsedSeconds, MAX_CATCH_UP_SECONDS);
    while (report.accumulator >= SUB_STEP_SECONDS) {
        stepFixed(state, inputs, SUB_STEP_SECONDS, report);
        report.accumulator -= SUB_STEP_SECONDS;
        report.steps += 1;
        inputs[0].dash = false;
        inputs[1].dash = false;
        // stepFixed가 상태를 바꾸므로 좁혀진 타입 대신 현재 값을 다시 읽는다.
        if (state.status === "finished")
            break;
    }
    return report;
}
