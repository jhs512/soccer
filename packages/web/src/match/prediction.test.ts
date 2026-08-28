import { describe, expect, it } from "vitest";
import { BALL_RADIUS, PLAYER_RADIUS } from "../../../server/src/simulation.js";
import type { MatchPlayerSnapshot } from "../backend/protocol.js";
import { KickPrediction, LocalPrediction } from "./prediction.js";

/** 접촉 거리는 밸런스 값이다. 숫자를 박아두면 반경을 조정할 때마다 테스트가 엉뚱하게 깨진다. */
const CONTACT = PLAYER_RADIUS + BALL_RADIUS;

const authoritative = (x: number, y = 400): MatchPlayerSnapshot => ({
  x,
  y,
  vx: 0,
  vy: 0,
  dashCooldown: 0,
  dashTime: 0,
  abilityGauge: 1,
  face: 1,
  moveX: 0,
  moveY: 0,
});

describe("LocalPrediction", () => {
  it("첫 스냅샷은 그대로 받는다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    expect(prediction.current).toMatchObject({ x: 200, y: 400 });
  });

  it("오차가 작으면 서버 쪽으로 15%만 당긴다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    prediction.reconcile(authoritative(220));
    // 즉시 220으로 붙으면 서버 지터가 그대로 화면에 튄다.
    expect(prediction.current!.x).toBeCloseTo(203, 5);
  });

  it("오차가 크면(순간이동·킥오프 재배치) 즉시 맞춘다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    prediction.reconcile(authoritative(600));
    expect(prediction.current!.x).toBe(600);
  });

  it("입력이 있으면 공유 물리로 앞서 나간다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    const moved = prediction.advance({ moveX: 1, moveY: 0, dash: false, fire: false }, 0.25);
    expect(moved!.x).toBeGreaterThan(200);
  });

  it("입력이 없으면 제자리다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    const moved = prediction.advance({ moveX: 0, moveY: 0, dash: false, fire: false }, 0.25);
    expect(moved!.x).toBeCloseTo(200, 6);
  });

  it("reset 뒤에는 이전 경기의 예측이 남지 않는다", () => {
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(200));
    prediction.reset();
    expect(prediction.current).toBeNull();
    expect(prediction.advance({ moveX: 1, moveY: 0, dash: false, fire: false }, 0.1)).toBeNull();
  });
});

describe("KickPrediction", () => {
  it("닿지 않으면 차지 않는다", () => {
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(100));
    const kicked = kick.tryKick(prediction.current!, { x: 100 + CONTACT * 4, y: 400, vx: 0, vy: 0 }, 0);
    expect(kicked).toBe(false);
  });

  it("닿으면 서버 판정을 기다리지 않고 그 자리에서 찬다", () => {
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(400));
    const kicked = kick.tryKick(prediction.current!, { x: 400 + CONTACT * 0.9, y: 400, vx: 0, vy: 0 }, 0);
    expect(kicked).toBe(true);
  });

  it("크로스페이드가 끝나면 서버 공만 남는다", () => {
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(400));
    kick.tryKick(prediction.current!, { x: 400 + CONTACT * 0.9, y: 400, vx: 0, vy: 0 }, 0);

    const server = { x: 500, y: 400, vx: 0, vy: 0 };
    const midway = kick.blend(server, 1 / 60, 0.1);
    expect(midway.x).not.toBe(server.x);

    const after = kick.blend(server, 1 / 60, 0.3);
    expect(after).toEqual(server);
  });

  it("접촉이 이어지는 동안 매 프레임 다시 차지 않는다", () => {
    // 이걸 안 막으면 크로스페이드가 매 프레임 0으로 리셋돼 표시 공이 출렁인다.
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(400));
    const ball = { x: 400 + CONTACT * 0.9, y: 400, vx: 0, vy: 0 };

    expect(kick.tryKick(prediction.current!, ball, 0)).toBe(true);
    expect(kick.tryKick(prediction.current!, ball, 0.01)).toBe(false);
    expect(kick.tryKick(prediction.current!, ball, 0.02)).toBe(false);
  });

  it("떨어졌다 다시 닿으면 새로 찬다", () => {
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(400));
    const near = { x: 400 + CONTACT * 0.9, y: 400, vx: 0, vy: 0 };
    const far = { x: 400 + CONTACT * 4, y: 400, vx: 0, vy: 0 };

    expect(kick.tryKick(prediction.current!, near, 0)).toBe(true);
    expect(kick.tryKick(prediction.current!, far, 0.05)).toBe(false);
    // 크로스페이드가 끝난 뒤 다시 접촉.
    kick.blend(far, 1 / 60, 0.4);
    expect(kick.tryKick(prediction.current!, near, 0.4)).toBe(true);
  });

  it("표시 공은 서버 공 쪽으로 단조롭게 다가간다", () => {
    const kick = new KickPrediction();
    const prediction = new LocalPrediction();
    prediction.reconcile(authoritative(400));
    kick.tryKick(prediction.current!, { x: 400 + CONTACT * 0.9, y: 400, vx: 0, vy: 0 }, 0);

    const server = { x: 600, y: 400, vx: 0, vy: 0 };
    let previousGap = Infinity;
    for (let step = 1; step <= 14; step += 1) {
      const displayed = kick.blend(server, 1 / 60, step / 60);
      const gap = Math.abs(server.x - displayed.x);
      // 커지는 구간이 있으면 그게 눈에는 출렁임으로 보인다.
      expect(gap).toBeLessThanOrEqual(previousGap + 1e-9);
      previousGap = gap;
    }
  });

  it("차지 않았으면 서버 공을 그대로 쓴다", () => {
    const kick = new KickPrediction();
    const server = { x: 123, y: 400, vx: 0, vy: 0 };
    expect(kick.blend(server, 1 / 60, 0)).toEqual(server);
  });
});
