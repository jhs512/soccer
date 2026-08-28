import { describe, expect, it } from "vitest";
import { advanceSimulation, createSimInput, createSimState, type SimState } from "../../../server/src/simulation.js";
import { practiceResultOf } from "./use-practice.js";

/** 한쪽이 이길 때까지 공을 골문 안으로 밀어 넣는다. */
function forceGoals(state: SimState, scorer: 0 | 1, goals: number) {
  const idle = (): [ReturnType<typeof createSimInput>, ReturnType<typeof createSimInput>] => [
    createSimInput(),
    createSimInput(),
  ];
  let accumulator = 0;
  for (let scored = 0; scored < goals; scored += 1) {
    // 0번이 득점하려면 오른쪽(1번) 골문으로, 1번이면 왼쪽으로 보낸다.
    state.kickoffRemaining = 0;
    state.ball = scorer === 0
      ? { x: 780, y: 400, vx: 900, vy: 0 }
      : { x: 20, y: 400, vx: -900, vy: 0 };
    for (let step = 0; step < 40 && state.score[scorer] === scored; step += 1) {
      accumulator = advanceSimulation(state, idle(), 0.016, accumulator).accumulator;
    }
  }
}

describe("practiceResultOf", () => {
  it("진행 중이면 결과가 없다", () => {
    expect(practiceResultOf(createSimState())).toBeNull();
  });

  it("내가 3점을 먼저 넣으면 승리로 끝난다", () => {
    const state = createSimState();
    forceGoals(state, 0, 3);

    // advanceSimulation이 멈췄는지도 함께 확인한다 — 화면이 멈추는 근본 이유다.
    expect(state.status).toBe("finished");
    const before = { x: state.ball.x, score: [...state.score] };
    advanceSimulation(state, [createSimInput(), createSimInput()], 0.016, 0);
    expect(state.ball.x).toBe(before.x);

    expect(practiceResultOf(state)).toEqual({ score: [3, 0], won: true });
  });

  it("봇이 3점을 먼저 넣으면 패배로 끝난다", () => {
    const state = createSimState();
    forceGoals(state, 1, 3);
    expect(practiceResultOf(state)).toEqual({ score: [0, 3], won: false });
  });
});
