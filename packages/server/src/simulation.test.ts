import { describe, expect, it } from "vitest";
import {
  FIELD_WIDTH,
  KICKOFF_FREEZE_SECONDS,
  advanceSimulation,
  advanceSimBall,
  createSimInput,
  createSimState,
  type SimInput,
} from "./simulation.js";

const idle = (): [SimInput, SimInput] => [createSimInput(), createSimInput()];

function run(state: ReturnType<typeof createSimState>, inputs: [SimInput, SimInput], seconds: number) {
  let accumulator = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.016) {
    accumulator = advanceSimulation(state, inputs, 0.016, accumulator).accumulator;
  }
}

describe("공유 권위 시뮬레이션", () => {
  it("공의 최대 속도는 기존 575px/s보다 10% 빠른 632.5px/s다", () => {
    const ball = { x: 400, y: 400, vx: 1000, vy: 0 };

    advanceSimBall(ball, 1 / 120);

    expect(ball.vx).toBeCloseTo(632.5, 5);
  });

  it("느리게 굴러가는 공도 골라인을 넘으면 득점으로 확정한다", () => {
    // 회귀: 이전 서버 물리는 골문 안에서도 x=15에서 공을 튕겨내
    // 한 틱에 골라인을 통과할 만큼 빠른 슛만 득점되었다.
    const state = createSimState();
    state.ball = { x: 40, y: 400, vx: -120, vy: 0 };
    run(state, idle(), 3);

    expect(state.score).toEqual([0, 1]);
    expect(state.lastScorer).toBe(1);
    expect(state.goalCount).toBe(1);
  });

  it("득점 뒤 실점한 쪽에 킥오프 우위를 주고 준비 시간 동안 이동을 동결한다", () => {
    const state = createSimState();
    state.ball = { x: 30, y: 400, vx: -400, vy: 0 };
    const inputs = idle();
    run(state, inputs, 0.5);
    expect(state.score).toEqual([0, 1]);
    // 실점한 왼쪽 플레이어에게 공을 조금 더 가깝게 둔다.
    expect(state.ball.x).toBeLessThan(FIELD_WIDTH / 2);
    expect(state.kickoffRemaining).toBeGreaterThan(0);

    // 준비 시간 동안에는 이동 입력을 받아도 제자리를 유지한다.
    inputs[0].moveX = 1;
    const frozenX = state.players[0].x;
    run(state, inputs, KICKOFF_FREEZE_SECONDS * 0.5);
    expect(state.players[0].x).toBe(frozenX);

    // 준비가 끝나면 즉시 이동한다.
    run(state, inputs, KICKOFF_FREEZE_SECONDS);
    expect(state.players[0].x).toBeGreaterThan(frozenX);
  });

  it("한 플레이어가 3번째 골을 넣으면 즉시 경기를 끝낸다", () => {
    const state = createSimState();
    state.score = [2, 0];
    state.ball = { x: 805, y: 400, vx: 500, vy: 0 };

    run(state, idle(), 0.1);

    expect(state.score).toEqual([3, 0]);
    expect(state.status).toBe("finished");
  });

  it("구석으로 찬 공은 45° 모서리 면에 맞아 경기장 안쪽으로 되튀어 나온다", () => {
    // 회귀: 90° 포켓에서는 어떤 킥도 공을 더 깊이 박아 넣어 꺼낼 수 없었다.
    const state = createSimState();
    state.ball = { x: 90, y: 90, vx: -300, vy: -300 };
    run(state, idle(), 2);

    // 모서리 면(x+y=60)+공 반지름 밖에서 정지해야 한다.
    expect(state.ball.x + state.ball.y).toBeGreaterThanOrEqual(80);
    expect(Number.isFinite(state.ball.x)).toBe(true);
  });

  it("공용 행동 게이지가 찼을 때 대시는 게이지를 모두 쓰고 280px/s보다 빠르게 돌진한다", () => {
    const state = createSimState();
    expect(state.players[0].abilityGauge).toBe(1);
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: true, fire: false };

    run(state, inputs, 1 / 120);

    expect(state.players[0].abilityGauge).toBe(0);
    expect(Math.hypot(state.players[0].vx, state.players[0].vy)).toBeGreaterThan(280);
    expect(state.players[0]).not.toHaveProperty("justDashTime");
  });

  it("대시는 0.36초 지속되고 공용 게이지는 0.9초에 다시 충전된다", () => {
    const state = createSimState();
    const startX = state.players[0].x;
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: true, fire: false };

    run(state, inputs, 1 / 120);
    expect(state.players[0].dashTime).toBeGreaterThan(0.35);
    run(state, inputs, 0.35);
    expect(state.players[0].x - startX).toBeGreaterThan(100);
    run(state, inputs, 0.9);
    expect(state.players[0].abilityGauge).toBe(1);
  });

  it("충격탄은 같은 공용 게이지를 쓰고 선수를 통과해 공에만 충격을 준다", () => {
    const state = createSimState();
    state.players[0].x = 200;
    state.players[0].y = 400;
    state.players[1].x = 260;
    state.players[1].y = 400;
    state.ball = { x: 310, y: 400, vx: 0, vy: 0 };
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: false, fire: true };

    run(state, inputs, 0.12);

    expect(state.players[0].abilityGauge).toBeLessThan(0.3);
    expect(state.players[1].vx).toBe(0);
    expect(state.ball.vx).toBeGreaterThan(550);
  });

  it("충격탄이 공 중심의 위·아래를 맞힌 각도에 따라 반대 세로 방향으로 튕긴다", () => {
    const shootOffset = (ballY: number) => {
      const state = createSimState();
      state.players[0].x = 200;
      state.players[0].y = 400;
      state.players[1].x = 600;
      state.players[1].y = 700;
      state.ball = { x: 310, y: ballY, vx: 0, vy: 0 };
      const inputs = idle();
      inputs[0] = { moveX: 1, moveY: 0, dash: false, fire: true };
      run(state, inputs, 0.12);
      return state.ball;
    };

    const hitUpperHalf = shootOffset(415);
    const hitLowerHalf = shootOffset(385);
    expect(hitUpperHalf.vy).toBeGreaterThan(150);
    expect(hitLowerHalf.vy).toBeLessThan(-150);
  });

  it("충격탄은 당구처럼 맞은 각도의 법선 성분만큼만 힘을 전달한다", () => {
    // 같은 속도로 쏘되 중심선에서 얼마나 빗나갔는지만 다르게 한다.
    const shootWithOffset = (offset: number) => {
      const state = createSimState();
      state.kickoffRemaining = 0;
      state.players[0].y = 700;
      state.players[1].y = 700;
      state.ball = { x: 400, y: 400 + offset, vx: 0, vy: 0 };
      state.projectiles = [{ owner: 0, x: 360, y: 400, vx: 960, vy: 0 }];
      // 충돌 구간을 확실히 지나도록 충분히 돌린다. 한 프레임만 돌리면 빗나간 쪽은 아직 닿지도 않는다.
      run(state, idle(), 0.1);
      return Math.hypot(state.ball.vx, state.ball.vy);
    };

    const headOn = shootWithOffset(0);
    const glancing = shootWithOffset(26);

    // 스치듯 맞으면 확연히 약해야 한다. 예전 공식(0.75 + incidence*0.25)에서는
    // 이 비율이 0.86까지 올라가 각도가 사실상 의미가 없었다.
    expect(glancing).toBeGreaterThan(0);
    expect(glancing / headOn).toBeLessThan(0.6);
  });

  it("이미 충격탄보다 빠르게 달아나는 공에는 힘이 더 실리지 않는다", () => {
    const state = createSimState();
    state.kickoffRemaining = 0;
    state.players[0].y = 700;
    state.players[1].y = 700;
    // 공이 충격탄과 같은 방향으로 더 빠르게 굴러가는 중이면 따라잡지 못한 것이다.
    state.ball = { x: 400, y: 400, vx: 960, vy: 0 };
    state.projectiles = [{ owner: 0, x: 371, y: 400, vx: 960, vy: 0 }];

    run(state, idle(), 1 / 120);

    expect(state.ball.vx).toBeLessThanOrEqual(960);
  });

  it("빠른 충격탄이 한 틱 사이 공 중심을 지나쳐도 발사 반대쪽으로 튕기지 않는다", () => {
    const state = createSimState();
    state.kickoffRemaining = 0;
    state.players[0].y = 700;
    state.players[1].y = 700;
    state.ball = { x: 400, y: 400, vx: 0, vy: 0 };
    state.projectiles = [{ owner: 0, x: 394, y: 400, vx: 960, vy: 0 }];

    run(state, idle(), 1 / 120);

    expect(state.ball.vx).toBeGreaterThan(500);
    expect(Math.abs(state.ball.vy)).toBeLessThan(1);
  });

  it("두 배로 넓어진 충격탄은 중심선에서 26px 빗나가도 공과 충돌한다", () => {
    const state = createSimState();
    state.kickoffRemaining = 0;
    state.players[0].x = 200;
    state.players[0].y = 400;
    state.players[1].y = 700;
    state.ball = { x: 310, y: 426, vx: 0, vy: 0 };
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: false, fire: true };

    run(state, inputs, 0.12);

    expect(Math.hypot(state.ball.vx, state.ball.vy)).toBeGreaterThan(100);
  });

  it("충격탄은 960px/s로 발사된다", () => {
    const state = createSimState();
    state.players[0].x = 200;
    state.players[0].y = 100;
    state.ball = { x: 600, y: 400, vx: 0, vy: 0 };
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: false, fire: true };

    run(state, inputs, 0.3);

    expect(state.projectiles[0]!.vx).toBe(960);
    expect(state.projectiles[0]!.x).toBeGreaterThan(510);
  });

  it("충격탄은 시간으로 사라지지 않고 경기장 끝까지 진행한다", () => {
    const state = createSimState();
    state.players[0].x = 200;
    state.players[0].y = 100;
    state.ball = { x: 600, y: 400, vx: 0, vy: 0 };
    const inputs = idle();
    inputs[0] = { moveX: 1, moveY: 0, dash: false, fire: true };

    run(state, inputs, 0.3);
    expect(state.projectiles).toHaveLength(1);
    expect(state.projectiles[0]!.x).toBeGreaterThan(500);

    run(state, inputs, 0.4);
    expect(state.projectiles).toHaveLength(0);
  });

  it("150초가 지나도 3골 승자가 없으면 경기를 계속한다", () => {
    const state = createSimState();
    run(state, idle(), 151);
    expect(state.status).toBe("playing");
  });
});
