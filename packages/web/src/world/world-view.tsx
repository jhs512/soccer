import { useEffect, useRef } from "react";
import {
  WORLD_CELL_SIZE,
  WORLD_SECTOR_COUNT,
  type WorldMinimap,
  type WorldPlayerView,
  type WorldState,
} from "../backend/protocol.js";
import { GHOST_OPACITIES, GHOST_SPACING_RATIO } from "../effects/dash.js";
import { SmoothCamera } from "./camera.js";
import { Minimap } from "./minimap.js";
import { BACKDROP_HEIGHT, BACKDROP_WIDTH, VIEW_SPAN_X, VIEW_SPAN_Y } from "./view-space.js";
import { drawBackdrop } from "./world-backdrop.js";

/** 월드 좌표를 레이어 안에서의 퍼센트로. 카메라는 레이어 전체를 옮기는 쪽이 맡는다. */
const layerLeft = (worldX: number) => `${(worldX / VIEW_SPAN_X) * 100}%`;
const layerTop = (worldY: number) => `${(worldY / VIEW_SPAN_Y) * 100}%`;

function pingClass(pingMs: number | null) {
  if (pingMs === null) return "ping-unknown";
  if (pingMs < 40) return "ping-great";
  if (pingMs < 90) return "ping-good";
  if (pingMs < 160) return "ping-fair";
  return "ping-poor";
}

const SECTORS = Array.from({ length: WORLD_SECTOR_COUNT * WORLD_SECTOR_COUNT }, (_, index) => {
  const column = index % WORLD_SECTOR_COUNT;
  const row = Math.floor(index / WORLD_SECTOR_COUNT);
  return {
    label: `${String.fromCharCode(65 + column)}${row + 1}`,
    x: (column + 0.5) * WORLD_CELL_SIZE,
    y: (row + 0.5) * WORLD_CELL_SIZE,
  };
});

/** 섹터 라벨은 월드에 못 박혀 있어 카메라와 무관하다. 한 번 만들어 재사용한다. */
const SECTOR_LABELS = (
  <div className="world-sectors">
    {SECTORS.map((sector) => (
      <span key={sector.label} style={{ left: layerLeft(sector.x), top: layerTop(sector.y) }}>
        {sector.label}
      </span>
    ))}
  </div>
);

/** 잔상 개수는 공용 정의를 따른다 — 경기 화면과 개수가 갈리면 같은 대시가 다르게 보인다. */
const TRAIL_STEPS = GHOST_OPACITIES.map((_, index) => index + 1);

/**
 * 대시 잔상과 속도선의 위치를 CSS 변수로 넘긴다.
 * `.dash-ghost:nth-of-type(n)`이 `--trail-x-n`을, `.dash-speed-field`가 `--dash-angle`을 쓴다.
 */
function dashVariables(player: WorldPlayerView) {
  const style: Record<string, string> = {};
  const magnitude = Math.hypot(player.moveX, player.moveY);
  // 아바타 반지름(약 10px)에 공용 비율을 적용한다. 경기 화면의 잔상 간격과 같은 규칙이다.
  const AVATAR_RADIUS = 10;
  const scale = player.dashActive && magnitude > 0 ? (AVATAR_RADIUS * GHOST_SPACING_RATIO) / magnitude : 0;
  for (const step of TRAIL_STEPS) {
    style[`--trail-x-${step}`] = `${-player.moveX * scale * step}px`;
    style[`--trail-y-${step}`] = `${-player.moveY * scale * step}px`;
  }
  style["--dash-angle"] = `${magnitude > 0 ? (Math.atan2(player.moveY, player.moveX) * 180) / Math.PI : 0}deg`;
  return style;
}

function Avatar({
  player,
  self,
  onClick,
}: {
  player: WorldPlayerView;
  self: boolean;
  onClick?: () => void;
}) {
  const classes = ["world-avatar"];
  if (self) classes.push("is-self");
  if (player.dashActive) classes.push("is-dashing");
  if (player.activity) classes.push("is-playing");
  return (
    <div
      className={classes.join(" ")}
      style={{
        // 카메라가 곧 자신이므로 내 아바타는 언제나 화면 정중앙이다. 레이어 밖에 두어
        // 카메라 스무딩이 내 아바타를 흔들지 않게 한다.
        left: self ? "50%" : layerLeft(player.x),
        top: self ? "50%" : layerTop(player.y),
        // 남의 아바타는 서버 틱(50ms)마다 위치가 바뀐다. 그 사이를 CSS가 메운다.
        transition: self ? undefined : "left 50ms linear, top 50ms linear",
        ...dashVariables(player),
      }}
      onClick={onClick}
    >
      {/* 연출은 몸 안에 넣는다 — 크기가 아바타 박스가 아니라 몸 기준이 되어야 캔버스와 같아진다. */}
      <span className="world-cell-wrap">
        {player.dashActive && (
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
        )}
        <span className="world-cell" />
      </span>
      <b>{player.nickname}</b>
      <small className={pingClass(player.pingMs)}>
        {player.pingMs === null ? "-- ms" : `${Math.round(player.pingMs)} ms`}
      </small>
      {player.activity && (
        <span className="world-game-status">
          {player.activity.kind === "ai" ? "AI 연습 중" : `vs ${player.activity.opponent}`}
        </span>
      )}
    </div>
  );
}

type WorldViewProps = {
  world: WorldState;
  /** 항상 최신 스냅샷. 카메라 루프가 React 렌더를 기다리지 않고 여기서 읽는다. */
  latest: React.RefObject<WorldState | null>;
  minimap: WorldMinimap | null;
  onChallenge: (target: WorldPlayerView) => void;
  onSpectate: (target: WorldPlayerView) => void;
};

export function WorldView({ world, latest, minimap, onChallenge, onSpectate }: WorldViewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const context = canvas.current?.getContext("2d");
    const element = layer.current;
    if (!context || !element) return;

    const camera = new SmoothCamera();
    let frame = 0;
    let previous = performance.now();

    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const frameSeconds = Math.min((now - previous) / 1000, 0.1);
      previous = now;

      const target = latest.current?.camera;
      if (!target) return;
      const smoothed = camera.follow(target, frameSeconds);

      drawBackdrop(context, smoothed);
      // 레이어 하나만 옮기면 그 안의 섹터 100개와 아바타가 전부 따라온다.
      element.style.transform = `translate(${50 - (smoothed.x / VIEW_SPAN_X) * 100}%, ${
        50 - (smoothed.y / VIEW_SPAN_Y) * 100
      }%)`;
    };

    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [latest]);

  const self = world.players.find((player) => player.id === world.selfId);

  return (
    <>
      <canvas className="world-canvas" ref={canvas} width={BACKDROP_WIDTH} height={BACKDROP_HEIGHT} />

      <div ref={layer} style={{ position: "absolute", inset: 0, willChange: "transform" }}>
        {SECTOR_LABELS}
        {world.players
          .filter((player) => player.id !== world.selfId)
          .map((player) => (
            <Avatar
              key={player.id}
              player={player}
              self={false}
              onClick={() => (player.activity ? onSpectate(player) : onChallenge(player))}
            />
          ))}
      </div>

      {self && <Avatar player={self} self />}

      <Minimap minimap={minimap} selfId={world.selfId} />
    </>
  );
}
