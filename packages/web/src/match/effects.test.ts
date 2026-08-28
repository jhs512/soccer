import { describe, expect, it } from "vitest";
import type { MatchSnapshot } from "../backend/protocol.js";
import { MatchEffects } from "./effects.js";

const player = () => ({
  x: 200,
  y: 400,
  vx: 0,
  vy: 0,
  dashCooldown: 0,
  dashTime: 0,
  abilityGauge: 0,
  face: 1,
  moveX: 0,
  moveY: 0,
});

function snapshot(t: number, projectiles: MatchSnapshot["projectiles"]): MatchSnapshot {
  return {
    players: [player(), player()],
    ball: { x: 400, y: 400, vx: 0, vy: 0 },
    projectiles,
    score: [0, 0],
    status: "playing",
    kickoffRemaining: 0,
    lastScorer: null,
    goalCount: 0,
    t,
  };
}

const shot = (x: number) => [{ owner: 0 as const, x, y: 400, vx: 960, vy: 0 }];

describe("MatchEffects", () => {
  it("공 근처에서 사라진 충격탄을 명중으로 본다", () => {
    const effects = new MatchEffects();
    effects.observe(snapshot(0, shot(370)), 0);
    effects.observe(snapshot(1 / 60, []), 1 / 60);
    expect(effects.activeImpacts).toBe(1);
  });

  it("경기장 밖에서 사라진 충격탄은 명중이 아니다", () => {
    const effects = new MatchEffects();
    // 공(400,400)에서 한참 떨어진 곳에서 소멸 — 벽에 닿아 사라진 경우다.
    effects.observe(snapshot(0, shot(790)), 0);
    effects.observe(snapshot(1 / 60, []), 1 / 60);
    expect(effects.activeImpacts).toBe(0);
  });

  it("날아가는 중에는 명중으로 세지 않는다", () => {
    const effects = new MatchEffects();
    effects.observe(snapshot(0, shot(200)), 0);
    effects.observe(snapshot(1 / 60, shot(216)), 1 / 60);
    effects.observe(snapshot(2 / 60, shot(232)), 2 / 60);
    expect(effects.activeImpacts).toBe(0);
  });

  it("연출은 시간이 지나면 사라진다", () => {
    const effects = new MatchEffects();
    effects.observe(snapshot(0, shot(370)), 0);
    effects.observe(snapshot(1 / 60, []), 1 / 60);
    expect(effects.activeImpacts).toBe(1);

    // draw가 만료된 연출을 걷어낸다. 캔버스 없이 호출할 수 있도록 최소한의 컨텍스트를 넘긴다.
    const calls: string[] = [];
    const stub = new Proxy({} as CanvasRenderingContext2D, {
      get: (_target, key) => {
        if (key === "lineWidth" || key === "strokeStyle") return 0;
        return () => calls.push(String(key));
      },
      set: () => true,
    });
    effects.draw(stub, 1);
    expect(effects.activeImpacts).toBe(0);
  });

  it("reset하면 이전 경기의 충격탄이 남지 않는다", () => {
    const effects = new MatchEffects();
    effects.observe(snapshot(0, shot(370)), 0);
    effects.reset();
    effects.observe(snapshot(1 / 60, []), 1 / 60);
    expect(effects.activeImpacts).toBe(0);
  });
});
