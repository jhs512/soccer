import { useCallback, useEffect, useRef, useState } from "react";
import type { BackendSocket } from "../backend/client.js";
import type { MatchInput, MatchSnapshot, QueueStatus } from "../backend/protocol.js";
import { KickPrediction, LocalPrediction } from "./prediction.js";
import { SnapshotBuffer } from "./snapshot-buffer.js";

/** 입력 전송 주기. 서버 틱이 60Hz라 그보다 촘촘히 보내도 판정이 달라지지 않는다. */
const INPUT_INTERVAL_MS = 16;

export type MatchPhase =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "found"; opponent: string; startsInMs: number }
  | { kind: "live"; sessionId: string; playerIndex: 0 | 1; opponent: string }
  | { kind: "result"; score: [number, number]; text: string };

export type MatchHandle = {
  phase: MatchPhase;
  buffer: SnapshotBuffer;
  prediction: LocalPrediction;
  kick: KickPrediction;
  input: React.RefObject<MatchInput>;
  leave: () => void;
  dismissResult: () => void;
};

/**
 * 퀵매치·도전으로 시작되는 온라인 경기의 소켓 배선.
 *
 * 60Hz 스냅샷을 React state에 넣으면 초당 60회 리렌더가 트리 전체에 퍼진다. 스냅샷은 전부
 * ref 안의 버퍼로 흘려보내고, state로 올리는 건 화면 전환을 일으키는 `phase`뿐이다.
 */
export function useMatch(socket: BackendSocket | null): MatchHandle {
  const [phase, setPhase] = useState<MatchPhase>({ kind: "idle" });
  const buffer = useRef(new SnapshotBuffer()).current;
  const prediction = useRef(new LocalPrediction()).current;
  const kick = useRef(new KickPrediction()).current;
  const input = useRef<MatchInput>({ moveX: 0, moveY: 0, dash: false, fire: false });
  const playerIndex = useRef<0 | 1 | null>(null);

  useEffect(() => {
    if (!socket) return;

    const onQueue = (status: QueueStatus) =>
      setPhase((previous) =>
        status.state === "searching"
          ? { kind: "searching" }
          : previous.kind === "searching"
            ? { kind: "idle" }
            : previous,
      );

    const onFound = (payload: { startsInMs: number; opponent: { nickname: string } }) =>
      setPhase({ kind: "found", opponent: payload.opponent.nickname, startsInMs: payload.startsInMs });

    const onStart = (payload: {
      sessionId: string;
      playerIndex: 0 | 1;
      opponent: { nickname: string };
      state: MatchSnapshot;
    }) => {
      buffer.reset();
      prediction.reset();
      kick.reset();
      playerIndex.current = payload.playerIndex;
      buffer.push(payload.state, performance.now() / 1000);
      prediction.reconcile(payload.state.players[payload.playerIndex]);
      setPhase({ kind: "live", sessionId: payload.sessionId, playerIndex: payload.playerIndex, opponent: payload.opponent.nickname });
      socket.emit("join-match", payload.sessionId);
    };

    const onState = (snapshot: MatchSnapshot) => {
      buffer.push(snapshot, performance.now() / 1000);
      if (playerIndex.current !== null) prediction.reconcile(snapshot.players[playerIndex.current]);
    };

    const onResult = (payload: { score: [number, number]; result?: string }) => {
      playerIndex.current = null;
      setPhase({ kind: "result", score: payload.score, text: payload.result ?? "경기 종료" });
    };

    const onCancelled = () => setPhase({ kind: "idle" });

    socket.on("queue-status", onQueue);
    socket.on("match-found", onFound);
    socket.on("match-start", onStart);
    socket.on("state", onState);
    socket.on("spectate-state", onState);
    socket.on("result", onResult);
    socket.on("match-cancelled", onCancelled);

    return () => {
      socket.off("queue-status", onQueue);
      socket.off("match-found", onFound);
      socket.off("match-start", onStart);
      socket.off("state", onState);
      socket.off("spectate-state", onState);
      socket.off("result", onResult);
      socket.off("match-cancelled", onCancelled);
    };
  }, [socket, buffer, prediction, kick]);

  useEffect(() => {
    if (!socket || phase.kind !== "live") return;
    const timer = setInterval(() => {
      socket.emit("input", { ...input.current });
      // 대시·발사는 눌린 순간 한 번만 전달한다. 서버가 다음 틱에 소비하므로 여기서 내린다.
      input.current.dash = false;
      input.current.fire = false;
    }, INPUT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [socket, phase.kind]);

  const leave = useCallback(() => {
    socket?.emit("leave");
    setPhase({ kind: "idle" });
  }, [socket]);

  const dismissResult = useCallback(() => setPhase({ kind: "idle" }), []);

  return { phase, buffer, prediction, kick, input, leave, dismissResult };
}
