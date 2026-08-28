import { useEffect, useRef } from "react";
import { getStoredNickname } from "../backend/client.js";
import type { MatchHandle } from "./use-match.js";
import { MatchEffects } from "./effects.js";
import { MATCH_CANVAS_SIZE, renderMatch } from "./render.js";

/**
 * 경기 화면.
 *
 * 스냅샷은 React state를 거치지 않고 requestAnimationFrame 루프가 버퍼에서 직접 읽는다.
 * 60Hz 상태를 state로 올리면 모바일에서 리렌더가 프레임을 다 먹는다.
 */
export function MatchView({ match, opponent, playerIndex }: { match: MatchHandle; opponent: string; playerIndex: 0 | 1 }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const score = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;

    // 캔버스 안에서는 내 선수를 YOU로 부른다. HUD가 이미 양쪽 닉네임을 색과 함께 보여주므로
    // 원 안에 긴 닉네임을 또 넣을 이유가 없다.
    const names: [string, string] = playerIndex === 0 ? ["YOU", opponent] : [opponent, "YOU"];
    const effects = new MatchEffects();
    let lastSnapshotT = Number.NaN;
    let frame = 0;
    let previous = performance.now();

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const frameSeconds = Math.min((now - previous) / 1000, 0.1);
      previous = now;
      const nowSeconds = now / 1000;

      const snapshot = match.buffer.sample(nowSeconds);
      if (!snapshot) return;

      // 명중 판정은 스냅샷이 실제로 바뀌었을 때만 본다. 프레임마다 보면 보간된 중간값을
      // 새 스냅샷으로 오인해 같은 명중이 여러 번 터진다.
      const authoritative = match.buffer.latest;
      if (authoritative && authoritative.t !== lastSnapshotT) {
        lastSnapshotT = authoritative.t;
        effects.observe(authoritative, nowSeconds);
      }

      const predicted = match.prediction.advance(match.input.current, frameSeconds);
      // 예측한 내 몸이 표시되는 공에 닿으면 서버 판정을 기다리지 않고 그 자리에서 찬다.
      if (predicted) match.kick.tryKick(predicted, snapshot.ball, nowSeconds);
      const ball = match.kick.blend(snapshot.ball, frameSeconds, nowSeconds);

      renderMatch(element, {
        snapshot,
        effects,
        nowSeconds,
        names,
        selfIndex: playerIndex,
        ballOverride: ball,
        selfOverride: predicted
          ? {
              index: playerIndex,
              x: predicted.x,
              y: predicted.y,
              moveX: match.input.current.moveX,
              moveY: match.input.current.moveY,
              abilityGauge: predicted.abilityGauge,
            }
          : undefined,
      });

      if (score.current) score.current.textContent = `${snapshot.score[0]} : ${snapshot.score[1]}`;
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [match, opponent, playerIndex]);

  const me = getStoredNickname() ?? "나";

  return (
    <div className="app">
      <div className="game-shell">
        <div className="hud">
          <span className="identity identity-human">
            <i />
            <strong>{playerIndex === 0 ? me : opponent}</strong>
          </span>
          <span className="scoreboard">
            <span ref={score}>0 : 0</span>
            <small>3점 선승</small>
          </span>
          <span className="identity identity-ai">
            <strong>{playerIndex === 0 ? opponent : me}</strong>
            <i />
          </span>
        </div>
        <canvas ref={canvas} width={MATCH_CANVAS_SIZE} height={MATCH_CANVAS_SIZE} />
      </div>

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

      <button className="leave-match-button" type="button" onClick={match.leave}>
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
              match.input.current.fire = true;
            }}
          >
            FIRE
          </button>
          <button
            className="action-button"
            type="button"
            onPointerDown={() => {
              match.input.current.dash = true;
            }}
          >
            DASH
          </button>
        </div>
      </div>
    </div>
  );
}
