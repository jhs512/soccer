import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendSocket } from "../backend/client.js";
import { readWorldResume, writeWorldResume } from "../backend/client.js";
import type { LeaderboardEntry, LobbyChatMessage, WorldMinimap, WorldState } from "../backend/protocol.js";

/** 월드 입력 전송 주기. 서버 월드 틱이 50ms라 그보다 촘촘히 보낼 이유가 없다. */
const INPUT_INTERVAL_MS = 50;

export type WorldSnapshot = {
  world: WorldState | null;
  minimap: WorldMinimap | null;
  chat: LobbyChatMessage[];
  leaderboard: LeaderboardEntry[];
  active: boolean;
};

/**
 * 월드 화면이 필요로 하는 서버 상태를 모은다.
 *
 * `world-state`는 50ms마다 오고 `players`가 매번 새 배열이라 그대로 React state에 넣으면
 * 초당 20회 리렌더가 트리 전체에 퍼진다. 여기서는 월드 상태만 state로 두고, 입력처럼
 * 프레임마다 바뀌는 값은 ref에 담아 렌더와 분리한다.
 */
export function useWorld(socket: BackendSocket | null) {
  const [world, setWorld] = useState<WorldState | null>(null);
  const [minimap, setMinimap] = useState<WorldMinimap | null>(null);
  const [chat, setChat] = useState<LobbyChatMessage[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [active, setActive] = useState(false);

  const input = useRef({ moveX: 0, moveY: 0, dash: false });
  const latest = useRef<WorldState | null>(null);

  useEffect(() => {
    if (!socket) return;

    const onWorldState = (state: WorldState) => {
      // 카메라 루프는 React 렌더를 기다리지 않고 이 ref에서 최신 좌표를 읽는다.
      latest.current = state;
      setWorld(state);
      if (state.resumeToken) writeWorldResume(state.resumeToken);
    };
    const onPing = (nonce: number) => socket.emit("world-pong", nonce);
    const onChat = (message: LobbyChatMessage) => setChat((previous) => [...previous, message].slice(-80));
    const onPresence = (payload: { state: "active" | "inactive" }) => setActive(payload.state === "active");

    socket.on("world-state", onWorldState);
    socket.on("world-minimap", setMinimap);
    socket.on("world-ping", onPing);
    socket.on("lobby-chat", onChat);
    socket.on("lobby-chat-history", setChat);
    socket.on("leaderboard", setLeaderboard);
    socket.on("presence", onPresence);

    // 활성화 전에만 받아주므로 player-active보다 먼저 보내야 한다.
    const resume = readWorldResume();
    if (resume) socket.emit("world-resume", resume);

    return () => {
      socket.off("world-state", onWorldState);
      socket.off("world-minimap", setMinimap);
      socket.off("world-ping", onPing);
      socket.off("lobby-chat", onChat);
      socket.off("lobby-chat-history", setChat);
      socket.off("leaderboard", setLeaderboard);
      socket.off("presence", onPresence);
    };
  }, [socket]);

  useEffect(() => {
    if (!socket || !active) return;
    const timer = setInterval(() => {
      socket.emit("world-input", { moveX: input.current.moveX, moveY: input.current.moveY, dash: input.current.dash });
      input.current.dash = false;
    }, INPUT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [socket, active]);

  /** 이동 벡터. 서버가 크기 1을 넘는 입력을 조용히 버리므로 여기서 잘라 보낸다. */
  const setMove = useCallback((moveX: number, moveY: number) => {
    const magnitude = Math.hypot(moveX, moveY);
    const scale = magnitude > 1 ? 1 / magnitude : 1;
    input.current.moveX = moveX * scale;
    input.current.moveY = moveY * scale;
  }, []);

  const queueDash = useCallback(() => {
    input.current.dash = true;
  }, []);

  /** 월드 등장. 조작이 있기 전까지는 관람(preview) 상태로 둔다. */
  const activate = useCallback(() => {
    socket?.emit("player-active");
  }, [socket]);

  const sendChat = useCallback(
    (message: string, scope: "world" | "sector") => {
      const trimmed = message.trim();
      if (!trimmed) return;
      socket?.emit("lobby-chat", { message: trimmed, scope });
    },
    [socket],
  );

  /** 대시 버튼의 게이지(0~1). 서버가 world-state에 실어주는 권위 값이다. */
  const dashGauge = world?.players.find((player) => player.id === world.selfId)?.dashGauge ?? 0;

  return {
    world,
    latest,
    minimap,
    chat,
    leaderboard,
    active,
    dashGauge,
    setMove,
    queueDash,
    activate,
    sendChat,
  } as const;
}
