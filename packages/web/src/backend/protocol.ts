/**
 * 서버와 주고받는 이벤트의 타입.
 *
 * 유일한 근거는 `packages/server/src/server.ts`다. 프런트 소스가 유실돼 이 파일은 재작성본이므로,
 * 서버와 어긋나면 서버가 옳다. 요약은 `docs/protocol.md`.
 */

export const WORLD_WIDTH = 8_000;
export const WORLD_HEIGHT = 8_000;
export const WORLD_SECTOR_COUNT = 10;
export const WORLD_CELL_SIZE = 800;
/** 서버가 world-state에 담아주는 반경. 화면 밖 플레이어는 애초에 오지 않는다. */
export const WORLD_INTEREST_RADIUS = 1_600;
export const WORLD_CHALLENGE_RADIUS = 280;

/** 경기 중이 아니면 서버가 아예 필드를 안 보낸다(undefined). "idle" 같은 값은 오지 않는다. */
export type WorldActivity = { kind: "online" | "ai"; opponent: string } | undefined;

export type WorldPlayerView = {
  id: string;
  nickname: string;
  x: number;
  y: number;
  moveX: number;
  moveY: number;
  pingMs: number | null;
  dashActive: boolean;
  dashGauge: number;
  activity: WorldActivity;
};

export type WorldState = {
  map: { width: number; height: number };
  /** 활성화 전에는 빈 문자열이다. `preview`와 함께 본다. */
  selfId: string;
  /** true면 아직 월드에 등장하지 않은 관람 상태. */
  preview: boolean;
  camera: { x: number; y: number };
  players: WorldPlayerView[];
  /** 서버가 HMAC 서명한 마지막 위치. 재접속 때 world-resume으로 돌려준다. */
  resumeToken?: string;
};

/**
 * 미니맵은 좌표를 **섹터 중심으로 뭉개서** 보낸다(`precision: "sector-center"`).
 * 정밀 위치를 전 서버에 뿌리지 않기 위한 것이므로 그대로 점을 찍어야 하고, 보간하면 안 된다.
 */
export type WorldMinimap = {
  map: { width: number; height: number };
  precision: "sector-center";
  intervalMs: number;
  players: Array<{ id: string; nickname: string; x: number; y: number; state: "playing" | "active" }>;
};

export type ChatScope = "world" | "sector";

export type LobbyChatMessage = {
  id: string;
  playerId: string;
  nickname: string;
  message: string;
  sentAt: number;
  scope: ChatScope;
  sector?: string;
};

export type LeaderboardEntry = { nickname: string; points: number; wins: number; losses: number };

export type ChallengePeer = { id: string; nickname: string; pingMs: number | null };

export type ChallengeStatus =
  | { state: "too-far" }
  | { challengeId: string; state: "pending"; opponent: ChallengePeer }
  | { challengeId: string; state: "accepted" | "declined" | "cancelled" | "expired" };

export type ChallengeReceived = { challengeId: string; from: ChallengePeer; expiresInMs: number };

export type QueueStatus = { state: "searching" | "idle"; reason?: "afk" | "inactive" };

/** 서버는 `fire` 없는 입력도 받아주지만, 우리는 항상 채워 보내므로 필수로 둔다(공유 물리와 같은 모양). */
export type MatchInput = { moveX: number; moveY: number; dash: boolean; fire: boolean };

export type MatchPlayerSnapshot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dashCooldown: number;
  dashTime: number;
  abilityGauge: number;
  face: number;
  moveX: number;
  moveY: number;
};

export type MatchSnapshot = {
  players: [MatchPlayerSnapshot, MatchPlayerSnapshot];
  ball: { x: number; y: number; vx: number; vy: number };
  projectiles: Array<{ owner: 0 | 1; x: number; y: number; vx: number; vy: number }>;
  score: [number, number];
  status: "playing" | "finished";
  kickoffRemaining: number;
  lastScorer: 0 | 1 | null;
  goalCount: number;
  /**
   * 시뮬레이션 시각(초). 스냅샷 보간의 시간축은 도착 시각이 아니라 이 값이다.
   * 도착 시점 기준 보간은 패킷 지터가 속도 요동으로 번져서 폐기된 접근이다.
   */
  t: number;
};

export type SpectateStart = {
  mode: "online" | "ai";
  sessionId: string;
  names: string[];
  state: MatchSnapshot;
};

/** 서버 → 클라이언트. */
export type ServerEvents = {
  presence: (payload: { state: "active" | "inactive" }) => void;
  "world-state": (state: WorldState) => void;
  "world-minimap": (payload: WorldMinimap) => void;
  "world-ping": (nonce: number) => void;
  "lobby-chat": (message: LobbyChatMessage) => void;
  "lobby-chat-history": (messages: LobbyChatMessage[]) => void;
  leaderboard: (entries: LeaderboardEntry[]) => void;
  "challenge-received": (payload: ChallengeReceived) => void;
  "challenge-status": (payload: ChallengeStatus) => void;
  "queue-status": (payload: QueueStatus) => void;
  "match-found": (payload: { matchId: string; startsInMs: number; opponent: { nickname: string } }) => void;
  "match-start": (payload: {
    matchId: string;
    sessionId: string;
    playerIndex: 0 | 1;
    opponent: { nickname: string };
    state: MatchSnapshot;
  }) => void;
  "match-cancelled": (payload: { reason?: string }) => void;
  session: (sessionId: string) => void;
  state: (snapshot: MatchSnapshot) => void;
  emote: (payload: { playerIndex: 0 | 1; emoji: string }) => void;
  result: (payload: { score: [number, number]; result?: string }) => void;
  forfeit: (payload: { winnerSocketId: string }) => void;
  "opponent-disconnected": (payload: { graceSeconds: number }) => void;
  "reconnect-grace": (payload: { graceSeconds: number }) => void;
  "spectate-start": (payload: SpectateStart) => void;
  "spectate-state": (state: MatchSnapshot) => void;
  "spectate-ended": (payload: { reason: "left" | "unavailable" }) => void;
};

/** 클라이언트 → 서버. */
export type ClientEvents = {
  "player-active": () => void;
  "player-inactive": () => void;
  "game-presence": (payload: { mode: "ai" | "idle" }) => void;
  "ai-spectator-state": (state: MatchSnapshot) => void;
  "world-input": (input: { moveX: number; moveY: number; dash?: boolean }) => void;
  "world-resume": (signed: string) => void;
  "world-pong": (nonce: number) => void;
  "lobby-chat": (payload: { message: string; scope: ChatScope }) => void;
  "challenge-request": (payload: { targetId: string }) => void;
  "challenge-response": (payload: { challengeId: string; accept: boolean }) => void;
  "challenge-cancel": (payload: { challengeId: string }) => void;
  "join-queue": () => void;
  "leave-queue": () => void;
  "join-match": (sessionId: string) => void;
  input: (input: MatchInput) => void;
  emote: (index: number) => void;
  result: (payload: { score: [number, number] }) => void;
  leave: () => void;
  "spectate-request": (payload: { targetId: string }) => void;
  "spectate-leave": () => void;
};

/** 섹터 이름(A1~J10). 서버의 worldSector와 같은 규칙이어야 한다. */
export function worldSector(x: number, y: number) {
  const column = Math.min(WORLD_SECTOR_COUNT - 1, Math.max(0, Math.floor(x / WORLD_CELL_SIZE)));
  const row = Math.min(WORLD_SECTOR_COUNT - 1, Math.max(0, Math.floor(y / WORLD_CELL_SIZE)));
  return `${String.fromCharCode(65 + column)}${row + 1}`;
}
