import { Server } from "socket.io";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  advanceSimulation,
  createSimInput,
  createSimState,
  type SimInput,
  type SimState,
} from "./simulation.js";
import { createKoreanNickname } from "./nickname.js";


const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * 60Hz로 나가는 상태를 소수 2자리로 반올림해 직렬화한다.
 * 부동소수점 오차가 만드는 17자리 숫자를 그대로 JSON에 실으면
 * 패킷이 몇 배로 커진다(MultiOgarII의 바이너리 프로토콜에서 얻은 교훈).
 */
function serializeState(state: SimState) {
  return {
    players: state.players.map((player) => ({
      x: round2(player.x),
      y: round2(player.y),
      vx: round2(player.vx),
      vy: round2(player.vy),
      dashCooldown: round2(player.dashCooldown),
      dashTime: round2(player.dashTime),
      abilityGauge: round2(player.abilityGauge),
      face: player.face,
      moveX: round2(player.moveX),
      moveY: round2(player.moveY),
    })),
    ball: { x: round2(state.ball.x), y: round2(state.ball.y), vx: round2(state.ball.vx), vy: round2(state.ball.vy) },
    projectiles: state.projectiles.map((projectile) => ({
      owner: projectile.owner,
      x: round2(projectile.x),
      y: round2(projectile.y),
      vx: round2(projectile.vx),
      vy: round2(projectile.vy),
    })),
    score: state.score,
    status: state.status,
    kickoffRemaining: round2(state.kickoffRemaining),
    lastScorer: state.lastScorer,
    goalCount: state.goalCount,
    /** 시뮬레이션 시각(초, ms 정밀도). 클라이언트 스냅샷 보간의 시간축. */
    t: Math.round(state.simTime * 1000) / 1000,
  };
}

function createNickname() {
  return createKoreanNickname();
}

type MatchStatus = "live" | "completed" | "forfeit";

type PublicMatch = {
  id: string;
  status: MatchStatus;
  players: string[];
  score: [number, number];
  startedAt: string;
  endedAt?: string;
  result?: string;
};

type OnlineSession = {
  id: string;
  socketIds: [string, string];
  inputs: [SimInput, SimInput];
  state: SimState;
  interval: NodeJS.Timeout;
  tickCount: number;
  /** 고정 스텝으로 소비하고 남은 시간. */
  accumulator: number;
  /** 마지막으로 진행한 벽시계 시각. 타이머가 밀린 만큼 따라잡는다. */
  lastTickAt: number;
  /** 재접속 유예: true인 동안 공·선수·경기 타이머를 모두 동결한다. */
  frozen: boolean;
  graceTimer?: NodeJS.Timeout;
};
type PendingMatch = { socketIds: [string, string]; timer: NodeJS.Timeout };
type PendingChallenge = { id: string; fromId: string; toId: string; timer: NodeJS.Timeout };
type LobbyChatMessage = { id: string; playerId: string; nickname: string; message: string; sentAt: number; scope: "world" | "sector"; sector?: string };
type LeaderboardStats = { nickname: string; points: number; wins: number; losses: number };
type SpectatorState = {
  players: [{ x: number; y: number; vx?: number; vy?: number; moveX?: number; moveY?: number; dashCooldown?: number; dashTime?: number; abilityGauge?: number }, { x: number; y: number; vx?: number; vy?: number; moveX?: number; moveY?: number; dashCooldown?: number; dashTime?: number; abilityGauge?: number }];
  ball: { x: number; y: number; vx: number; vy: number };
  projectiles: Array<{ owner: 0 | 1; x: number; y: number; vx: number; vy: number }>;
  score: [number, number];
  status: "playing" | "finished";
  kickoffRemaining: number;
  lastScorer: 0 | 1 | null;
  goalCount: number;
  t: number;
};
type WorldPlayer = {
  id: string;
  nickname: string;
  x: number;
  y: number;
  moveX: number;
  moveY: number;
  dashRemaining: number;
  dashGauge: number;
  pingMs: number | null;
};

