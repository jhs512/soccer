import {
  BALL_RADIUS,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  PLAYER_RADIUS,
  type SimInput,
  type SimState,
} from "../../../server/src/simulation.js";

/**
 * 연습 상대.
 *
 * 서버에는 봇이 없다 — AI 연습은 전적으로 클라이언트에서 돌고, 결과도 서버에 보고하지 않는다.
 * 그래서 이 파일이 서버 판정을 흉내 내는 게 아니라 **입력만 만들어** 공유 시뮬레이션에 넣는다.
 * 물리는 온라인 경기와 완전히 같은 코드를 쓰므로 연습에서 익힌 감각이 실전에서 그대로 통한다.
 *
 * 원본은 유실된 구세대 `local-game.ts`의 `botInput`이다. 경기장이 1280×800에서 800×800으로
 * 바뀌고 선수 반경이 1/3이 되었으므로 거리 상수를 반경 기준으로 다시 잡았다.
 */

/** 몇 초 뒤의 공 위치를 노릴지. 길수록 앞서 움직이고 짧을수록 공에 붙는다. */
const LEAD_SECONDS = 0.16;
/** 조준을 다시 계산하는 주기. 매 틱 바꾸면 인간이 읽을 수 없는 움직임이 된다. */
const THINK_SECONDS = 0.12;
const JITTER = 46;
/** 자기 골문에 이 정도로 붙으면 걷어내기로 전환한다. */
const OWN_GOAL_MARGIN = 90;

export class PracticeBot {
  private thinkTime = 0;
  private jitterX = 0;
  private jitterY = 0;

  constructor(private readonly random: () => number = Math.random) {}

  reset() {
    this.thinkTime = 0;
    this.jitterX = 0;
    this.jitterY = 0;
  }

  /** 봇은 오른쪽(1번) 진영을 맡는다. 왼쪽 골문을 노린다. */
  think(state: SimState, dt: number): SimInput {
    const player = state.players[1];
    const ball = state.ball;

    this.thinkTime -= dt;
    if (this.thinkTime <= 0) {
      this.thinkTime = THINK_SECONDS;
      this.jitterX = (this.random() - 0.5) * JITTER;
      this.jitterY = (this.random() - 0.5) * JITTER;
    }

    const predictedX = ball.x + ball.vx * LEAD_SECONDS;
    const predictedY = ball.y + ball.vy * LEAD_SECONDS;

    // 공 뒤로 돌아 들어가 상대 골문 쪽으로 밀어낼 수 있는 자리를 잡는다.
    const attackAngle = Math.atan2(FIELD_HEIGHT / 2 - predictedY, -predictedX);
    const behind = PLAYER_RADIUS + BALL_RADIUS * 0.9;
    let targetX = predictedX - Math.cos(attackAngle) * behind;
    let targetY = predictedY - Math.sin(attackAngle) * behind;

    // 공이 자기 진영으로 굴러오면 돌아 들어갈 여유가 없다. 앞질러 막는다.
    if (ball.vx > 40 && ball.x > FIELD_WIDTH * 0.55) {
      targetX = Math.min(ball.x + ball.vx * 0.35, FIELD_WIDTH - OWN_GOAL_MARGIN);
      targetY = ball.y + ball.vy * 0.35;
    }

    // 골라인에 몰리면 뒤로 돌아 들어가려다 자책골이 난다. 옆에서 걷어낸다.
    const cornered = targetX > FIELD_WIDTH - OWN_GOAL_MARGIN;
    if (cornered) {
      targetX = predictedX;
      targetY = predictedY + (predictedY < FIELD_HEIGHT / 2 ? 1 : -1) * (PLAYER_RADIUS + BALL_RADIUS);
    }

    targetX = clamp(targetX + this.jitterX, PLAYER_RADIUS, FIELD_WIDTH - PLAYER_RADIUS);
    targetY = clamp(targetY + this.jitterY, PLAYER_RADIUS, FIELD_HEIGHT - PLAYER_RADIUS);

    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const distance = Math.hypot(dx, dy) || 1;
    const ballDistance = Math.hypot(ball.x - player.x, ball.y - player.y);
    // 공과 골문이 같은 방향에 있을 때만 대시한다. 아니면 자책골을 향해 돌진한다.
    const aimed = ball.x < player.x;
    const dash = ballDistance < PLAYER_RADIUS + BALL_RADIUS + 34 && aimed && !cornered && this.random() < 0.35;

    return {
      moveX: distance < 6 ? 0 : dx / distance,
      moveY: distance < 6 ? 0 : dy / distance,
      dash,
      fire: false,
    };
  }
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
