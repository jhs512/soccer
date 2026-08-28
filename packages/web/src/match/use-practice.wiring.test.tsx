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