export function createGameServer(
  validTokens = new Set<string>(),
  options: {
    matchStartDelayMs?: number;
    tickMs?: number;
    broadcastEveryTicks?: number;
    queueAfkMs?: number;
    worldTickMs?: number;
    worldPingIntervalMs?: number;
    worldMinimapIntervalMs?: number;
    challengeTimeoutMs?: number;
    worldPositionSecret?: string;
    worldSpawn?: (index: number) => { x: number; y: number };
  } = {},
) {
  const matchStartDelayMs = options.matchStartDelayMs ?? 3000;
  const tickMs = options.tickMs ?? (1000 / 60);
  // 60Hz 상태 전송: 클라이언트 보간 창이 짧아져 킥·이동 반응이 화면에 더 빨리 보인다.
  const broadcastEveryTicks = options.broadcastEveryTicks ?? 1;
  const profileNames = new Map<string, string>();
  const activatedProfileTokens = new Set<string>();
  const countedConnectionSockets = new Set<string>();
  const socketNames = new Map<string, string>();
  const socketTokens = new Map<string, string>();
  const leaderboardStats = new Map<string, LeaderboardStats>();
  const publicMatches = new Map<string, PublicMatch>();
  const stats = {
    activeConnections: 0,
    totalProfiles: 0,
    totalConnections: 0,
    totalInputs: 0,
    totalMatches: 0,
    liveMatches: 0,
    completedMatches: 0,
    totalForfeits: 0,
    /** 세션 틱 1회 처리 시간 EMA(ms). 서버 과부하 조기 신호로 admin에 노출한다. */
    avgTickMs: 0,
  };
  let publicMatchSequence = 0;
  let guestSequence = 0;
  let io: Server;
  const queuedSockets: string[] = [];
  const pendingMatches = new Map<string, PendingMatch>();
  const pendingChallenges = new Map<string, PendingChallenge>();
  const onlineSessions = new Map<string, OnlineSession>();
  const socketSessionIds = new Map<string, string>();
  const aiGameHosts = new Set<string>();
  const aiSpectatorStates = new Map<string, SpectatorState>();
  const spectatorRooms = new Map<string, string>();
  const worldPlayers = new Map<string, WorldPlayer>();
  /** 미조작 관전자는 고정 카메라로 실제 플레이어의 이동을 본다. */
  const worldPreviewCameras = new Map<string, { x: number; y: number }>();
  /** 익명 브라우저 토큰별 마지막 권위 월드 위치. 소켓 재연결과 분리한다. */
  const worldPositionsByToken = new Map<string, { x: number; y: number }>();
  const WORLD_WIDTH = 8_000;
  const WORLD_HEIGHT = 8_000;
  const WORLD_SPEED = 660;
  const WORLD_DASH_MULTIPLIER = 2.2;
  const WORLD_DASH_SECONDS = 0.28;
  const WORLD_DASH_RECHARGE_SECONDS = 0.9;
  const WORLD_INTEREST_RADIUS = 1_600;
  const WORLD_CHALLENGE_RADIUS = 280;
  const WORLD_CELL_SIZE = 800;
  const WORLD_SECTOR_COUNT = 10;
  const worldTickMs = options.worldTickMs ?? 50;
  const worldPingIntervalMs = options.worldPingIntervalMs ?? 2_000;
  const worldMinimapIntervalMs = options.worldMinimapIntervalMs ?? 3_000;
  const worldPositionSecret = options.worldPositionSecret ?? randomBytes(32).toString("base64url");
  const challengeTimeoutMs = options.challengeTimeoutMs ?? 10_000;
  let worldSpawnSequence = 0;
  let worldInterval: NodeJS.Timeout;
  let worldPingInterval: NodeJS.Timeout;
  let worldMinimapInterval: NodeJS.Timeout;
  let worldPingSequence = 0;
  const pendingWorldPings = new Map<string, { nonce: number; sentAt: number }>();
  const tokenFingerprint = (token: string) => createHash("sha256").update(token).digest("base64url").slice(0, 22);
  const signWorldPosition = (token: string, position: { x: number; y: number }) => {
    const payload = Buffer.from(JSON.stringify({ v: 1, t: tokenFingerprint(token), x: round2(position.x), y: round2(position.y) })).toString("base64url");
    const signature = createHmac("sha256", worldPositionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  };
  const verifyWorldPosition = (token: string, signed: string) => {
    const [payload, signature] = signed.split(".");
    if (!payload || !signature) return null;
    const expected = createHmac("sha256", worldPositionSecret).update(payload).digest();
    const supplied = Buffer.from(signature, "base64url");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v: number; t: string; x: number; y: number };
      if (value.v !== 1 || value.t !== tokenFingerprint(token) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) return null;
      if (value.x < 0 || value.x > WORLD_WIDTH || value.y < 0 || value.y > WORLD_HEIGHT) return null;
      return { x: value.x, y: value.y };
    } catch { return null; }
  };
  const sanitizeSpectatorState = (raw: unknown): SpectatorState | undefined => {
    const value = raw as Partial<SpectatorState>;
    if (!Array.isArray(value?.players) || value.players.length !== 2 || !value.ball || !Array.isArray(value.score)) return undefined;
    const finite = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate);
    if (!value.players.every((player) => finite(player?.x) && finite(player?.y))
      || !finite(value.ball.x) || !finite(value.ball.y) || !finite(value.ball.vx) || !finite(value.ball.vy)
      || value.score.length !== 2 || !value.score.every(finite)) return undefined;
    const players = value.players.map((player) => ({
      x: round2(player.x), y: round2(player.y),
      vx: finite(player.vx) ? round2(player.vx!) : 0, vy: finite(player.vy) ? round2(player.vy!) : 0,
      moveX: finite(player.moveX) ? round2(player.moveX!) : 0, moveY: finite(player.moveY) ? round2(player.moveY!) : 0,
      dashCooldown: finite(player.dashCooldown) ? round2(player.dashCooldown!) : 0,
      dashTime: finite(player.dashTime) ? round2(player.dashTime!) : 0,
      abilityGauge: finite(player.abilityGauge) ? round2(player.abilityGauge!) : 1,
    })) as SpectatorState["players"];
    const projectiles = Array.isArray(value.projectiles) ? value.projectiles.slice(0, 24).filter((projectile) =>
      (projectile?.owner === 0 || projectile?.owner === 1) && finite(projectile.x) && finite(projectile.y) && finite(projectile.vx) && finite(projectile.vy),
    ).map((projectile) => ({ owner: projectile.owner, x: round2(projectile.x), y: round2(projectile.y), vx: round2(projectile.vx), vy: round2(projectile.vy) })) : [];
    return {
      players,
      ball: { x: round2(value.ball.x), y: round2(value.ball.y), vx: round2(value.ball.vx), vy: round2(value.ball.vy) },
      projectiles,
      score: [Math.max(0, Math.floor(value.score[0]!)), Math.max(0, Math.floor(value.score[1]!))],
      status: value.status === "finished" ? "finished" : "playing",
      kickoffRemaining: finite(value.kickoffRemaining) ? Math.max(0, round2(value.kickoffRemaining!)) : 0,
      lastScorer: value.lastScorer === 0 || value.lastScorer === 1 ? value.lastScorer : null,
      goalCount: finite(value.goalCount) ? Math.max(0, Math.floor(value.goalCount!)) : 0,
      t: finite(value.t) ? round2(value.t!) : 0,
    };
  };
  /** 마지막 실제 조작(이동·대시·이모지) 시각. 방치된 탭을 매칭에서 걸러낸다. */
  const socketActivityAt = new Map<string, number>();
  const socketEmoteAt = new Map<string, number>();
  const socketLobbyChatAt = new Map<string, number>();
  const lobbyChatHistory: LobbyChatMessage[] = [];
  const socketChatSectors = new Map<string, string>();
  let lobbyChatSequence = 0;
  /** 실제 사용자 조작이 확인된 소켓만 로비·대기열·공개 통계에 존재한다. */
  const activeSockets = new Set<string>();
  const QUEUE_AFK_MS = options.queueAfkMs ?? 90_000;
  const EMOTES = ["👍", "😄", "😢", "🔥"];
  /** socket ID를 노출하지 않기 위한 공개 피어 ID. */
  const socketPeerIds = new Map<string, string>();
  const peerIdSockets = new Map<string, string>();
  const ensureWorldPlayer = (socketId: string) => {
    const existing = worldPlayers.get(socketId);
    if (existing) return existing;
    const index = worldSpawnSequence++;
    const token = socketTokens.get(socketId);
    const saved = token ? worldPositionsByToken.get(token) : undefined;
    const randomCoordinate = (maximum: number) => {
      const fraction = randomBytes(4).readUInt32BE(0) / 0x1_0000_0000;
      const margin = 320;
      return margin + fraction * (maximum - margin * 2);
    };
    const spawn = saved ?? options.worldSpawn?.(index) ?? { x: randomCoordinate(WORLD_WIDTH), y: randomCoordinate(WORLD_HEIGHT) };
    const player = {
      id: socketPeerIds.get(socketId) ?? randomBytes(6).toString("base64url"),
      nickname: socketNames.get(socketId) ?? "Guest",
      x: Math.max(0, Math.min(WORLD_WIDTH, spawn.x)),
      y: Math.max(0, Math.min(WORLD_HEIGHT, spawn.y)),
      moveX: 0,
      moveY: 0,
      dashRemaining: 0,
      dashGauge: 1,
      pingMs: null,
    } satisfies WorldPlayer;
    worldPlayers.set(socketId, player);
    if (token) worldPositionsByToken.set(token, { x: player.x, y: player.y });
    return player;
  };
  const worldSector = (position: { x: number; y: number }) => {
    const columnIndex = Math.max(0, Math.min(WORLD_SECTOR_COUNT - 1, Math.floor(position.x / (WORLD_WIDTH / WORLD_SECTOR_COUNT))));
    const rowIndex = Math.max(0, Math.min(WORLD_SECTOR_COUNT - 1, Math.floor(position.y / (WORLD_HEIGHT / WORLD_SECTOR_COUNT))));
    return `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
  };
  const sectorsAreAdjacent = (first?: string, second?: string) => {
    if (!first || !second) return false;
    const firstColumn = first.charCodeAt(0) - 65;
    const secondColumn = second.charCodeAt(0) - 65;
    const firstRow = Number(first.slice(1)) - 1;
    const secondRow = Number(second.slice(1)) - 1;
    return Math.max(Math.abs(firstColumn - secondColumn), Math.abs(firstRow - secondRow)) <= 1;
  };
  const activityForSocket = (socketId: string): { kind: "ai" | "online"; opponent: string } | undefined => {
    const sessionId = socketSessionIds.get(socketId);
    const session = sessionId ? onlineSessions.get(sessionId) : undefined;
    if (session) {
      const opponentId = session.socketIds.find((id) => id !== socketId);
      return { kind: "online", opponent: opponentId ? socketNames.get(opponentId) ?? "상대" : "상대" };
    }
    if (aiGameHosts.has(socketId) && aiSpectatorStates.has(socketId)) return { kind: "ai", opponent: "AI" };
    return undefined;
  };
  const broadcastWorldMinimap = () => {
    if (!io) return;
    const sectorWidth = WORLD_WIDTH / WORLD_SECTOR_COUNT;
    const sectorHeight = WORLD_HEIGHT / WORLD_SECTOR_COUNT;
    const players = [...activeSockets].map((socketId) => {
      const player = ensureWorldPlayer(socketId);
      return {
        id: player.id,
        nickname: player.nickname,
        x: (Math.floor(player.x / sectorWidth) + 0.5) * sectorWidth,
        y: (Math.floor(player.y / sectorHeight) + 0.5) * sectorHeight,
        state: activityForSocket(socketId) ? "playing" : "active",
      };
    });
    io.emit("world-minimap", { map: { width: WORLD_WIDTH, height: WORLD_HEIGHT }, precision: "sector-center", intervalMs: worldMinimapIntervalMs, players });
  };
  const chatHistoryFor = (socketId: string) => {
    const player = activeSockets.has(socketId) ? worldPlayers.get(socketId) : undefined;
    const sector = player ? worldSector(player) : undefined;
    return lobbyChatHistory.filter((entry) => entry.scope === "world" || sectorsAreAdjacent(entry.sector, sector));
  };
  const emitChatHistory = (socketId: string) => io.sockets.sockets.get(socketId)?.emit("lobby-chat-history", chatHistoryFor(socketId));
  const broadcastWorldStates = () => {
    if (!io) return;
    const visibleSocketIds = [...activeSockets];
    const grid = new Map<string, string[]>();
    for (const socketId of visibleSocketIds) {
      const player = ensureWorldPlayer(socketId);
      const key = `${Math.floor(player.x / WORLD_CELL_SIZE)},${Math.floor(player.y / WORLD_CELL_SIZE)}`;
      const cell = grid.get(key) ?? [];
      cell.push(socketId);
      grid.set(key, cell);
    }
    const cellReach = Math.ceil(WORLD_INTEREST_RADIUS / WORLD_CELL_SIZE);
    const collectNearbyPlayers = (focus: { x: number; y: number }) => {
      const centerCellX = Math.floor(focus.x / WORLD_CELL_SIZE);
      const centerCellY = Math.floor(focus.y / WORLD_CELL_SIZE);
      const nearbyIds = new Set<string>();
      for (let offsetX = -cellReach; offsetX <= cellReach; offsetX += 1) {
        for (let offsetY = -cellReach; offsetY <= cellReach; offsetY += 1) {
          for (const id of grid.get(`${centerCellX + offsetX},${centerCellY + offsetY}`) ?? []) nearbyIds.add(id);
        }
      }
      return [...nearbyIds]
        .map((socketId) => ({ socketId, player: ensureWorldPlayer(socketId) }))
        .filter(({ player }) => Math.hypot(player.x - focus.x, player.y - focus.y) <= WORLD_INTEREST_RADIUS)
        .map(({ socketId, player }) => ({ id: player.id, nickname: player.nickname, x: round2(player.x), y: round2(player.y), moveX: round2(player.moveX), moveY: round2(player.moveY), pingMs: player.pingMs, dashActive: player.dashRemaining > 0, dashGauge: round2(player.dashGauge), activity: activityForSocket(socketId) }));
    };
    const firstVisiblePlayer = visibleSocketIds.length > 0 ? ensureWorldPlayer(visibleSocketIds[0]!) : undefined;
    for (const [socketId, socket] of io.sockets.sockets) {
      if (socketSessionIds.has(socketId)) continue;
      const self = activeSockets.has(socketId) ? ensureWorldPlayer(socketId) : undefined;
      if (self) {
        const nextSector = worldSector(self);
        if (socketChatSectors.get(socketId) !== nextSector) {
          socketChatSectors.set(socketId, nextSector);
          emitChatHistory(socketId);
        }
      }
      let camera = self ?? worldPreviewCameras.get(socketId);
      if (!camera || (!self && collectNearbyPlayers(camera).length === 0 && firstVisiblePlayer)) {
        camera = firstVisiblePlayer ? { x: firstVisiblePlayer.x, y: firstVisiblePlayer.y } : { x: WORLD_WIDTH / 2, y: WORLD_HEIGHT / 2 };
        if (!self) worldPreviewCameras.set(socketId, camera);
      }
      socket.emit("world-state", {
        map: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
        selfId: self?.id ?? "",
        preview: !self,
        camera: { x: round2(camera.x), y: round2(camera.y) },
        players: collectNearbyPlayers(camera),
        resumeToken: self && socketTokens.get(socketId) ? signWorldPosition(socketTokens.get(socketId)!, self) : undefined,
      });
    }
  };
  const removeFromQueue = (socketId: string) => {
    const index = queuedSockets.indexOf(socketId);
    if (index >= 0) queuedSockets.splice(index, 1);
  };

  const activateSocket = (socketId: string) => {
    if (activeSockets.has(socketId)) {
      socketActivityAt.set(socketId, Date.now());
      return;
    }
    activeSockets.add(socketId);
    worldPreviewCameras.delete(socketId);
    socketActivityAt.set(socketId, Date.now());
    stats.activeConnections += 1;
    const socket = io.sockets.sockets.get(socketId);
    if (!countedConnectionSockets.has(socketId)) {
      countedConnectionSockets.add(socketId);
      stats.totalConnections += 1;
    }
    const token = String(socket?.handshake.auth.token ?? "");
    if (token && !activatedProfileTokens.has(token)) {
      activatedProfileTokens.add(token);
      stats.totalProfiles += 1;
    }
    socket?.emit("presence", { state: "active" });
    ensureWorldPlayer(socketId);
    broadcastWorldStates();
    broadcastSnapshot();
    broadcastLeaderboard();
  };

  const makeSocketInvisible = (socketId: string, reason: "afk" | "disconnect") => {
    removeFromQueue(socketId);
    if (!activeSockets.delete(socketId)) return;
    socketChatSectors.delete(socketId);
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
    const socket = io.sockets.sockets.get(socketId);
    if (reason === "afk") socket?.emit("presence", { state: "inactive", reason });
    broadcastSnapshot();
    broadcastLeaderboard();
  };

  const snapshot = () => ({
    updatedAt: new Date().toISOString(),
    stats: { ...stats },
    recentMatches: [...publicMatches.values()].slice(-50).reverse(),
  });
  const leaderboardPayload = () => {
    const activeTokens = new Set([...activeSockets].map((socketId) => socketTokens.get(socketId)).filter((token): token is string => Boolean(token)));
    return [...leaderboardStats.entries()]
    .filter(([token]) => activeTokens.has(token))
    .map(([, entry]) => entry)
    .sort((a, b) => b.points - a.points || b.wins - a.wins || a.nickname.localeCompare(b.nickname))
    .slice(0, 20)
    .map((entry, index) => ({ rank: index + 1, ...entry }));
  };
  const broadcastLeaderboard = () => io.emit("leaderboard", leaderboardPayload());
  const recordRankedResult = (socketIds: [string, string], score: [number, number], forfeitingSocketId?: string) => {
    const winnerIndex = forfeitingSocketId
      ? (socketIds[0] === forfeitingSocketId ? 1 : 0)
      : score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1;
    if (winnerIndex === null) return;
    for (const [index, socketId] of socketIds.entries()) {
      const token = socketTokens.get(socketId);
      if (!token) continue;
      const entry = leaderboardStats.get(token) ?? { nickname: socketNames.get(socketId) ?? "Guest", points: 0, wins: 0, losses: 0 };
      if (index === winnerIndex) { entry.wins += 1; entry.points += 3; }
      else entry.losses += 1;
      leaderboardStats.set(token, entry);
    }
    broadcastLeaderboard();
  };
  // 입력 폭주가 스냅샷 직렬화 폭주로 이어지지 않도록 짧게 병합해 내보낸다.
  let snapshotTimer: NodeJS.Timeout | null = null;
  let snapshotDirty = false;
  const broadcastSnapshot = () => {
    if (snapshotTimer) {
      snapshotDirty = true;
      return;
    }
    io?.of("/admin").emit("admin-snapshot", snapshot());
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      if (!snapshotDirty) return;
      snapshotDirty = false;
      broadcastSnapshot();
    }, 200);
  };

  const http = createServer((request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    response.setHeader("access-control-allow-headers", "content-type");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (request.method === "POST" && request.url === "/anonymous-profile") {
      const token = randomBytes(32).toString("base64url");
      const nickname = createNickname();
      validTokens.add(token);
      profileNames.set(token, nickname);
      broadcastSnapshot();
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ token, nickname }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
  io = new Server(http, { cors: { origin: "*" } });
  worldInterval = setInterval(() => {
    const elapsedSeconds = worldTickMs / 1000;
    for (const socketId of activeSockets) {
      if (socketSessionIds.has(socketId)) continue;
      const player = ensureWorldPlayer(socketId);
      player.dashGauge = Math.min(1, player.dashGauge + elapsedSeconds / WORLD_DASH_RECHARGE_SECONDS);
      const speed = WORLD_SPEED * (player.dashRemaining > 0 ? WORLD_DASH_MULTIPLIER : 1);
      player.x = Math.max(0, Math.min(WORLD_WIDTH, player.x + player.moveX * speed * elapsedSeconds));
      player.y = Math.max(0, Math.min(WORLD_HEIGHT, player.y + player.moveY * speed * elapsedSeconds));
      player.dashRemaining = Math.max(0, player.dashRemaining - elapsedSeconds);
      const token = socketTokens.get(socketId);
      if (token) worldPositionsByToken.set(token, { x: player.x, y: player.y });
    }
    broadcastWorldStates();
  }, worldTickMs);
  worldPingInterval = setInterval(() => {
    for (const socketId of activeSockets) {
      if (pendingWorldPings.has(socketId)) continue;
      const nonce = ++worldPingSequence;
      pendingWorldPings.set(socketId, { nonce, sentAt: performance.now() });
      io.sockets.sockets.get(socketId)?.emit("world-ping", nonce);
    }
  }, worldPingIntervalMs);
  worldMinimapInterval = setInterval(broadcastWorldMinimap, worldMinimapIntervalMs);
  const sessions = new Map<string, Set<string>>();
  const registerPublicMatch = (sessionId: string, participants: Iterable<string>) => {
    if (publicMatches.has(sessionId)) return;
    publicMatches.set(sessionId, {
      id: `MATCH-${String(++publicMatchSequence).padStart(6, "0")}`,
      status: "live",
      players: [...participants].map((id) => socketNames.get(id) ?? "Guest"),
      score: [0, 0],
      startedAt: new Date().toISOString(),
    });
    stats.totalMatches += 1;
    stats.liveMatches += 1;
    broadcastSnapshot();
  };
  const completePublicMatch = (sessionId: string, state: SimState) => {
    const match = publicMatches.get(sessionId);
    if (!match || match.status !== "live") return;
    match.status = "completed";
    match.endedAt = new Date().toISOString();
    match.score = [...state.score];
    match.result = state.score[0] === state.score[1]
      ? "무승부"
      : `${match.players[state.score[0] > state.score[1] ? 0 : 1] ?? "Guest"} 승리`;
    const session = onlineSessions.get(sessionId);
    if (session) recordRankedResult(session.socketIds, [...state.score]);
    stats.liveMatches -= 1;
    stats.completedMatches += 1;
    broadcastSnapshot();
  };
  const aiSpectatorRoom = (socketId: string) => `spectate-ai:${socketId}`;
  const onlineSpectatorRoom = (sessionId: string) => `spectate-online:${sessionId}`;
  const leaveSpectating = (socketId: string) => {
    const room = spectatorRooms.get(socketId);
    if (!room) return;
    io.sockets.sockets.get(socketId)?.leave(room);
    spectatorRooms.delete(socketId);
  };
  const endSpectatorRoom = (room: string, reason: string) => {
    io.to(room).emit("spectate-ended", { reason });
    for (const [socketId, joinedRoom] of [...spectatorRooms]) {
      if (joinedRoom !== room) continue;
      io.sockets.sockets.get(socketId)?.leave(room);
      spectatorRooms.delete(socketId);
    }
  };
  const stopAiPresence = (socketId: string, reason = "host-left") => {
    if (!aiGameHosts.delete(socketId)) return;
    aiSpectatorStates.delete(socketId);
    endSpectatorRoom(aiSpectatorRoom(socketId), reason);
  };
  const beginOnlineSession = (matchId: string) => {
    const pending = pendingMatches.get(matchId);
    if (!pending) return;
    pendingMatches.delete(matchId);
    const firstSocket = io.sockets.sockets.get(pending.socketIds[0]);
    const secondSocket = io.sockets.sockets.get(pending.socketIds[1]);
    if (!firstSocket || !secondSocket) return;
    const sockets = [firstSocket, secondSocket] as const;
    const sessionId = `online-${randomBytes(12).toString("base64url")}`;
    const state = createSimState();
    const session = {
      id: sessionId,
      socketIds: pending.socketIds,
      inputs: [createSimInput(), createSimInput()],
      state,
      interval: undefined as unknown as NodeJS.Timeout,
      tickCount: 0,
      accumulator: 0,
      lastTickAt: performance.now(),
      frozen: false,
    } satisfies OnlineSession;
    onlineSessions.set(sessionId, session);
    sessions.set(sessionId, new Set(pending.socketIds));
    registerPublicMatch(sessionId, pending.socketIds);
    for (const [index, matchedSocket] of sockets.entries()) {
      stopAiPresence(matchedSocket.id, "online-match-started");
      matchedSocket.join(sessionId);
      socketSessionIds.set(matchedSocket.id, sessionId);
      matchedSocket.emit("match-start", {
        matchId,
        sessionId,
        playerIndex: index,
        opponent: { nickname: socketNames.get(sockets[index === 0 ? 1 : 0]!.id) ?? "Guest" },
        state: serializeState(state),
      });
    }
    broadcastWorldStates();
    session.interval = setInterval(() => {
      // setInterval은 밀릴 수 있으므로 벽시계 경과분을 그대로 진행해
      // 경기 시간이 실제 시간보다 느리게 흐르지 않게 한다.
      const now = performance.now();
      const elapsedSeconds = (now - session.lastTickAt) / 1000;
      session.lastTickAt = now;
      if (session.frozen) return;
      const report = advanceSimulation(session.state, session.inputs, elapsedSeconds, session.accumulator);
      stats.avgTickMs = round2(stats.avgTickMs + (performance.now() - now - stats.avgTickMs) * 0.05);
      session.accumulator = report.accumulator;
      session.tickCount += 1;
      const scored = report.goals > 0;
      if (scored) {
        const match = publicMatches.get(sessionId);
        if (match) {
          match.score = [...session.state.score];
          broadcastSnapshot();
        }
      }
      // 득점·종료 틱은 배수와 무관하게 즉시 내보내 클라이언트가 연출을 놓치지 않게 한다.
      if (session.tickCount % broadcastEveryTicks === 0 || scored || session.state.status === "finished") {
        const serialized = serializeState(session.state);
        io.to(sessionId).emit("state", serialized);
        io.to(onlineSpectatorRoom(sessionId)).emit("spectate-state", serialized);
      }
      if (session.state.status === "finished") {
        clearInterval(session.interval);
        completePublicMatch(sessionId, session.state);
        io.to(sessionId).emit("result", { score: session.state.score, result: publicMatches.get(sessionId)?.result });
        onlineSessions.delete(sessionId);
        for (const socketId of session.socketIds) {
          if (socketSessionIds.get(socketId) === sessionId) socketSessionIds.delete(socketId);
        }
        endSpectatorRoom(onlineSpectatorRoom(sessionId), "match-ended");
        broadcastWorldStates();
      }
    }, tickMs);
  };
  const forfeitOnlineSession = (session: OnlineSession, leaverSocketId: string) => {
    clearInterval(session.interval);
    if (session.graceTimer) clearTimeout(session.graceTimer);
    session.state.status = "finished";
    onlineSessions.delete(session.id);
    for (const socketId of session.socketIds) {
      if (socketSessionIds.get(socketId) === session.id) socketSessionIds.delete(socketId);
    }
    endSpectatorRoom(onlineSpectatorRoom(session.id), "match-ended");
    broadcastWorldStates();
    const match = publicMatches.get(session.id);
    if (match?.status === "live") {
      match.status = "forfeit";
      match.endedAt = new Date().toISOString();
      match.score = [...session.state.score];
      match.result = "몰수 종료";
      stats.liveMatches -= 1;
      stats.completedMatches += 1;
      stats.totalForfeits += 1;
      recordRankedResult(session.socketIds, [...session.state.score], leaverSocketId);
      broadcastSnapshot();
    }
    io.to(session.id).emit("forfeit", { winnerSocketId: leaverSocketId });
    io.to(session.id).emit("result", { score: session.state.score, result: "몰수 종료" });
  };
  const tryMatchQueue = () => {
    // 방치된 탭(마지막 조작이 오래된 소켓)은 매칭에서 제외한다.
    for (let index = queuedSockets.length - 1; index >= 0; index -= 1) {
      const id = queuedSockets[index];
      if (Date.now() - (socketActivityAt.get(id) ?? 0) <= QUEUE_AFK_MS) continue;
      makeSocketInvisible(id, "afk");
      io.sockets.sockets.get(id)?.emit("queue-status", { state: "idle", reason: "afk" });
    }
    while (queuedSockets.length >= 2) {
      const first = queuedSockets.shift()!;
      const second = queuedSockets.shift()!;
      const firstSocket = io.sockets.sockets.get(first);
      const secondSocket = io.sockets.sockets.get(second);
      if (!firstSocket || !secondSocket) continue;
      const matchId = `candidate-${randomBytes(10).toString("base64url")}`;
      const timer = setTimeout(() => beginOnlineSession(matchId), matchStartDelayMs);
      pendingMatches.set(matchId, { socketIds: [first, second], timer });
      firstSocket.emit("match-found", { matchId, startsInMs: matchStartDelayMs, opponent: { nickname: socketNames.get(second) ?? "Guest" } });
      secondSocket.emit("match-found", { matchId, startsInMs: matchStartDelayMs, opponent: { nickname: socketNames.get(first) ?? "Guest" } });
    }
  };
  // 대기열 함수 호출 여부와 무관하게 모든 화면/상태의 활성 사용자를 감시한다.
  const presenceSweepTimer = setInterval(() => {
    const now = Date.now();
    for (const id of [...activeSockets]) {
      if (now - (socketActivityAt.get(id) ?? 0) <= QUEUE_AFK_MS) continue;
      makeSocketInvisible(id, "afk");
      io.sockets.sockets.get(id)?.emit("queue-status", { state: "idle", reason: "afk" });
    }
  }, Math.min(5_000, Math.max(25, Math.floor(QUEUE_AFK_MS / 2))));
  const finishChallenge = (challenge: PendingChallenge, state: "declined" | "expired" | "cancelled") => {
    clearTimeout(challenge.timer);
    pendingChallenges.delete(challenge.id);
    io.sockets.sockets.get(challenge.fromId)?.emit("challenge-status", { challengeId: challenge.id, state });
    io.sockets.sockets.get(challenge.toId)?.emit("challenge-status", { challengeId: challenge.id, state });
  };
  io.of("/admin").on("connection", (socket) => socket.emit("admin-snapshot", snapshot()));
  io.use((socket, next) => validTokens.has(String(socket.handshake.auth.token)) ? next() : next(new Error("unauthorized")));
  io.on("connection", (socket) => {
    const token = String(socket.handshake.auth.token);
    socketNames.set(socket.id, profileNames.get(token) ?? `Guest-${String(++guestSequence).padStart(3, "0")}`);
    const hasOtherLiveSocket = [...socketTokens.values()].includes(token);
    socketTokens.set(socket.id, token);
    // 새로 접속하면 이전 방문의 점수는 초기화한다. 리더보드는 이번 방문의
    // 성적표다. 같은 프로필의 다른 탭이 아직 켜져 있을 때만 점수를 유지한다.
    if (!hasOtherLiveSocket || !leaderboardStats.has(token)) {
      leaderboardStats.set(token, { nickname: socketNames.get(socket.id)!, points: 0, wins: 0, losses: 0 });
      broadcastLeaderboard();
    }
    const peerId = randomBytes(6).toString("base64url");
    socketPeerIds.set(socket.id, peerId);
    peerIdSockets.set(peerId, socket.id);
    socket.emit("lobby-chat-history", chatHistoryFor(socket.id));
    socket.emit("leaderboard", leaderboardPayload());

    socket.on("player-active", () => activateSocket(socket.id));
    socket.on("player-inactive", () => {
      makeSocketInvisible(socket.id, "afk");
      socket.emit("queue-status", { state: "idle", reason: "afk" });
    });
    socket.on("game-presence", (payload: unknown) => {
      const value = payload as { mode?: unknown };
      if (value?.mode === "ai" && activeSockets.has(socket.id) && !socketSessionIds.has(socket.id)) {
        aiGameHosts.add(socket.id);
        broadcastWorldStates();
        return;
      }
      if (value?.mode === "idle") {
        stopAiPresence(socket.id);
        broadcastWorldStates();
      }
    });
    socket.on("ai-spectator-state", (rawState: unknown) => {
      if (!aiGameHosts.has(socket.id) || socketSessionIds.has(socket.id)) return;
      const state = sanitizeSpectatorState(rawState);
      if (!state) return;
      const firstState = !aiSpectatorStates.has(socket.id);
      aiSpectatorStates.set(socket.id, state);
      if (firstState) broadcastWorldStates();
      io.to(aiSpectatorRoom(socket.id)).emit("spectate-state", state);
    });
    socket.on("spectate-request", (payload: unknown) => {
      const value = payload as { targetId?: unknown };
      if (typeof value?.targetId !== "string" || !activeSockets.has(socket.id)) return;
      const targetSocketId = peerIdSockets.get(value.targetId);
      if (!targetSocketId || targetSocketId === socket.id || !activeSockets.has(targetSocketId)) {
        socket.emit("spectate-ended", { reason: "unavailable" });
        return;
      }
      leaveSpectating(socket.id);
      removeFromQueue(socket.id);
      socket.emit("queue-status", { state: "idle" });
      const sessionId = socketSessionIds.get(targetSocketId);
      const session = sessionId ? onlineSessions.get(sessionId) : undefined;
      if (session) {
        const room = onlineSpectatorRoom(session.id);
        socket.join(room);
        spectatorRooms.set(socket.id, room);
        socket.emit("spectate-start", {
          mode: "online",
          sessionId: session.id,
          names: session.socketIds.map((id) => socketNames.get(id) ?? "Guest"),
          state: serializeState(session.state),
        });
        return;
      }
      const aiState = aiSpectatorStates.get(targetSocketId);
      if (aiGameHosts.has(targetSocketId) && aiState) {
        const room = aiSpectatorRoom(targetSocketId);
        socket.join(room);
        spectatorRooms.set(socket.id, room);
        socket.emit("spectate-start", {
          mode: "ai",
          sessionId: `ai-${socketPeerIds.get(targetSocketId) ?? targetSocketId}`,
          names: [socketNames.get(targetSocketId) ?? "Guest", "AI"],
          state: aiState,
        });
        return;
      }
      socket.emit("spectate-ended", { reason: "unavailable" });
    });
    socket.on("spectate-leave", () => {
      leaveSpectating(socket.id);
      socket.emit("spectate-ended", { reason: "left" });
    });

    socket.on("world-input", (input: unknown) => {
      if (!activeSockets.has(socket.id) || socketSessionIds.has(socket.id)) return;
      const value = input as { moveX?: unknown; moveY?: unknown; dash?: unknown };
      if (typeof value?.moveX !== "number" || typeof value?.moveY !== "number") return;
      if (value.dash !== undefined && typeof value.dash !== "boolean") return;
      if (!Number.isFinite(value.moveX) || !Number.isFinite(value.moveY)) return;
      const magnitude = Math.hypot(value.moveX, value.moveY);
      if (magnitude > 1.001) return;
      const player = ensureWorldPlayer(socket.id);
      player.moveX = value.moveX;
      player.moveY = value.moveY;
      if (value.dash && player.dashGauge >= 1) {
        player.dashGauge = 0;
        player.dashRemaining = WORLD_DASH_SECONDS;
      }
      socketActivityAt.set(socket.id, Date.now());
    });
    socket.on("world-resume", (signed: unknown) => {
      if (typeof signed !== "string" || signed.length > 512 || activeSockets.has(socket.id)) return;
      const token = socketTokens.get(socket.id);
      if (!token) return;
      const restored = verifyWorldPosition(token, signed);
      if (restored) worldPositionsByToken.set(token, restored);
    });
    socket.on("world-pong", (nonce: unknown) => {
      const pending = pendingWorldPings.get(socket.id);
      if (!pending || nonce !== pending.nonce) return;
      pendingWorldPings.delete(socket.id);
      const measured = Math.max(0, Math.min(999, performance.now() - pending.sentAt));
      const player = ensureWorldPlayer(socket.id);
      player.pingMs = player.pingMs === null ? measured : player.pingMs + (measured - player.pingMs) * 0.25;
    });
    socket.on("lobby-chat", (rawPayload: unknown) => {
      if (!activeSockets.has(socket.id) || socketSessionIds.has(socket.id)) return;
      const payload = typeof rawPayload === "string" ? { message: rawPayload, scope: "world" as const } : rawPayload as { message?: unknown; scope?: unknown };
      if (typeof payload?.message !== "string" || (payload.scope !== "world" && payload.scope !== "sector")) return;
      const now = Date.now();
      if (now - (socketLobbyChatAt.get(socket.id) ?? 0) < 700) return;
      const message = payload.message.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!message) return;
      socketLobbyChatAt.set(socket.id, now);
      const sender = ensureWorldPlayer(socket.id);
      const sector = worldSector(sender);
      const entry = { id: `chat-${++lobbyChatSequence}`, playerId: sender.id, nickname: socketNames.get(socket.id) ?? "Guest", message, sentAt: now, scope: payload.scope, ...(payload.scope === "sector" ? { sector } : {}) } satisfies LobbyChatMessage;
      lobbyChatHistory.push(entry);
      if (lobbyChatHistory.length > 50) lobbyChatHistory.splice(0, lobbyChatHistory.length - 50);
      if (entry.scope === "world") io.emit("lobby-chat", entry);
      else for (const recipientId of activeSockets) {
        if (socketSessionIds.has(recipientId)) continue;
        const recipient = worldPlayers.get(recipientId);
        if (recipient && sectorsAreAdjacent(worldSector(recipient), entry.sector)) io.sockets.sockets.get(recipientId)?.emit("lobby-chat", entry);
      }
    });
    socket.on("challenge-request", (payload: unknown) => {
      const value = payload as { targetId?: unknown };
      if (typeof value?.targetId !== "string" || !activeSockets.has(socket.id) || socketSessionIds.has(socket.id)) return;
      const targetSocketId = peerIdSockets.get(value.targetId);
      if (!targetSocketId || targetSocketId === socket.id || !activeSockets.has(targetSocketId) || socketSessionIds.has(targetSocketId)) return;
      if ([...pendingChallenges.values()].some((challenge) => [challenge.fromId, challenge.toId].includes(socket.id) || [challenge.fromId, challenge.toId].includes(targetSocketId))) return;
      const from = ensureWorldPlayer(socket.id);
      const target = ensureWorldPlayer(targetSocketId);
      if (Math.hypot(target.x - from.x, target.y - from.y) > WORLD_CHALLENGE_RADIUS) {
        socket.emit("challenge-status", { state: "too-far" });
        return;
      }
      const challengeId = `challenge-${randomBytes(8).toString("base64url")}`;
      const challenge = {
        id: challengeId,
        fromId: socket.id,
        toId: targetSocketId,
        timer: setTimeout(() => {
          const current = pendingChallenges.get(challengeId);
          if (current) finishChallenge(current, "expired");
        }, challengeTimeoutMs),
      } satisfies PendingChallenge;
      pendingChallenges.set(challengeId, challenge);
      socket.emit("challenge-status", { challengeId, state: "pending", opponent: { id: target.id, nickname: target.nickname, pingMs: target.pingMs } });
      io.sockets.sockets.get(targetSocketId)?.emit("challenge-received", {
        challengeId,
        from: { id: from.id, nickname: from.nickname, pingMs: from.pingMs },
        expiresInMs: challengeTimeoutMs,
      });
    });
    socket.on("challenge-response", (payload: unknown) => {
      const value = payload as { challengeId?: unknown; accept?: unknown };
      if (typeof value?.challengeId !== "string" || typeof value.accept !== "boolean") return;
      const challenge = pendingChallenges.get(value.challengeId);
      if (!challenge || challenge.toId !== socket.id) return;
      if (!value.accept) {
        finishChallenge(challenge, "declined");
        return;
      }
      clearTimeout(challenge.timer);
      pendingChallenges.delete(challenge.id);
      const matchId = challenge.id;
      pendingMatches.set(matchId, {
        socketIds: [challenge.fromId, challenge.toId],
        timer: setTimeout(() => beginOnlineSession(matchId), 0),
      });
      io.sockets.sockets.get(challenge.fromId)?.emit("challenge-status", { challengeId: challenge.id, state: "accepted" });
      io.sockets.sockets.get(challenge.toId)?.emit("challenge-status", { challengeId: challenge.id, state: "accepted" });
    });
    socket.on("challenge-cancel", (payload: unknown) => {
      const value = payload as { challengeId?: unknown };
      if (typeof value?.challengeId !== "string") return;
      const challenge = pendingChallenges.get(value.challengeId);
      if (!challenge || challenge.fromId !== socket.id) return;
      finishChallenge(challenge, "cancelled");
    });

    socket.on("join-queue", () => {
      if (!activeSockets.has(socket.id)) {
        socket.emit("queue-status", { state: "idle", reason: "inactive" });
        return;
      }
      if (queuedSockets.includes(socket.id) || socketSessionIds.has(socket.id) || [...pendingMatches.values()].some((pending) => pending.socketIds.includes(socket.id))) return;
      socketActivityAt.set(socket.id, Date.now());
      queuedSockets.push(socket.id);
      socket.emit("queue-status", { state: "searching" });
      tryMatchQueue();
    });
    socket.on("leave-queue", () => {
      removeFromQueue(socket.id);
      socket.emit("queue-status", { state: "idle" });
    });

    socket.on("join-match", (sessionId: string) => {
      activateSocket(socket.id);
      socket.join(sessionId);
      const participants = sessions.get(sessionId) ?? new Set<string>();
      sessions.set(sessionId, participants);
      participants.add(socket.id);
      if (participants.size === 2) registerPublicMatch(sessionId, participants);
      socket.emit("session", sessionId);
    });
    socket.on("input", (input) => {
      if (typeof input?.moveX !== "number" || typeof input?.moveY !== "number" || typeof input?.dash !== "boolean") return;
      if (input.fire !== undefined && typeof input.fire !== "boolean") return;
      if (!Number.isFinite(input.moveX) || !Number.isFinite(input.moveY) || Math.abs(input.moveX) > 1 || Math.abs(input.moveY) > 1) return;
      if (input.moveX || input.moveY || input.dash || input.fire) activateSocket(socket.id);
      if (!activeSockets.has(socket.id)) return;
      stats.totalInputs += 1;
      broadcastSnapshot();
      const onlineSession = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
      if (onlineSession) {
        const playerIndex = onlineSession.socketIds.indexOf(socket.id);
        if (playerIndex === 0 || playerIndex === 1) {
          // 아직 시뮬레이션이 소비하지 않은 대시는 다음 이동 패킷이 지우지 않게 유지한다.
          const pendingDash = onlineSession.inputs[playerIndex].dash;
          const pendingFire = onlineSession.inputs[playerIndex].fire;
          onlineSession.inputs[playerIndex] = {
            moveX: input.moveX,
            moveY: input.moveY,
            dash: input.dash || pendingDash,
            fire: Boolean(input.fire) || pendingFire,
          };
        }
        return;
      }
      io.to([...socket.rooms].find((r) => r !== socket.id) ?? socket.id).emit("state", { input });
    });
    socket.on("emote", (index: unknown) => {
      if (typeof index !== "number" || !EMOTES[index]) return;
      activateSocket(socket.id);
      const now = Date.now();
      // 이모지 도배 방지: 소켓당 600ms 속도 제한.
      if (now - (socketEmoteAt.get(socket.id) ?? 0) < 600) return;
      socketEmoteAt.set(socket.id, now);
      socketActivityAt.set(socket.id, now);
      const session = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
      if (!session) return;
      const playerIndex = session.socketIds.indexOf(socket.id);
      if (playerIndex < 0) return;
      io.to(session.id).emit("emote", { playerIndex, emoji: EMOTES[index] });
    });

    socket.on("result", (result) => {
      const sessionId = [...socket.rooms].find((room) => room !== socket.id);
      const match = sessionId ? publicMatches.get(sessionId) : undefined;
      if (match?.status === "live") {
        match.status = "completed";
        match.endedAt = new Date().toISOString();
        if (Array.isArray(result?.score) && result.score.length === 2 && result.score.every((score: unknown) => typeof score === "number" && Number.isFinite(score))) {
          match.score = [result.score[0], result.score[1]];
        }
        match.result = match.score[0] === match.score[1]
          ? "무승부"
          : `${match.players[match.score[0] > match.score[1] ? 0 : 1] ?? "Guest"} 승리`;
        stats.liveMatches -= 1;
        stats.completedMatches += 1;
        broadcastSnapshot();
      }
      io.to(sessionId ?? socket.id).emit("result", result);
    });
    socket.on("leave", () => {
      const onlineSession = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
      if (onlineSession) {
        // 자발적 나가기: 재접속 유예 없이 즉시 몰수 처리한다.
        forfeitOnlineSession(onlineSession, socket.id);
        return;
      }
      const sessionId = [...socket.rooms].find((room) => room !== socket.id);
      const match = sessionId ? publicMatches.get(sessionId) : undefined;
      if (match?.status === "live") {
        match.status = "forfeit";
        match.endedAt = new Date().toISOString();
        match.result = "몰수 종료";
        stats.liveMatches -= 1;
        stats.completedMatches += 1;
        stats.totalForfeits += 1;
        broadcastSnapshot();
      }
      io.to(sessionId ?? socket.id).emit("forfeit", { winnerSocketId: socket.id });
    });
    socket.on("disconnect", () => {
      for (const challenge of [...pendingChallenges.values()]) {
        if (challenge.fromId === socket.id || challenge.toId === socket.id) finishChallenge(challenge, "cancelled");
      }
      leaveSpectating(socket.id);
      stopAiPresence(socket.id, "host-disconnected");
      makeSocketInvisible(socket.id, "disconnect");
      socketActivityAt.delete(socket.id);
      socketEmoteAt.delete(socket.id);
      socketLobbyChatAt.delete(socket.id);
      const departedPeerId = socketPeerIds.get(socket.id);
      socketPeerIds.delete(socket.id);
      if (departedPeerId) peerIdSockets.delete(departedPeerId);
      removeFromQueue(socket.id);
      const onlineSession = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
      if (onlineSession && !onlineSession.frozen && onlineSession.state.status === "playing") {
        // 재접속 유예: 경기를 동결하고 15초 안에 돌아오지 못하면 몰수패로 확정한다.
        onlineSession.frozen = true;
        io.to(onlineSession.id).emit("opponent-disconnected", { graceSeconds: 15 });
        onlineSession.graceTimer = setTimeout(() => forfeitOnlineSession(onlineSession, socket.id), 15_000);
      }
      for (const [matchId, pending] of pendingMatches) {
        if (!pending.socketIds.includes(socket.id)) continue;
        clearTimeout(pending.timer);
        pendingMatches.delete(matchId);
        const opponentId = pending.socketIds.find((id) => id !== socket.id);
        const opponent = opponentId ? io.sockets.sockets.get(opponentId) : undefined;
        if (opponent) {
          opponent.emit("match-cancelled", { reason: "opponent-disconnected" });
          queuedSockets.push(opponent.id);
        }
      }
      tryMatchQueue();
      socketNames.delete(socket.id);
      socketTokens.delete(socket.id);
      worldPlayers.delete(socket.id);
      socketChatSectors.delete(socket.id);
      worldPreviewCameras.delete(socket.id);
      pendingWorldPings.delete(socket.id);
      countedConnectionSockets.delete(socket.id);
      io.emit("reconnect-grace", { socketId: socket.id, seconds: 15 });
    });
  });
  const listen = (port = 0, host = "127.0.0.1") => new Promise<number>((resolve) => http.listen(port, host, () => resolve((http.address() as { port: number }).port)));
  const close = () => {
    clearInterval(worldInterval);
    clearInterval(worldPingInterval);
    clearInterval(worldMinimapInterval);
    clearInterval(presenceSweepTimer);
    for (const pending of pendingMatches.values()) clearTimeout(pending.timer);
    for (const challenge of pendingChallenges.values()) clearTimeout(challenge.timer);
    for (const session of onlineSessions.values()) {
      clearInterval(session.interval);
      if (session.graceTimer) clearTimeout(session.graceTimer);
    }
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    return new Promise<void>((resolve) => io.close(() => http.close(() => resolve())));
  };
  return { io, http, listen, close };
}
