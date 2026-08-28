// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { PracticeView } from "./practice-view.js";
import { usePractice, type PracticeHandle } from "./use-practice.js";

/**
 * 종료 배선 테스트.
 *
 * `practiceResultOf`가 옳은 것과, 그 결과가 **실제로 화면까지 도달하는 것**은 다른 문제다.
 * 승부가 갈린 뒤 시뮬레이션이 멈추므로 이 연결이 끊기면 정지한 경기장만 남는다 — 실제로
 * 그 버그가 있었다. 애니메이션 프레임 루프를 거쳐 패널이 뜨는 것까지 확인한다.
 */

let handle: PracticeHandle | null = null;

function Harness({ onReady }: { onReady: () => void }) {
  const practice = usePractice(null);
  handle = practice;
  useEffect(() => {
    onReady();
  }, [onReady]);
  return practice.active ? <PracticeView practice={practice} queueLabel={null} onLeave={() => {}} /> : null;
}

/** jsdom의 rAF는 타이머로 돈다. 몇 프레임 지나가게 둔다. */
const frames = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 80))));

describe("AI 연습 종료 배선", () => {
  it("승부가 갈리면 결과 패널이 뜬다", async () => {
    handle = null;
    const screen = render(<Harness onReady={() => {}} />);

    await act(async () => void handle!.start());
    await frames();
    expect(screen.container.querySelector(".game-shell canvas")).not.toBeNull();
    expect(screen.container.querySelector(".result-panel")).toBeNull();

    // 봇이 3점을 넣은 상태를 만든다. 이 시점부터 advanceSimulation은 더 진행하지 않는다.
    const state = handle!.state.current!;
    state.score = [1, 3];
    state.status = "finished";

    await frames();

    const panel = screen.container.querySelector(".result-panel");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("패배");
    expect(panel!.textContent).toContain("1 : 3");
    expect(panel!.textContent).toContain("다시하기");
  });

  it("시뮬레이션이 스스로 승부를 낼 때도 패널이 뜬다", async () => {
    // 앞 테스트는 status를 밖에서 강제한다. 실제로는 루프 안의 advanceSimulation이 끝을 낸다 —
    // 그 경로로도 결과가 화면까지 도달하는지 확인한다.
    handle = null;
    const screen = render(<Harness onReady={() => {}} />);
    await act(async () => void handle!.start());
    await frames();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const state = handle!.state.current;
      if (!state || state.status === "finished") break;
      // 봇 골문 반대쪽(왼쪽)으로 공을 밀어 넣어 봇이 득점하게 한다.
      state.kickoffRemaining = 0;
      state.ball = { x: 18, y: 400, vx: -900, vy: 0 };
      await frames();
    }

    expect(handle!.state.current!.status).toBe("finished");
    const panel = screen.container.querySelector(".result-panel");
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("패배");
  });

  it("다시하기로 시작한 두 번째 경기가 끝나도 패널이 다시 뜬다", async () => {
    // `다시하기`는 active가 이미 true인 채로 start()를 부르므로 루프 이펙트가 재실행되지 않는다.
    // 종료 보고를 불리언 플래그로 두면 이전 경기의 true가 남아 두 번째 경기부터 영영 안 뜬다.
    handle = null;
    const screen = render(<Harness onReady={() => {}} />);
    await act(async () => void handle!.start());
    await frames();

    const finishByOwnGoal = async () => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const state = handle!.state.current;
        if (!state || state.status === "finished") break;
        state.kickoffRemaining = 0;
        state.ball = { x: 18, y: 400, vx: -900, vy: 0 };
        await frames();
      }
    };

    await finishByOwnGoal();
    expect(screen.container.querySelector(".result-panel")).not.toBeNull();

    // 다시하기 → 두 번째 경기.
    await act(async () => void handle!.start());
    await frames();
    expect(screen.container.querySelector(".result-panel")).toBeNull();

    await finishByOwnGoal();
    expect(handle!.state.current!.status).toBe("finished");
    expect(screen.container.querySelector(".result-panel")).not.toBeNull();
  });

  it("다시하기를 누르면 패널이 사라지고 0:0으로 새 경기가 시작된다", async () => {
    handle = null;
    const screen = render(<Harness onReady={() => {}} />);

    await act(async () => void handle!.start());
    await frames();
    const state = handle!.state.current!;
    state.score = [3, 1];
    state.status = "finished";
    await frames();
    expect(screen.container.querySelector(".result-panel")!.textContent).toContain("승리");

    await act(async () => void handle!.start());
    await frames();

    expect(screen.container.querySelector(".result-panel")).toBeNull();
    expect(handle!.state.current!.score).toEqual([0, 0]);
    expect(handle!.state.current!.status).toBe("playing");
  });
});
