import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { PLAYER_RADIUS } from "../../server/src/simulation.js";
import { applyDashBody, drawDashEffect, GHOST_OPACITIES, GHOST_SPACING_RATIO } from "./effects/dash.js";
import "./styles/live.css";
import "./styles/overrides.css";

/**
 * 대시 연출 대조 하네스 (개발 전용).
 *
 * 월드는 DOM+CSS로, 경기는 캔버스로 그리기 때문에 "같아 보이는지"를 코드만 읽어서는 확인할 수
 * 없다. 같은 조건(오른쪽으로 대시 중)을 양쪽에 걸어 나란히 그린다.
 *
 * 캔버스는 requestAnimationFrame이 아니라 **동기로 한 프레임** 그린다. 숨겨진 탭에서는 rAF가
 * 아예 돌지 않아 화면 확인이 불가능하기 때문이다.
 */

const CANVAS_SIZE = 260;
const TRAIL_STEPS = GHOST_OPACITIES.map((_, index) => index + 1);
/** 월드 아바타의 실제 반지름(overrides.css의 clamp 중간값). */
const AVATAR_RADIUS = 10;

function worldDashVariables(moveX: number, moveY: number) {
  const style: Record<string, string> = {};
  const magnitude = Math.hypot(moveX, moveY) || 1;
  const scale = (AVATAR_RADIUS * GHOST_SPACING_RATIO) / magnitude;
  for (const step of TRAIL_STEPS) {
    style[`--trail-x-${step}`] = `${-moveX * scale * step}px`;
    style[`--trail-y-${step}`] = `${-moveY * scale * step}px`;
  }
  style["--dash-angle"] = `${(Math.atan2(moveY, moveX) * 180) / Math.PI}deg`;
  return style;
}

function CanvasDash({ self, phaseSeconds }: { self: boolean; phaseSeconds: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    if (!context) return;
    context.fillStyle = "#06140f";
    context.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    const player = {
      x: CANVAS_SIZE / 2,
      y: CANVAS_SIZE / 2,
      vx: 400,
      vy: 0,
      dashTime: 0.3,
      moveX: 1,
      moveY: 0,
      abilityGauge: 0,
    };

    drawDashEffect(context, player, PLAYER_RADIUS, self, phaseSeconds);

    applyDashBody(context, player);
    context.beginPath();
    context.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
    context.fillStyle = self ? "#3a96e6" : "#c0394b";
    context.fill();
    context.lineWidth = 3;
    context.strokeStyle = self ? "#dbeafe" : "#fee2e2";
    context.stroke();
    context.restore();
  }, [self, phaseSeconds]);

  return <canvas ref={canvas} width={CANVAS_SIZE} height={CANVAS_SIZE} style={{ display: "block" }} />;
}

function WorldDash({ self }: { self: boolean }) {
  return (
    <div
      style={{
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
        background: "#06140f",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <div
        className={`world-avatar is-dashing${self ? " is-self" : ""}`}
        style={{ left: "50%", top: "50%", ...worldDashVariables(1, 0) }}
      >
        <span className="world-cell-wrap">
          <span className="dash-fx">
            {TRAIL_STEPS.map((step) => (
              <span key={step} className="dash-ghost" />
            ))}
            <span className="dash-wave" />
            <span className="dash-wave" />
            <span className="dash-speed-field">
              <span className="dash-speed-line" />
              <span className="dash-speed-line" />
              <span className="dash-speed-line" />
              <span className="dash-speed-line" />
            </span>
          </span>
          <span className="world-cell" />
        </span>
      </div>
    </div>
  );
}

function Preview() {
  return (
    <div style={{ padding: 20, fontFamily: "system-ui", color: "#eef6f3" }}>
      <p style={{ marginBottom: 12, fontSize: 13 }}>
        오른쪽으로 대시 중. 위 = 월드(DOM+CSS), 아래 = 경기(캔버스). 왼쪽 = 자신, 오른쪽 = 상대.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: `${CANVAS_SIZE}px ${CANVAS_SIZE}px`, gap: 16 }}>
        <WorldDash self />
        <WorldDash self={false} />
        <CanvasDash self phaseSeconds={0.1} />
        <CanvasDash self={false} phaseSeconds={0.1} />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Preview />);
