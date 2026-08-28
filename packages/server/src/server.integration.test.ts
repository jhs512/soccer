import { afterEach, describe, expect, it } from "vitest";
import { io as client } from "socket.io-client";
import { createGameServer } from "./server.js";

const once = (socket: any, event: string) => new Promise<any>((resolve) => socket.once(event, resolve));
const until = (socket: any, event: string, predicate: (value: any) => boolean) => new Promise<any>((resolve) => {
  const listener = (value: any) => {
    if (!predicate(value)) return;
    socket.off(event, listener);
    resolve(value);
  };
  socket.on(event, listener);
});
const activate = (...sockets: any[]) => sockets.forEach((socket) => socket.emit("player-active"));
const clusteredWorldSpawn = (index: number) => ({ x: 4_000 + index * 90, y: 4_000 });

describe("Socket.IO 권위 온라인 퀵매치", () => {
  let game: ReturnType<typeof createGameServer> | undefined;
  afterEach(async () => game && game.close());

  it("AWS health check와 익명 프로필 발급 토큰으로 연결한다", async () => {
    game = createGameServer();
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;

    const health = await fetch(`${url}/health`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({ status: "ok" });

    const profileResponse = await fetch(`${url}/anonymous-profile`, { method: "POST" });
    expect(profileResponse.status).toBe(201);
    const profile = await profileResponse.json() as { token: string; nickname: string };
    expect(profile.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(profile.nickname).toMatch(/^[가-힣0-9]+(?: [가-힣0-9]+)+$/);

    const socket = client(url, { auth: { token: profile.token } });
    await expect(once(socket, "connect")).resolves.toBeUndefined();
    socket.close();
  });

  it("인증 없이 공개 운영 통계를 구독하되 익명 토큰은 노출하지 않는다", async () => {
    game = createGameServer();
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const admin = client(`${url}/admin`);
    const initialSnapshot = once(admin, "admin-snapshot");
    await once(admin, "connect");
    await expect(initialSnapshot).resolves.toMatchObject({
      stats: {
        activeConnections: 0,
        totalProfiles: 0,
        totalConnections: 0,
        totalInputs: 0,
        totalMatches: 0,
        liveMatches: 0,
        completedMatches: 0,
        totalForfeits: 0,
      },
      recentMatches: [],
    });

    const profileResponse = await fetch(`${url}/anonymous-profile`, { method: "POST" });
    const profile = await profileResponse.json() as { token: string };
    const changedSnapshot = until(admin, "admin-snapshot", (value) => value.stats.activeConnections === 1);
    const player = client(url, { auth: { token: profile.token } });
    await once(player, "connect");
    activate(player);
    const snapshot = await changedSnapshot;
    expect(snapshot.stats).toMatchObject({ activeConnections: 1, totalProfiles: 1, totalConnections: 1 });
    expect(JSON.stringify(snapshot)).not.toContain(profile.token);

    player.close();
    admin.close();
  });

  it("실제 조작으로 활성화되기 전 소켓은 통계와 대기열에서 존재하지 않는다", async () => {
    game = createGameServer(new Set(["sleeping", "awake"]), { matchStartDelayMs: 10 });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const admin = client(`${url}/admin`);
    const sleeping = client(url, { auth: { token: "sleeping" } });
    const awake = client(url, { auth: { token: "awake" } });
    await Promise.all([once(admin, "connect"), once(sleeping, "connect"), once(awake, "connect")]);

    const inactiveStatus = once(sleeping, "queue-status");
    sleeping.emit("join-queue");
    const inactive = await inactiveStatus;
    expect(inactive).toMatchObject({ state: "idle", reason: "inactive" });

    const firstActive = once(sleeping, "presence");
    sleeping.emit("player-active");
    await expect(firstActive).resolves.toEqual({ state: "active" });
    const searchingStatus = once(sleeping, "queue-status");
    sleeping.emit("join-queue");
    await expect(searchingStatus).resolves.toMatchObject({ state: "searching" });

    let matched = false;
    sleeping.on("match-found", () => { matched = true; });
    awake.emit("join-queue");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(matched).toBe(false);

    const snapshotPromise = until(admin, "admin-snapshot", (value) => value.stats.activeConnections === 2);
    const foundAfterActivation = once(sleeping, "match-found");
    awake.emit("player-active");
    awake.emit("join-queue");
    await expect(snapshotPromise).resolves.toMatchObject({ stats: { activeConnections: 2, totalConnections: 2 } });
    await expect(foundAfterActivation).resolves.toBeTruthy();

    sleeping.close(); awake.close(); admin.close();
  });

  it("최초 미조작 사용자는 blind 상태로 다른 활성 플레이어의 월드 이동을 미리 본다", async () => {
    game = createGameServer(new Set(["preview-active", "preview-viewer"]), { worldTickMs: 20, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const active = client(url, { auth: { token: "preview-active" } });
    const viewer = client(url, { auth: { token: "preview-viewer" } });
    await Promise.all([once(active, "connect"), once(viewer, "connect")]);
    const firstPreview = until(viewer, "world-state", (state) => state.preview === true && state.players.length === 1);
    activate(active);
    const preview = await firstPreview;
    const startX = preview.players[0].x;
    const movingPreview = until(viewer, "world-state", (state) => state.preview === true && state.players[0]?.x > startX + 20);
    active.emit("world-input", { moveX: 1, moveY: 0, dash: false });
    await expect(movingPreview).resolves.toMatchObject({ selfId: "", preview: true, players: [expect.objectContaining({ nickname: "Guest-001" })] });
    active.close(); viewer.close();
  });

  it("활성 플레이어 두 명은 큰 월드의 주변 상태를 받고 서버 판정 이동을 공유한다", async () => {
    game = createGameServer(new Set(["world-one", "world-two"]), { worldTickMs: 10, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "world-one" } });
    const b = client(url, { auth: { token: "world-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    const bothVisible = until(a, "world-state", (state) => state.players.length === 2);
    activate(a, b);
    const initial = await bothVisible;
    expect(initial.map).toEqual({ width: 8_000, height: 8_000 });
    expect(initial.players.map((player: { nickname: string }) => player.nickname)).toEqual(expect.arrayContaining(["Guest-001", "Guest-002"]));
    const me = initial.players.find((player: { id: string }) => player.id === initial.selfId);

    const movedForBoth = Promise.all([a, b].map((socket) => until(socket, "world-state", (state) => {
      const moved = state.players.find((player: { id: string }) => player.id === initial.selfId);
      return moved && moved.x > me.x + 3;
    })));
    a.emit("world-input", { moveX: 1, moveY: 0 });
    await expect(movedForBoth).resolves.toHaveLength(2);
    a.close(); b.close();
  });

  it("월드는 기존보다 3배 빠르게 이동하고 서버 게이지가 찼을 때 대시한다", async () => {
    game = createGameServer(new Set(["world-speed"]), { worldTickMs: 100 });
    const port = await game.listen();
    const socket = client(`http://127.0.0.1:${port}`, { auth: { token: "world-speed" } });
    await once(socket, "connect");
    const initialState = until(socket, "world-state", (state) => state.players.length === 1);
    activate(socket);
    const initial = await initialState;
    const startX = initial.players[0].x;
    socket.emit("world-input", { moveX: 1, moveY: 0, dash: false });
    const moved = await until(socket, "world-state", (state) => state.players[0].x >= startX + 60);
    expect(moved.players[0].x - startX).toBeCloseTo(66, 0);

    const beforeDash = moved.players[0].x;
    socket.emit("world-input", { moveX: 1, moveY: 0, dash: true });
    const dashed = await until(socket, "world-state", (state) => state.players[0].dashActive === true && state.players[0].x > beforeDash);
    expect(dashed.players[0].x - beforeDash).toBeGreaterThan(120);
    expect(dashed.players[0].dashGauge).toBeLessThan(0.2);
    socket.close();
  });

  it("최초 위치는 랜덤 생성하고 같은 브라우저 토큰은 마지막 월드 위치에서 다시 스폰한다", async () => {
    let spawnCalls = 0;
    game = createGameServer(undefined, {
      worldTickMs: 20,
      worldSpawn: () => { spawnCalls += 1; return { x: 1_234, y: 2_345 }; },
    });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const issued = await (await fetch(`${url}/anonymous-profile`, { method: "POST" })).json() as { token: string };
    const first = client(url, { auth: { token: issued.token } });
    await once(first, "connect");
    const firstState = until(first, "world-state", (state) => state.players.length === 1);
    activate(first);
    const initial = await firstState;
    expect(initial.players[0]).toMatchObject({ x: 1_234, y: 2_345 });
    first.emit("world-input", { moveX: 1, moveY: 0, dash: false });
    const moved = await until(first, "world-state", (state) => state.players[0].x > 1_260);
    expect(moved.resumeToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    first.close();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const reconnected = client(url, { auth: { token: issued.token } });
    await once(reconnected, "connect");
    const restoredState = until(reconnected, "world-state", (state) => state.players.length === 1);
    reconnected.emit("world-resume", moved.resumeToken);
    activate(reconnected);
    const restored = await restoredState;
    expect(restored.players[0].x).toBeCloseTo(moved.players[0].x, 0);
    expect(restored.players[0].y).toBe(2_345);
    expect(spawnCalls).toBe(1);
    reconnected.close();
  });

  it("큰 월드는 공간 관심 영역 밖의 플레이어를 world-state에서 제외한다", async () => {
    const spawns = [{ x: 1_000, y: 1_000 }, { x: 1_300, y: 1_000 }, { x: 7_000, y: 7_000 }];
    game = createGameServer(new Set(["near-a", "near-b", "far-c"]), {
      worldTickMs: 10,
      worldSpawn: (index) => spawns[index]!,
    });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const sockets = ["near-a", "near-b", "far-c"].map((token) => client(url, { auth: { token } }));
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    const nearState = until(sockets[0], "world-state", (state) => state.players.length === 2);
    for (const socket of sockets.slice(0, 2)) {
      const active = once(socket, "presence");
      activate(socket);
      await active;
    }
    const farState = until(sockets[2], "world-state", (state) => state.selfId && state.players.length === 1 && state.players[0]?.nickname === "Guest-003");
    activate(sockets[2]);

    await expect(Promise.all([nearState, farState])).resolves.toEqual([
      expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ nickname: "Guest-001" }), expect.objectContaining({ nickname: "Guest-002" })]) }),
      expect.objectContaining({ players: [expect.objectContaining({ nickname: "Guest-003" })] }),
    ]);
    sockets.forEach((socket) => socket.close());
  });

  it("전체 미니맵은 저주기로 먼 활성 사용자와 게임 중 상태를 칸 중심 좌표로 보낸다", async () => {
    const spawns = [{ x: 1_000, y: 1_000 }, { x: 1_300, y: 1_000 }, { x: 7_000, y: 7_000 }];
    game = createGameServer(new Set(["map-a", "map-b", "map-c"]), {
      worldTickMs: 10, worldMinimapIntervalMs: 20, worldSpawn: (index) => spawns[index]!,
    });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const [a, b, c] = ["map-a", "map-b", "map-c"].map((token) => client(url, { auth: { token } }));
    await Promise.all([once(a, "connect"), once(b, "connect"), once(c, "connect")]);
    for (const socket of [a, b, c]) {
      const presence = once(socket, "presence"); activate(socket); await presence;
    }
    const nearbyOnly = await until(a, "world-state", (state) => state.players.length === 2);
    expect(nearbyOnly.players.some((player: any) => player.nickname === "Guest-003")).toBe(false);
    c.emit("game-presence", { mode: "ai" });
    c.emit("ai-spectator-state", {
      players: [{ x: 200, y: 400 }, { x: 600, y: 400 }], ball: { x: 400, y: 400, vx: 0, vy: 0 },
      projectiles: [], score: [0, 0], status: "playing", kickoffRemaining: 0, t: 1,
    });

    const minimap = await until(a, "world-minimap", (payload) => payload.players.length === 3 && payload.players.some((player: any) => player.nickname === "Guest-003" && player.state === "playing"));
    expect(minimap.intervalMs).toBe(20);
    expect(minimap.precision).toBe("sector-center");
    expect(minimap.players).toEqual(expect.arrayContaining([
      expect.objectContaining({ nickname: "Guest-001", x: 1_200, y: 1_200, state: "active" }),
      expect.objectContaining({ nickname: "Guest-003", x: 6_800, y: 6_800, state: "playing" }),
    ]));
    a.close(); b.close(); c.close();
  });

  it("서버가 측정한 RTT를 평활화해 상대 캐릭터의 pingMs로 전달한다", async () => {
    game = createGameServer(new Set(["ping-fast", "ping-slow"]), { worldTickMs: 10, worldPingIntervalMs: 20, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const fast = client(url, { auth: { token: "ping-fast" } });
    const slow = client(url, { auth: { token: "ping-slow" } });
    await Promise.all([once(fast, "connect"), once(slow, "connect")]);
    fast.on("world-ping", (nonce) => fast.emit("world-pong", nonce));
    slow.on("world-ping", (nonce) => setTimeout(() => slow.emit("world-pong", nonce), 25));
    activate(fast, slow);

    const measured = await until(fast, "world-state", (state) => {
      const opponent = state.players.find((player: { nickname: string }) => player.nickname === "Guest-002");
      return typeof opponent?.pingMs === "number" && opponent.pingMs >= 15;
    });
    expect(measured.players.find((player: { nickname: string }) => player.nickname === "Guest-002").pingMs).toBeLessThan(100);
    fast.close(); slow.close();
  });

  it("월드에서 오래 무조작인 플레이어는 주변 world-state에서도 blind 처리된다", async () => {
    game = createGameServer(new Set(["world-idle", "world-awake"]), { worldTickMs: 10, queueAfkMs: 300, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const idle = client(url, { auth: { token: "world-idle" } });
    const awake = client(url, { auth: { token: "world-awake" } });
    await Promise.all([once(idle, "connect"), once(awake, "connect")]);
    const bothVisible = until(awake, "world-state", (state) => state.players.length === 2);
    activate(idle, awake);
    await bothVisible;
    const idleBecameBlind = until(awake, "world-state", (state) => state.players.length === 1);
    const idlePresence = until(idle, "presence", (presence) => presence.state === "inactive");
    await new Promise((resolve) => setTimeout(resolve, 160));
    awake.emit("player-active");

    await expect(Promise.all([idleBecameBlind, idlePresence])).resolves.toEqual([
      expect.objectContaining({ players: [expect.objectContaining({ nickname: "Guest-002" })] }),
      { state: "inactive", reason: "afk" },
    ]);
    idle.close(); awake.close();
  });

  it("가까운 상대에게 대전을 신청하고 상대가 수락해야 같은 권위 경기로 워프한다", async () => {
    game = createGameServer(new Set(["challenge-a", "challenge-b"]), { worldTickMs: 10, matchStartDelayMs: 0, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "challenge-a" } });
    const b = client(url, { auth: { token: "challenge-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    const world = until(a, "world-state", (state) => state.players.length === 2);
    activate(a, b);
    const state = await world;
    const target = state.players.find((player: { id: string }) => player.id !== state.selfId);
    const received = once(b, "challenge-received");
    a.emit("challenge-request", { targetId: target.id });
    const challenge = await received;
    expect(challenge).toMatchObject({ from: { nickname: "Guest-001" }, expiresInMs: 10_000 });

    const aStarted = once(a, "match-start");
    const bStarted = once(b, "match-start");
    b.emit("challenge-response", { challengeId: challenge.challengeId, accept: true });
    const [aMatch, bMatch] = await Promise.all([aStarted, bStarted]);
    expect(aMatch.sessionId).toBe(bMatch.sessionId);
    expect(aMatch.sessionId).toMatch(/^online-/);
    a.close(); b.close();
  });

  it("월드 로비 채팅은 안전한 닉네임으로 실시간 중계하고 최근 기록을 전달한다", async () => {
    game = createGameServer(new Set(["chat-a", "chat-b", "chat-c"]));
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "chat-a" } });
    const b = client(url, { auth: { token: "chat-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const received = once(b, "lobby-chat");
    a.emit("lobby-chat", "  안녕하세요 <script>  ");
    await expect(received).resolves.toMatchObject({ playerId: expect.any(String), nickname: "Guest-001", message: "안녕하세요 script" });

    const c = client(url, { auth: { token: "chat-c" } });
    const history = once(c, "lobby-chat-history");
    await once(c, "connect");
    await expect(history).resolves.toEqual([expect.objectContaining({ message: "안녕하세요 script" })]);
    a.close(); b.close(); c.close();
  });

  it("지역 채팅은 같은 칸과 인접 칸에 전달하고 그 밖의 칸은 차단한다", async () => {
    const spawns = [{ x: 1_000, y: 1_000 }, { x: 1_300, y: 1_200 }, { x: 1_700, y: 1_700 }, { x: 3_000, y: 1_000 }];
    game = createGameServer(new Set(["sector-a", "sector-b", "sector-c", "sector-d"]), { worldTickMs: 10, worldSpawn: (index) => spawns[index]! });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const [a, b, c, d] = ["sector-a", "sector-b", "sector-c", "sector-d"].map((token) => client(url, { auth: { token } }));
    await Promise.all([once(a, "connect"), once(b, "connect"), once(c, "connect"), once(d, "connect")]);
    for (const socket of [a, b, c, d]) {
      const presence = once(socket, "presence");
      activate(socket);
      await presence;
    }
    await until(a, "world-state", (state) => state.players.length >= 2);
    let dSawSector = false;
    d.on("lobby-chat", (entry) => { if (entry.message === "B2에서 만나요") dSawSector = true; });
    const sameSector = until(b, "lobby-chat", (entry) => entry.message === "B2에서 만나요");
    const adjacentSector = until(c, "lobby-chat", (entry) => entry.message === "B2에서 만나요");

    a.emit("lobby-chat", { message: "B2에서 만나요", scope: "sector" });

    await expect(Promise.all([sameSector, adjacentSector])).resolves.toEqual([
      expect.objectContaining({ scope: "sector", sector: "B2" }),
      expect.objectContaining({ scope: "sector", sector: "B2" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(dSawSector).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 620));
    const worldForB = until(b, "lobby-chat", (entry) => entry.message === "월드 공지");
    const worldForC = until(c, "lobby-chat", (entry) => entry.message === "월드 공지");
    const worldForD = until(d, "lobby-chat", (entry) => entry.message === "월드 공지");
    a.emit("lobby-chat", { message: "월드 공지", scope: "world" });
    await expect(Promise.all([worldForB, worldForC, worldForD])).resolves.toEqual([
      expect.objectContaining({ scope: "world" }),
      expect.objectContaining({ scope: "world" }),
      expect.objectContaining({ scope: "world" }),
    ]);
    a.close(); b.close(); c.close(); d.close();
  });

  it("월드에서 AI 경기 중인 플레이어를 표시하고 실시간 관전한다", async () => {
    game = createGameServer(new Set(["ai-host", "ai-spectator"]), { worldTickMs: 10, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const host = client(url, { auth: { token: "ai-host" } });
    const spectator = client(url, { auth: { token: "ai-spectator" } });
    await Promise.all([once(host, "connect"), once(spectator, "connect")]);
    activate(host, spectator);
    const initial = await until(spectator, "world-state", (state) => state.players.length === 2);
    const hostId = initial.players.find((player: { id: string }) => player.id !== initial.selfId).id;
    const aiState = {
      players: [{ x: 200, y: 400 }, { x: 600, y: 400 }], ball: { x: 400, y: 400, vx: 0, vy: 0 },
      projectiles: [], score: [0, 0], status: "playing", kickoffRemaining: 0, t: 1,
    };
    host.emit("game-presence", { mode: "ai" });
    host.emit("ai-spectator-state", aiState);
    await expect(until(spectator, "world-state", (state) => state.players.some((player: any) => player.id === hostId && player.activity?.kind === "ai"))).resolves.toEqual(
      expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ id: hostId, activity: { kind: "ai", opponent: "AI" } })]) }),
    );

    const started = once(spectator, "spectate-start");
    spectator.emit("spectate-request", { targetId: hostId });
    await expect(started).resolves.toMatchObject({ mode: "ai", names: ["Guest-001", "AI"], state: aiState });
    const nextState = { ...aiState, ball: { ...aiState.ball, x: 430 }, t: 2 };
    const relayed = once(spectator, "spectate-state");
    host.emit("ai-spectator-state", nextState);
    await expect(relayed).resolves.toMatchObject({ ball: { x: 430 }, t: 2 });
    spectator.emit("spectate-leave");
    host.close(); spectator.close();
  });

  it("월드의 온라인 경기 참가자는 상대 이름을 표시하고 제3자가 권위 상태를 관전한다", async () => {
    game = createGameServer(new Set(["watch-a", "watch-b", "watch-c"]), { worldTickMs: 10, matchStartDelayMs: 0, tickMs: 5, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const [a, b, watcher] = ["watch-a", "watch-b", "watch-c"].map((token) => client(url, { auth: { token } }));
    await Promise.all([once(a, "connect"), once(b, "connect"), once(watcher, "connect")]);
    activate(a, b, watcher);
    const beforeMatch = await until(watcher, "world-state", (state) => state.players.length === 3);
    const aId = beforeMatch.players.find((player: any) => player.nickname === "Guest-001").id;
    const startedA = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    await startedA;
    await expect(until(watcher, "world-state", (state) => state.players.some((player: any) => player.id === aId && player.activity?.kind === "online"))).resolves.toEqual(
      expect.objectContaining({ players: expect.arrayContaining([expect.objectContaining({ id: aId, activity: { kind: "online", opponent: "Guest-002" } })]) }),
    );
    const spectateStart = once(watcher, "spectate-start");
    watcher.emit("spectate-request", { targetId: aId });
    await expect(spectateStart).resolves.toMatchObject({ mode: "online", names: ["Guest-001", "Guest-002"], state: { status: "playing" } });
    await expect(once(watcher, "spectate-state")).resolves.toMatchObject({ status: "playing" });
    a.close(); b.close(); watcher.close();
  });

  it("리더보드는 서버가 확정한 온라인 결과만 실시간 반영한다", async () => {
    game = createGameServer(new Set(["rank-a", "rank-b"]), { matchStartDelayMs: 0 });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "rank-a" } });
    const b = client(url, { auth: { token: "rank-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const started = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    await started;
    const leaderboard = until(b, "leaderboard", (rows: Array<{ wins: number }>) => rows.some((row) => row.wins === 1));

    a.emit("leave");

    await expect(leaderboard).resolves.toEqual([
      expect.objectContaining({ rank: 1, nickname: "Guest-002", points: 3, wins: 1, losses: 0 }),
      expect.objectContaining({ rank: 2, nickname: "Guest-001", points: 0, wins: 0, losses: 1 }),
    ]);
    a.close(); b.close();
  });

  it("리더보드는 현재 활성 사용자만 표시하고 비활성화 즉시 제거한다", async () => {
    game = createGameServer(new Set(["presence-rank-a", "presence-rank-b"]));
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "presence-rank-a" }, autoConnect: false });
    const b = client(url, { auth: { token: "presence-rank-b" }, autoConnect: false });
    const initial = once(a, "leaderboard");
    a.connect();
    await once(a, "connect");
    await expect(initial).resolves.toEqual([]);
    b.connect();
    await once(b, "connect");

    const oneActive = until(b, "leaderboard", (rows) => rows.length === 1);
    activate(a);
    await expect(oneActive).resolves.toEqual([expect.objectContaining({ nickname: "Guest-001" })]);

    const noneActive = until(b, "leaderboard", (rows) => rows.length === 0);
    a.emit("player-inactive");
    await expect(noneActive).resolves.toEqual([]);
    a.close(); b.close();
  });

  it("새로 접속하면 이전 방문의 리더보드 점수는 초기화된다", async () => {
    game = createGameServer(new Set(["rank-a", "rank-b"]), { matchStartDelayMs: 0 });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "rank-a" } });
    const b = client(url, { auth: { token: "rank-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const started = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    await started;
    const scored = until(b, "leaderboard", (rows: Array<{ wins: number }>) => rows.some((row) => row.wins === 1));
    a.emit("leave");
    await scored;

    // 승자가 완전히 나갔다가 다시 접속하면 점수 0으로 시작한다.
    b.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bAgain = client(url, { auth: { token: "rank-b" } });
    const freshBoard = once(bAgain, "leaderboard");
    await once(bAgain, "connect");
    const rows: Array<{ points: number; wins: number }> = await freshBoard;
    // 승자의 3점·1승이 사라지고 모두 0점에서 다시 시작해야 한다.
    expect(rows.some((row) => row.points > 0 || row.wins > 0)).toBe(false);

    a.close(); bAgain.close();
  });

  it("대전 신청을 거절하거나 시간이 지나면 경기 없이 양쪽이 월드에 남는다", async () => {
    game = createGameServer(new Set(["decline-a", "decline-b"]), { worldTickMs: 10, challengeTimeoutMs: 40, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "decline-a" } });
    const b = client(url, { auth: { token: "decline-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    const world = until(a, "world-state", (state) => state.players.length === 2);
    activate(a, b);
    const state = await world;
    const targetId = state.players.find((player: { id: string }) => player.id !== state.selfId).id;
    const firstRequest = once(b, "challenge-received");
    a.emit("challenge-request", { targetId });
    const first = await firstRequest;
    const declined = once(a, "challenge-status");
    b.emit("challenge-response", { challengeId: first.challengeId, accept: false });
    await expect(declined).resolves.toMatchObject({ challengeId: first.challengeId, state: "declined" });

    const secondRequest = once(b, "challenge-received");
    a.emit("challenge-request", { targetId });
    const second = await secondRequest;
    const expired = until(a, "challenge-status", (status) => status.challengeId === second.challengeId && status.state === "expired");
    await expect(expired).resolves.toMatchObject({ state: "expired" });
    await expect(until(a, "world-state", (next) => next.players.length === 2)).resolves.toBeTruthy();
    a.close(); b.close();
  });

  it("월드 대전 신청자는 수락 전에 자신의 신청을 취소할 수 있다", async () => {
    game = createGameServer(new Set(["cancel-a", "cancel-b"]), { worldTickMs: 10, worldSpawn: clusteredWorldSpawn });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "cancel-a" } });
    const b = client(url, { auth: { token: "cancel-b" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const targetState = await until(a, "world-state", (state) => state.players.length === 2);
    const targetId = targetState.players.find((player: { id: string }) => player.id !== targetState.selfId).id;
    const received = once(b, "challenge-received");
    a.emit("challenge-request", { targetId });
    const challenge = await received;

    const requesterCancelled = until(a, "challenge-status", (status) => status.challengeId === challenge.challengeId && status.state === "cancelled");
    const receiverCancelled = until(b, "challenge-status", (status) => status.challengeId === challenge.challengeId && status.state === "cancelled");
    a.emit("challenge-cancel", { challengeId: challenge.challengeId });

    await expect(Promise.all([requesterCancelled, receiverCancelled])).resolves.toHaveLength(2);
    a.close(); b.close();
  });

  it("온라인 발사 입력은 권위 세션의 공용 게이지와 충격탄 상태로 동기화된다", async () => {
    game = createGameServer(new Set(["fire-one", "fire-two"]), { matchStartDelayMs: 10, tickMs: 5 });
    const port = await game.listen();
    const url = `http://127.0.0.1:${port}`;
    const a = client(url, { auth: { token: "fire-one" } });
    const b = client(url, { auth: { token: "fire-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const started = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const start = await started;
    const index = start.playerIndex as 0 | 1;
    await until(a, "state", (state) => state.kickoffRemaining === 0);

    const fired = until(a, "state", (state) => state.players[index].abilityGauge < 0.1 && state.projectiles.length === 1);
    a.emit("input", { moveX: index === 0 ? 1 : -1, moveY: 0, dash: false, fire: true });
    await expect(fired).resolves.toMatchObject({ projectiles: [{ owner: index }] });

    a.close(); b.close();
  });

  it("유효 토큰 두 명을 같은 메모리 세션에 연결하고 상태와 결과를 동기화한다", async () => {
    game = createGameServer(new Set(["one", "two"]));
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "one" } }); const b = client(url, { auth: { token: "two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    a.emit("join-match", "match-1"); b.emit("join-match", "match-1");
    await Promise.all([once(a, "session"), once(b, "session")]);
    const aState = once(a, "state"), bState = once(b, "state");
    a.emit("input", { moveX: 1, moveY: 0, dash: false });
    await expect(aState).resolves.toEqual({ input: { moveX: 1, moveY: 0, dash: false } });
    await expect(bState).resolves.toEqual({ input: { moveX: 1, moveY: 0, dash: false } });
    a.close(); b.close();
  });

  it("대기열의 두 익명 플레이어를 서버 생성 온라인 세션으로 자동 매칭한다", async () => {
    game = createGameServer(new Set(["queue-one", "queue-two"]), { matchStartDelayMs: 20, tickMs: 10 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "queue-one" } });
    const b = client(url, { auth: { token: "queue-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);

    const foundA = once(a, "match-found");
    const foundB = once(b, "match-found");
    a.emit("join-queue");
    b.emit("join-queue");
    const [aFound, bFound] = await Promise.all([foundA, foundB]);
    expect(aFound.matchId).toBe(bFound.matchId);
    expect(aFound.startsInMs).toBe(20);
    expect(aFound.opponent.nickname).not.toBe(bFound.opponent.nickname);

    const [aStart, bStart] = await Promise.all([once(a, "match-start"), once(b, "match-start")]);
    expect(aStart.sessionId).toBe(bStart.sessionId);
    expect([aStart.playerIndex, bStart.playerIndex].sort()).toEqual([0, 1]);
    expect(aStart.state.players).toHaveLength(2);

    const movedA = until(a, "state", (state) => state.players[aStart.playerIndex].x > aStart.state.players[aStart.playerIndex].x);
    const movedB = until(b, "state", (state) => state.players[aStart.playerIndex].x > aStart.state.players[aStart.playerIndex].x);
    a.emit("input", { moveX: 1, moveY: 0, dash: false });
    const [stateA, stateB] = await Promise.all([movedA, movedB]);
    expect(stateA).toEqual(stateB);

    a.close(); b.close();
  });

  it("시작 대기 중 상대가 끊기면 이미 대기 중인 플레이어와 즉시 다시 매칭한다", async () => {
    game = createGameServer(new Set(["drop-one", "drop-two", "waiting-three"]), { matchStartDelayMs: 200, tickMs: 10 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "drop-one" } });
    const b = client(url, { auth: { token: "drop-two" } });
    const c = client(url, { auth: { token: "waiting-three" } });
    await Promise.all([once(a, "connect"), once(b, "connect"), once(c, "connect")]);
    activate(a, b, c);

    const firstFound = once(b, "match-found");
    a.emit("join-queue");
    b.emit("join-queue");
    const first = await firstFound;
    c.emit("join-queue");
    const cancelled = once(b, "match-cancelled");
    const foundAgain = until(b, "match-found", (match) => match.matchId !== first.matchId);
    const foundC = once(c, "match-found");
    a.close();

    await expect(cancelled).resolves.toMatchObject({ reason: "opponent-disconnected" });
    const [bMatch, cMatch] = await Promise.all([foundAgain, foundC]);
    expect(bMatch.matchId).toBe(cMatch.matchId);

    b.close(); c.close();
  });

  it("온라인 이동도 입력 해제 뒤 오프라인과 같은 관성과 감속을 유지한다", async () => {
    game = createGameServer(new Set(["inertia-one", "inertia-two"]), { matchStartDelayMs: 10, tickMs: 10 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "inertia-one" } });
    const b = client(url, { auth: { token: "inertia-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const aStartPromise = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const start = await aStartPromise;
    const index = start.playerIndex as 0 | 1;

    const accelerated = until(a, "state", (state) => state.players[index].x > start.state.players[index].x + 18);
    a.emit("input", { moveX: 1, moveY: 0, dash: false });
    await accelerated;
    a.emit("input", { moveX: 0, moveY: 0, dash: false });
    const firstAfterRelease = await once(a, "state");
    const secondAfterRelease = await once(a, "state");
    expect(secondAfterRelease.players[index].x).toBeGreaterThan(firstAfterRelease.players[index].x);

    a.close(); b.close();
  });

  it("권위 서버도 첫 틱 급발진 없이 0.25초 안에 빠른 속도로 반응한다", async () => {
    game = createGameServer(new Set(["response-one", "response-two"]), { matchStartDelayMs: 10, tickMs: 10 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "response-one" } });
    const b = client(url, { auth: { token: "response-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const startPromise = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const start = await startPromise;
    const index = start.playerIndex as 0 | 1;

    const firstMoved = until(a, "state", (state) => state.players[index].x > start.state.players[index].x);
    a.emit("input", { moveX: 1, moveY: 0, dash: false });
    const first = await firstMoved;
    expect(first.players[index].x - start.state.players[index].x).toBeLessThan(0.1);
    const responsive = await until(a, "state", (state) => state.players[index].vx > 40);
    expect(responsive.players[index].vx).toBeGreaterThan(40);
    expect(responsive.t - start.state.t).toBeLessThanOrEqual(0.25);

    a.close(); b.close();
  });

  it("실시간 매칭 기록과 완료 통계를 안전한 공개 ID와 닉네임으로 갱신한다", async () => {
    game = createGameServer(new Set(["one", "two"]));
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const admin = client(`${url}/admin`);
    await once(admin, "connect");
    const a = client(url, { auth: { token: "one" } });
    const b = client(url, { auth: { token: "two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);

    const liveSnapshot = until(admin, "admin-snapshot", (value) => value.stats.liveMatches === 1);
    a.emit("join-match", "private-room-secret");
    b.emit("join-match", "private-room-secret");
    const live = await liveSnapshot;
    expect(live.stats).toMatchObject({ totalMatches: 1, liveMatches: 1, completedMatches: 0 });
    expect(live.recentMatches[0]).toMatchObject({
      id: "MATCH-000001",
      status: "live",
      score: [0, 0],
    });
    expect(live.recentMatches[0].players.sort()).toEqual(["Guest-001", "Guest-002"]);
    expect(JSON.stringify(live)).not.toContain("private-room-secret");
    expect(JSON.stringify(live)).not.toContain("one");
    expect(JSON.stringify(live)).not.toContain("two");

    const completedSnapshot = until(admin, "admin-snapshot", (value) => value.stats.completedMatches === 1);
    a.emit("result", { score: [3, 2], result: "token leak must never be public" });
    const completed = await completedSnapshot;
    expect(completed.stats).toMatchObject({ liveMatches: 0, completedMatches: 1 });
    expect(completed.recentMatches[0]).toMatchObject({ status: "completed", score: [3, 2] });
    expect(completed.recentMatches[0].result).toMatch(/^Guest-00[12] 승리$/);
    expect(JSON.stringify(completed)).not.toContain("token leak");

    a.close(); b.close(); admin.close();
  });

  it("온라인 경기에서 공을 골로 밀어 넣으면 점수와 킥오프가 반영된다", async () => {
    game = createGameServer(new Set(["goal-one", "goal-two"]), { matchStartDelayMs: 10, tickMs: 5 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "goal-one" } });
    const b = client(url, { auth: { token: "goal-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const startPromise = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const start = await startPromise;
    const index = start.playerIndex as 0 | 1;

    // 상대는 위쪽으로 비켜서고, 공격자는 중앙의 공을 상대 골대까지 계속 민다.
    const towardOpponentGoal = index === 0 ? 1 : -1;
    const chase = setInterval(() => {
      a.emit("input", { moveX: towardOpponentGoal, moveY: 0, dash: false });
      b.emit("input", { moveX: 0, moveY: -1, dash: false });
    }, 50);
    const scorer = index;
    try {
      const scored = await until(a, "state", (state) => state.score[scorer] >= 1);
      expect(scored.score[scorer]).toBe(1);
      expect(scored.goalCount).toBe(1);
      expect(scored.kickoffRemaining).toBeGreaterThan(0);
    } finally {
      clearInterval(chase);
    }
    a.close(); b.close();
  }, 20_000);

  it("경기가 끝난 두 플레이어는 다시 대기열에 들어가 새 경기를 시작할 수 있다", async () => {
    game = createGameServer(new Set(["again-one", "again-two"]), { matchStartDelayMs: 10, tickMs: 5 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "again-one" } });
    const b = client(url, { auth: { token: "again-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);

    const firstStart = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const first = await firstStart;
    const firstResults = [once(a, "result"), once(b, "result")];
    a.emit("leave");
    await Promise.all(firstResults);

    const secondStartA = once(a, "match-start");
    const secondStartB = once(b, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const [secondA, secondB] = await Promise.all([secondStartA, secondStartB]);
    expect(secondA.sessionId).toBe(secondB.sessionId);
    expect(secondA.sessionId).not.toBe(first.sessionId);

    a.close(); b.close();
  });

  it("온라인 경기 중 나가기는 즉시 몰수 종료로 확정하고 결과를 알린다", async () => {
    game = createGameServer(new Set(["quit-one", "quit-two"]), { matchStartDelayMs: 10, tickMs: 5 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "quit-one" } });
    const b = client(url, { auth: { token: "quit-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);

    a.emit("join-queue"); b.emit("join-queue");
    await Promise.all([once(a, "match-start"), once(b, "match-start")]);
    const forfeit = once(b, "forfeit");
    const result = once(b, "result");
    a.emit("leave");
    await forfeit;
    await expect(result).resolves.toMatchObject({ result: "몰수 종료" });

    a.close(); b.close();
  });

  it("경기 중 이모지는 화이트리스트·속도 제한을 거쳐 세션에만 중계된다", async () => {
    game = createGameServer(new Set(["emo-one", "emo-two"]), { matchStartDelayMs: 10, tickMs: 10 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const a = client(url, { auth: { token: "emo-one" } });
    const b = client(url, { auth: { token: "emo-two" } });
    await Promise.all([once(a, "connect"), once(b, "connect")]);
    activate(a, b);
    const startPromise = once(a, "match-start");
    a.emit("join-queue"); b.emit("join-queue");
    const start = await startPromise;

    const received: Array<{ playerIndex: number; emoji: string }> = [];
    b.on("emote", (payload) => received.push(payload));
    a.emit("emote", 3);
    a.emit("emote", 0); // 600ms 안의 연타는 무시
    a.emit("emote", 99); // 화이트리스트 밖 무시
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received).toEqual([{ playerIndex: start.playerIndex, emoji: "🔥" }]);

    a.close(); b.close();
  });

  it("오래 조작이 없는 소켓은 대기열에서 제외되어 매칭되지 않는다", async () => {
    game = createGameServer(new Set(["afk-one", "afk-two"]), { matchStartDelayMs: 10, tickMs: 10, queueAfkMs: 150 });
    const port = await game.listen();
    const url = `http://localhost:${port}`;
    const idler = client(url, { auth: { token: "afk-one" } });
    await once(idler, "connect");
    activate(idler);
    const idlerKicked = until(idler, "queue-status", (status: { reason?: string }) => status.reason === "afk");
    idler.emit("join-queue");
    await new Promise((resolve) => setTimeout(resolve, 250)); // 방치 시간 경과

    const late = client(url, { auth: { token: "afk-two" } });
    await once(late, "connect");
    activate(late);
    let matched = false;
    idler.once("match-found", () => { matched = true; });
    late.emit("join-queue");
    const status = await idlerKicked;
    expect(status).toMatchObject({ state: "idle", reason: "afk" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(matched).toBe(false);

    idler.close(); late.close();
  });

  it("나가기와 연결 끊김 상태를 상대에게 전달한다", async () => {
    game = createGameServer(new Set(["one", "two"])); const port=await game.listen(); const url=`http://localhost:${port}`;
    const a=client(url,{auth:{token:"one"}}), b=client(url,{auth:{token:"two"}}); await Promise.all([once(a,"connect"),once(b,"connect")]); a.emit("join-match","m"); b.emit("join-match","m"); await Promise.all([once(a,"session"),once(b,"session")]);
    const forfeit=once(b,"forfeit"); a.emit("leave"); await expect(forfeit).resolves.toMatchObject({winnerSocketId:a.id});
    const grace=once(b,"reconnect-grace"); a.close(); await expect(grace).resolves.toMatchObject({seconds:15}); b.close();
  });
});
