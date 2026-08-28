import { useCallback, useEffect, useState } from "react";
import { connectBackend, type BackendSocket } from "./backend/client.js";
import { worldSector, type WorldPlayerView } from "./backend/protocol.js";
import { useMatchControls } from "./match/controls.js";
import { MatchView } from "./match/match-view.js";
import { PracticeView } from "./match/practice-view.js";
import { useMatch } from "./match/use-match.js";
import { usePractice } from "./match/use-practice.js";
import { ChatPanel } from "./world/chat-panel.js";
import { useKeyboardMovement } from "./world/keyboard.js";
import { useWorld } from "./world/use-world.js";
import { WorldView } from "./world/world-view.js";

export function App() {
  const [socket, setSocket] = useState<BackendSocket | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const { world, latest, minimap, chat, leaderboard, active, dashGauge, setMove, queueDash, activate, sendChat } =
    useWorld(socket);
  const match = useMatch(socket);
  const practice = usePractice(socket);
  const inMatch = match.phase.kind === "live";

  // 온라인 상대가 잡히면 연습을 접고 실전으로 넘어간다. 연습은 대기 시간을 메우는 용도다.
  useEffect(() => {
    if (inMatch) practice.stop();
  }, [inMatch, practice]);

  /** 매칭 시작: 대기열에 넣고 기다리는 동안 바로 AI와 붙는다. */
  const startQuickPlay = useCallback(() => {
    socket?.emit("join-queue");
    practice.start();
  }, [socket, practice]);

  const leavePractice = useCallback(() => {
    socket?.emit("leave-queue");
    practice.stop();
  }, [socket, practice]);

  useEffect(() => {
    let disposed = false;
    let opened: BackendSocket | null = null;
    connectBackend()
      .then((connection) => {
        if (disposed) {
          connection.disconnect();
          return;
        }
        opened = connection;
        setSocket(connection);
      })
      .catch((error: unknown) => setConnectionError(error instanceof Error ? error.message : String(error)));
    return () => {
      disposed = true;
      opened?.disconnect();
    };
  }, []);

  // 조작이 있어야 월드에 등장한다. 접속만으로 등장시키면 켜두고 자리 비운 사람이 월드를 채운다.
  // 경기 중에는 같은 키가 경기 조작으로 가야 하므로 월드 쪽 리스너를 내린다.
  useKeyboardMovement(!!socket && !inMatch && !practice.active, setMove, queueDash, activate);
  useMatchControls(inMatch, match.input);
  useMatchControls(practice.active && !inMatch, practice.input);

  const self = world?.players.find((player) => player.id === world.selfId);
  const sector = self ? worldSector(self.x, self.y) : null;

  const onChallenge = useCallback(
    (target: WorldPlayerView) => socket?.emit("challenge-request", { targetId: target.id }),
    [socket],
  );
  const onSpectate = useCallback(
    (target: WorldPlayerView) => socket?.emit("spectate-request", { targetId: target.id }),
    [socket],
  );

  if (match.phase.kind === "live") {
    return <MatchView match={match} opponent={match.phase.opponent} playerIndex={match.phase.playerIndex} />;
  }

  if (practice.active) {
    return (
      <PracticeView
        practice={practice}
        queueLabel={
          match.phase.kind === "searching"
            ? "사람 상대를 찾는 중… 잡히면 바로 전환됩니다"
            : match.phase.kind === "found"
              ? `${match.phase.opponent} 와 곧 시작`
              : null
        }
        onLeave={leavePractice}
      />
    );
  }

  return (
    <section className="world-shell">
      <div className={`server-status${socket ? " is-online" : ""}`}>
        {connectionError ? "서버 연결 실패" : socket ? "서버 연결됨" : "서버 연결 중…"}
      </div>

      <div className="world-title">
        <small>LIVE WORLD</small>
        <strong>사커.오아지지</strong>
      </div>

      {active && (
        <div className="world-tip">
          <small>TIP</small>
          <span>상대방을 클릭하면 대전 신청이 됩니다.</span>
        </div>
      )}

      {world && (
        <WorldView
          world={world}
          latest={latest}
          minimap={minimap}
          onChallenge={onChallenge}
          onSpectate={onSpectate}
        />
      )}

      {!active && (
        <div className="world-entry-overlay">
          <div>
            <small>LIVE WORLD PREVIEW</small>
            <strong>이동하면 월드에 등장합니다</strong>
            <p className="desktop-entry-hint">
              <kbd>W</kbd>
              <kbd>A</kbd>
              <kbd>S</kbd>
              <kbd>D</kbd> 또는 방향키를 눌러 참가하세요
            </p>
            <p className="mobile-entry-hint">왼쪽 조이스틱을 움직여 참가하세요</p>
          </div>
        </div>
      )}

      <ChatPanel messages={chat} sector={sector} disabled={!active} onSend={sendChat} />

      <aside className="world-leaderboard">
        <header>
          <small>SEASON</small>
          <strong>LEADERBOARD</strong>
        </header>
        <ol>
          {leaderboard.map((entry, index) => (
            <li key={`${entry.nickname}-${index}`}>
              <em>{index + 1}</em>
              <span>
                <b>{entry.nickname}</b>
                <small>
                  {entry.wins}승 {entry.losses}패
                </small>
              </span>
              <strong>{entry.points}</strong>
            </li>
          ))}
        </ol>
      </aside>

      <button
        className="random-match-button"
        type="button"
        aria-label="랜덤 매치 시작하기"
        disabled={!active}
        onClick={startQuickPlay}
      >
        <small>QUICK PLAY</small>
        <strong>
          {match.phase.kind === "searching"
            ? "상대를 찾는 중…"
            : match.phase.kind === "found"
              ? `${match.phase.opponent} 와 곧 시작`
              : "랜덤 매치 시작하기"}
        </strong>
      </button>

      {match.phase.kind === "result" && (
        <div className="leave-match-confirm">
          <strong>
            {match.phase.score[0]} : {match.phase.score[1]}
          </strong>
          <span>{match.phase.text}</span>
          <div>
            <button type="button" onClick={match.dismissResult}>
              닫기
            </button>
          </div>
        </div>
      )}

      <button className="ai-practice-button" type="button" onClick={practice.start}>
        AI 연습
      </button>

      <button
        className="world-dash-button"
        data-testid="world-dash-button"
        type="button"
        aria-pressed={dashGauge >= 1}
        style={{ "--dash-gauge": `${dashGauge * 360}deg` } as React.CSSProperties}
        onClick={() => {
          activate();
          queueDash();
        }}
      >
        <span>DASH</span>
      </button>
    </section>
  );
}
