import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_CATCH_UP_SECONDS,
  advanceSimulation,
  createSimInput,
  createSimState,
  type SimState,
} from "../../../server/src/simulation.js";
import type { BackendSocket } from "../backend/client.js";
import type { MatchInput, MatchSnapshot } from "../backend/protocol.js";
import { PracticeBot } from "./bot.js";

/**
 * AI 연습 경기.
 *
 * 서버가 판정하지 않고 클라이언트가 직접 시뮬레이션을 돌린다 — 그래서 지연이 0이고, 대기열에
 * 사람이 없어도 바로 시작할 수 있다. 물리는 온라인 경기와 **완전히 같은 모듈**을 쓴다.
 *
 * 상태는 React state가 아니라 ref로 들고 있다. 120Hz로 도는 시뮬레이션을 state로 올리면
 * 리렌더가 프레임을 다 먹는다. 화면은 이 ref를 rAF 루프에서 직접 읽는다.
 */

/** 경기 중 월드에 "AI 연습 중"으로 보이게 하고, 관전자에게 화면을 중계하는 주기. */
const SPECTATOR_INTERVAL_MS = 100;

export type PracticeHandle = {
  active: boolean;
  state: React.RefObject<SimState | null>;
  input: React.RefObject<MatchInput>;
  start: () => void;
  stop: () => void;
};

function toSnapshot(state: SimState): MatchSnapshot {
  return {
    players: [{ ...state.players[0] }, { ...state.players[1] }],
    ball: { ...state.ball },
    projectiles: state.projectiles.map((projectile) => ({ ...projectile })),
    score: state.score,
    status: state.status,
    kickoffRemaining: state.kickoffRemaining,
    lastScorer: state.lastScorer,
    goalCount: state.goalCount,
    t: state.simTime,
  };
}

export function usePractice(socket: BackendSocket | null): PracticeHandle {
  const [active, setActive] = useState(false);
  const state = useRef<SimState | null>(null);
  const input = useRef<MatchInput>({ moveX: 0, moveY: 0, dash: false, fire: false });
  const bot = useRef(new PracticeBot()).current;

  const start = useCallback(() => {
    state.current = createSimState();
    bot.reset();
    input.current = { moveX: 0, moveY: 0, dash: false, fire: false };
    setActive(true);
  }, [bot]);

  const stop = useCallback(() => {
    state.current = null;
    setActive(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    let frame = 0;
    let previous = performance.now();
    let accumulator = 0;

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const current = state.current;
      if (!current) return;
      // 탭이 백그라운드였다 돌아오면 밀린 시간이 한꺼번에 들어온다. 서버와 같은 상한으로 자른다.
      const elapsed = Math.min((now - previous) / 1000, MAX_CATCH_UP_SECONDS);
      previous = now;

      const botInput = bot.think(current, elapsed);
      const report = advanceSimulation(current, [{ ...input.current }, botInput], elapsed, accumulator);
      accumulator = report.accumulator;

      // 대시·발사는 눌린 순간 한 번만 소비한다.
      input.current.dash = false;
      input.current.fire = false;
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [active, bot]);

  // 월드의 다른 사람에게 "AI 연습 중"으로 보이고, 관전 요청을 받으면 화면을 중계한다.
  useEffect(() => {
    if (!socket) return;
    if (!active) {
      socket.emit("game-presence", { mode: "idle" });
      return;
    }
    socket.emit("game-presence", { mode: "ai" });
    const timer = setInterval(() => {
      const current = state.current;
      if (current) socket.emit("ai-spectator-state", toSnapshot(current));
    }, SPECTATOR_INTERVAL_MS);
    return () => {
      clearInterval(timer);
      socket.emit("game-presence", { mode: "idle" });
    };
  }, [socket, active]);

  return { active, state, input, start, stop };
}

export const createIdleInput = createSimInput;
