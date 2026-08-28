import { memo } from "react";
import { WORLD_SECTOR_COUNT, type WorldMinimap } from "../backend/protocol.js";

/**
 * 미니맵.
 *
 * **월드 상태와 분리해서 memo로 감싼다.** `world-state`는 50ms마다 오지만 미니맵은 3초마다
 * 온다. 한 컴포넌트에 두면 정적인 100칸 격자와 모든 점이 초당 20번 다시 그려진다 — 화면에
 * 바뀌는 건 없는데 비용만 나간다.
 *
 * 서버가 좌표를 섹터 중심으로 뭉개서 보내므로(`precision: "sector-center"`) 보간하지 않는다.
 * 3초마다 툭 옮겨 앉는 게 정상이고, 부드럽게 만들려고 애니메이션을 걸면 있지도 않은 정밀도를
 * 꾸며내는 셈이 된다.
 */
const SECTOR_LABELS = Array.from({ length: WORLD_SECTOR_COUNT * WORLD_SECTOR_COUNT }, (_, index) => {
  const column = index % WORLD_SECTOR_COUNT;
  const row = Math.floor(index / WORLD_SECTOR_COUNT);
  return `${String.fromCharCode(65 + column)}${row + 1}`;
});

/** 격자는 절대 안 바뀐다. 한 번 만들어 재사용한다. */
const SECTOR_GRID = (
  <div className="minimap-sectors">
    {SECTOR_LABELS.map((label) => (
      <span key={label}>{label}</span>
    ))}
  </div>
);

function MinimapView({ minimap, selfId }: { minimap: WorldMinimap | null; selfId: string }) {
  return (
    <div
      className="world-minimap"
      data-testid="world-minimap"
      data-corners="square"
      data-precision="sector-center"
      role="img"
      aria-label="월드 미니맵"
    >
      {SECTOR_GRID}
      {minimap?.players.map((entry) => (
        <i
          key={entry.id}
          className={entry.id === selfId ? "is-self" : entry.state === "playing" ? "is-playing" : "is-active"}
          style={{
            left: `${(entry.x / minimap.map.width) * 100}%`,
            top: `${(entry.y / minimap.map.height) * 100}%`,
          }}
        />
      ))}
    </div>
  );
}

export const Minimap = memo(MinimapView);
