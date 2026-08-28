import { useEffect, useRef } from "react";
import { getStoredNickname } from "../backend/client.js";
import { MatchEffects } from "./effects.js";
import type { MatchSnapshot } from "../backend/protocol.js";
import type { PracticeHandle } from "./use-practice.js";
import { MATCH_CANVAS_SIZE, renderMatch } from "./render.js";

/**
 * AI 연습 화면.
 *
 * 온라인 경기와 **같은 렌더러**를 쓴다. 화면이 갈라지면 연습에서 익힌 거리감이 실전에서 안 맞는다.
 * 다른 점은 보간과 예측이 없다는 것뿐이다 — 시뮬레이션이 바로 여기서 돌아 지연이 0이라
 * 메울 것이 없다.
 */
export function PracticeView({
  practice,
  queueLabel,
  onLeave,
}: {
  practice: PracticeHandle;
  queueLabel: string | null;
  onLeave: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const score = useRef<HTMLSpanElement>(null);
  const me = getStoredNickname() ?? "나";

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    const effects = new MatchEffects();
    const names: [string, string] = ["YOU", "BOT"];
    let lastGoalCount = -1;
    let frame = 0;

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const state = practice.state.current;
      if (!state) return;
      const nowSeconds = now / 1000;

      const snapshot: MatchSnapshot = {
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

      effects.observe(snapshot, nowSeconds);
      // 연습에서 나는 언제나 왼쪽(0번)이다.
      renderMatch(element, { snapshot, effects, nowSeconds, names, selfIndex: 0 });

      if (score.current && state.goalCount !== lastGoalCount) {
        lastGoalCount = state.goalCount;
      }
      if (score.current) score.current.textContent = `${state.score[0]} : ${state.score[1]}`;
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [practice]);

  return (
    <div className="app">
      <div className="game-shell">
        <div className="hud">
          <span className="identity identity-human">
            <i />
            <strong>{me}</strong>
          </span>
          <span className="scoreboard">
            <span ref={score}>0 : 0</span>
            <small>3점 선승</small>
          </span>
          <span className="identity identity-ai">
            <strong>연습 상대</strong>
            <i />
          </span>
        </div>
        <canvas ref={canvas} width={MATCH_CANVAS_SIZE} height={MATCH_CANVAS_SIZE} />

        {/*
          승부가 갈리면 시뮬레이션이 멈춘다. 이 패널이 없으면 정지한 경기장만 남아
          게임이 끊긴 것처럼 보인다.
        */}
        {practice.result && (
          <div className="panel result-panel">
            <small>{practice.result.won ? "승리" : "패배"}</small>
            <span>
              {practice.result.score[0]} : {practice.result.score[1]}
            </span>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" onClick={practice.start}>
                다시하기
              </button>
              <button type="button" onClick={onLeave}>
                로비로 나가기
              </button>
            </div>
          </div>
        )}
      </div>

      {queueLabel && <div className="random-match-tooltip">{queueLabel}</div>}

      <div className="tips">
        <span>
          <kbd>WASD</kbd> / 방향키로 이동
        </span>
        <span>
          <kbd>Space / N</kbd> 대시
        </span>
        <span>
          <kbd>B</kbd> 발사
        </span>
      </div>

      <button className="leave-match-button" type="button" onClick={onLeave}>
        로비로 나가기
      </button>

      <div className="controls">
        <div className="joystick">
          <span />
        </div>
        <div className="actions">
          <button
            className="action-button fire"
            type="button"
            onPointerDown={() => {
              practice.input.current.fire = true;
            }}
          >
            FIRE
          </button>
          <button
            className="action-button"
            type="button"
            onPointerDown={() => {
              practice.input.current.dash = true;
            }}
          >
            DASH
          </button>
        </div>
      </div>
    </div>
  );
}
