import { Server } from "socket.io";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { advanceSimulation, createSimInput, createSimState, } from "./simulation.js";
const nicknameAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const round2 = (value) => Math.round(value * 100) / 100;
/**
 * 60Hz로 나가는 상태를 소수 2자리로 반올림해 직렬화한다.
 * 부동소수점 오차가 만드는 17자리 숫자를 그대로 JSON에 실으면
 * 패킷이 몇 배로 커진다(MultiOgarII의 바이너리 프로토콜에서 얻은 교훈).
 */
function serializeState(state) {
    return {
        players: state.players.map((player) => ({
            x: round2(player.x),
            y: round2(player.y),
            vx: round2(player.vx),
            vy: round2(player.vy),
            dashCooldown: round2(player.dashCooldown),
            dashTime: round2(player.dashTime),
            justDashTime: round2(player.justDashTime),
            face: player.face,
            moveX: round2(player.moveX),
            moveY: round2(player.moveY),
        })),
        ball: { x: round2(state.ball.x), y: round2(state.ball.y), vx: round2(state.ball.vx), vy: round2(state.ball.vy) },
        score: state.score,
        remainingSeconds: round2(state.remainingSeconds),
        status: state.status,
        kickoffRemaining: round2(state.kickoffRemaining),
        lastScorer: state.lastScorer,
        goalCount: state.goalCount,
        /** 시뮬레이션 시각(초, ms 정밀도). 클라이언트 스냅샷 보간의 시간축. */
        t: Math.round(state.simTime * 1000) / 1000,
    };
}
function createNickname() {
    const bytes = randomBytes(4);
    return `Blob-${Array.from(bytes, (value) => nicknameAlphabet[value % nicknameAlphabet.length]).join("")}`;
}
export function createGameServer(validTokens = new Set(), options = {}) {
    const matchStartDelayMs = options.matchStartDelayMs ?? 3000;
    const tickMs = options.tickMs ?? (1000 / 60);
    // 60Hz 상태 전송: 클라이언트 보간 창이 짧아져 킥·이동 반응이 화면에 더 빨리 보인다.
    const broadcastEveryTicks = options.broadcastEveryTicks ?? 1;
    const profileNames = new Map();
    const socketNames = new Map();
    const publicMatches = new Map();
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
    let io;
    const queuedSockets = [];
    const pendingMatches = new Map();
    const onlineSessions = new Map();
    const socketSessionIds = new Map();
    /** 마지막 실제 조작(이동·대시·이모지) 시각. 방치된 탭을 매칭에서 걸러낸다. */
    const socketActivityAt = new Map();
    const socketEmoteAt = new Map();
    const QUEUE_AFK_MS = options.queueAfkMs ?? 90_000;
    const EMOTES = ["👍", "😄", "😢", "🔥"];
    const roomAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    /** 로비 방: 코드 → 호스트·게스트 소켓. 게스트가 들어오면 두 명이 고정된다. */
    const rooms = new Map();
    const socketRoomCodes = new Map();
    /** 같은 네트워크 판별용 공인 IP와, socket ID를 노출하지 않기 위한 공개 피어 ID. */
    const socketPublicIps = new Map();
    const socketPeerIds = new Map();
    const peerIdSockets = new Map();
    /**
     * 네트워크 그룹 ID: 같은 공인 IP면 같은 값. IP 자체는 노출하지 않도록
     * 서버 실행마다 바뀌는 솔트로 해시한다. 클라이언트는 이 값으로
     * P2P 로비(같은 네트워크 방)와 일반 로비를 구분한다.
     */
    const netIdSalt = randomBytes(16).toString("base64url");
    const netIdOf = (ip) => ip ? createHash("sha1").update(netIdSalt + ip).digest("base64url").slice(0, 10) : "";
    /** 참가자를 기다리는 공개 방 목록(코드·호스트 닉네임·네트워크 그룹만 노출). */
    const roomListPayload = () => [...rooms.entries()]
        .filter(([, room]) => !room.guestId)
        .map(([code, room]) => ({
        code,
        host: socketNames.get(room.hostId) ?? "Guest",
        netId: netIdOf(socketPublicIps.get(room.hostId)),
    }));
    const broadcastRoomList = () => io.emit("room-list", roomListPayload());
    /** 같은 공인 IP(= 같은 네트워크로 추정)의 다른 접속자 목록을 각자에게 보낸다. */
    const broadcastLanPeers = (ip) => {
        if (!ip)
            return;
        const members = [...socketPublicIps.entries()].filter(([, memberIp]) => memberIp === ip);
        for (const [socketId] of members) {
            const peers = members
                .filter(([otherId]) => otherId !== socketId)
                .map(([otherId]) => ({ peerId: socketPeerIds.get(otherId) ?? "", nickname: socketNames.get(otherId) ?? "Guest" }))
                .filter((peer) => peer.peerId);
            io.sockets.sockets.get(socketId)?.emit("lan-peers", peers);
        }
    };
    const leaveRoom = (socketId) => {
        const code = socketRoomCodes.get(socketId);
        if (!code)
            return;
        socketRoomCodes.delete(socketId);
        const room = rooms.get(code);
        if (!room)
            return;
        if (room.hostId === socketId) {
            rooms.delete(code);
            if (room.guestId) {
                socketRoomCodes.delete(room.guestId);
                io.sockets.sockets.get(room.guestId)?.emit("room-closed", { reason: "host-left" });
            }
        }
        else if (room.guestId === socketId) {
            room.guestId = null;
            io.sockets.sockets.get(room.hostId)?.emit("room-peer-left", {});
        }
        broadcastRoomList();
    };
    const snapshot = () => ({
        updatedAt: new Date().toISOString(),
        stats: { ...stats },
        recentMatches: [...publicMatches.values()].slice(-50).reverse(),
    });
    // 입력 폭주가 스냅샷 직렬화 폭주로 이어지지 않도록 짧게 병합해 내보낸다.
    let snapshotTimer = null;
    let snapshotDirty = false;
    const broadcastSnapshot = () => {
        if (snapshotTimer) {
            snapshotDirty = true;
            return;
        }
        io?.of("/admin").emit("admin-snapshot", snapshot());
        snapshotTimer = setTimeout(() => {
            snapshotTimer = null;
            if (!snapshotDirty)
                return;
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
            stats.totalProfiles += 1;
            broadcastSnapshot();
            response.writeHead(201, { "content-type": "application/json" });
            response.end(JSON.stringify({ token, nickname }));
            return;
        }
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
    });
    io = new Server(http, { cors: { origin: "*" } });
    const sessions = new Map();
    const registerPublicMatch = (sessionId, participants) => {
        if (publicMatches.has(sessionId))
            return;
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
    const completePublicMatch = (sessionId, state) => {
        const match = publicMatches.get(sessionId);
        if (!match || match.status !== "live")
            return;
        match.status = "completed";
        match.endedAt = new Date().toISOString();
        match.score = [...state.score];
        match.result = state.score[0] === state.score[1]
            ? "무승부"
            : `${match.players[state.score[0] > state.score[1] ? 0 : 1] ?? "Guest"} 승리`;
        stats.liveMatches -= 1;
        stats.completedMatches += 1;
        broadcastSnapshot();
    };
    const beginOnlineSession = (matchId) => {
        const pending = pendingMatches.get(matchId);
        if (!pending)
            return;
        pendingMatches.delete(matchId);
        const firstSocket = io.sockets.sockets.get(pending.socketIds[0]);
        const secondSocket = io.sockets.sockets.get(pending.socketIds[1]);
        if (!firstSocket || !secondSocket)
            return;
        const sockets = [firstSocket, secondSocket];
        const sessionId = `online-${randomBytes(12).toString("base64url")}`;
        const state = createSimState();
        if (options.matchSeconds !== undefined)
            state.remainingSeconds = options.matchSeconds;
        const session = {
            id: sessionId,
            socketIds: pending.socketIds,
            inputs: [createSimInput(), createSimInput()],
            state,
            interval: undefined,
            tickCount: 0,
            accumulator: 0,
            lastTickAt: performance.now(),
            frozen: false,
        };
        onlineSessions.set(sessionId, session);
        sessions.set(sessionId, new Set(pending.socketIds));
        registerPublicMatch(sessionId, pending.socketIds);
        for (const [index, matchedSocket] of sockets.entries()) {
            matchedSocket.join(sessionId);
            socketSessionIds.set(matchedSocket.id, sessionId);
            matchedSocket.emit("match-start", {
                matchId,
                sessionId,
                playerIndex: index,
                opponent: { nickname: socketNames.get(sockets[index === 0 ? 1 : 0].id) ?? "Guest" },
                state: serializeState(state),
            });
        }
        session.interval = setInterval(() => {
            // setInterval은 밀릴 수 있으므로 벽시계 경과분을 그대로 진행해
            // 경기 시간이 실제 시간보다 느리게 흐르지 않게 한다.
            const now = performance.now();
            const elapsedSeconds = (now - session.lastTickAt) / 1000;
            session.lastTickAt = now;
            if (session.frozen)
                return;
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
                io.to(sessionId).emit("state", serializeState(session.state));
            }
            if (session.state.status === "finished") {
                clearInterval(session.interval);
                completePublicMatch(sessionId, session.state);
                io.to(sessionId).emit("result", { score: session.state.score, result: publicMatches.get(sessionId)?.result });
                onlineSessions.delete(sessionId);
                for (const socketId of session.socketIds) {
                    if (socketSessionIds.get(socketId) === sessionId)
                        socketSessionIds.delete(socketId);
                }
            }
        }, tickMs);
    };
    const forfeitOnlineSession = (session, leaverSocketId) => {
        clearInterval(session.interval);
        if (session.graceTimer)
            clearTimeout(session.graceTimer);
        session.state.status = "finished";
        onlineSessions.delete(session.id);
        for (const socketId of session.socketIds) {
            if (socketSessionIds.get(socketId) === session.id)
                socketSessionIds.delete(socketId);
        }
        const match = publicMatches.get(session.id);
        if (match?.status === "live") {
            match.status = "forfeit";
            match.endedAt = new Date().toISOString();
            match.score = [...session.state.score];
            match.result = "몰수 종료";
            stats.liveMatches -= 1;
            stats.completedMatches += 1;
            stats.totalForfeits += 1;
            broadcastSnapshot();
        }
        io.to(session.id).emit("forfeit", { winnerSocketId: leaverSocketId });
        io.to(session.id).emit("result", { score: session.state.score, result: "몰수 종료" });
    };
    const tryMatchQueue = () => {
        // 방치된 탭(마지막 조작이 오래된 소켓)은 매칭에서 제외한다.
        for (let index = queuedSockets.length - 1; index >= 0; index -= 1) {
            const id = queuedSockets[index];
            if (Date.now() - (socketActivityAt.get(id) ?? 0) <= QUEUE_AFK_MS)
                continue;
            queuedSockets.splice(index, 1);
            io.sockets.sockets.get(id)?.emit("queue-status", { state: "idle", reason: "afk" });
        }
        while (queuedSockets.length >= 2) {
            const first = queuedSockets.shift();
            const second = queuedSockets.shift();
            const firstSocket = io.sockets.sockets.get(first);
            const secondSocket = io.sockets.sockets.get(second);
            if (!firstSocket || !secondSocket)
                continue;
            const matchId = `candidate-${randomBytes(10).toString("base64url")}`;
            const timer = setTimeout(() => beginOnlineSession(matchId), matchStartDelayMs);
            pendingMatches.set(matchId, { socketIds: [first, second], timer });
            firstSocket.emit("match-found", { matchId, startsInMs: matchStartDelayMs, opponent: { nickname: socketNames.get(second) ?? "Guest" } });
            secondSocket.emit("match-found", { matchId, startsInMs: matchStartDelayMs, opponent: { nickname: socketNames.get(first) ?? "Guest" } });
        }
    };
    io.of("/admin").on("connection", (socket) => socket.emit("admin-snapshot", snapshot()));
    io.use((socket, next) => validTokens.has(String(socket.handshake.auth.token)) ? next() : next(new Error("unauthorized")));
    io.on("connection", (socket) => {
        const token = String(socket.handshake.auth.token);
        socketNames.set(socket.id, profileNames.get(token) ?? `Guest-${String(++guestSequence).padStart(3, "0")}`);
        socketActivityAt.set(socket.id, Date.now());
        // CloudFront/프록시 뒤에서는 X-Forwarded-For의 첫 항목이 실제 공인 IP다.
        const forwarded = String(socket.handshake.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
        const publicIp = forwarded || socket.handshake.address;
        socketPublicIps.set(socket.id, publicIp);
        const peerId = randomBytes(6).toString("base64url");
        socketPeerIds.set(socket.id, peerId);
        peerIdSockets.set(peerId, socket.id);
        socket.emit("net-id", { netId: netIdOf(publicIp) });
        socket.emit("room-list", roomListPayload());
        broadcastLanPeers(publicIp);
        stats.activeConnections += 1;
        stats.totalConnections += 1;
        broadcastSnapshot();
        socket.on("join-queue", () => {
            if (queuedSockets.includes(socket.id) || socketSessionIds.has(socket.id) || [...pendingMatches.values()].some((pending) => pending.socketIds.includes(socket.id)))
                return;
            socketActivityAt.set(socket.id, Date.now());
            queuedSockets.push(socket.id);
            socket.emit("queue-status", { state: "searching" });
            tryMatchQueue();
        });
        socket.on("leave-queue", () => {
            const index = queuedSockets.indexOf(socket.id);
            if (index >= 0)
                queuedSockets.splice(index, 1);
            socket.emit("queue-status", { state: "idle" });
        });
        socket.on("join-match", (sessionId) => {
            socket.join(sessionId);
            const participants = sessions.get(sessionId) ?? new Set();
            sessions.set(sessionId, participants);
            participants.add(socket.id);
            if (participants.size === 2)
                registerPublicMatch(sessionId, participants);
            socket.emit("session", sessionId);
        });
        socket.on("input", (input) => {
            if (typeof input?.moveX !== "number" || typeof input?.moveY !== "number" || typeof input?.dash !== "boolean")
                return;
            if (!Number.isFinite(input.moveX) || !Number.isFinite(input.moveY) || Math.abs(input.moveX) > 1 || Math.abs(input.moveY) > 1)
                return;
            if (input.moveX || input.moveY || input.dash)
                socketActivityAt.set(socket.id, Date.now());
            stats.totalInputs += 1;
            broadcastSnapshot();
            const onlineSession = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
            if (onlineSession) {
                const playerIndex = onlineSession.socketIds.indexOf(socket.id);
                if (playerIndex === 0 || playerIndex === 1) {
                    // 아직 시뮬레이션이 소비하지 않은 대시는 다음 이동 패킷이 지우지 않게 유지한다.
                    const pendingDash = onlineSession.inputs[playerIndex].dash;
                    onlineSession.inputs[playerIndex] = { moveX: input.moveX, moveY: input.moveY, dash: input.dash || pendingDash };
                }
                return;
            }
            io.to([...socket.rooms].find((r) => r !== socket.id) ?? socket.id).emit("state", { input });
        });
        socket.on("emote", (index) => {
            if (typeof index !== "number" || !EMOTES[index])
                return;
            const now = Date.now();
            // 이모지 도배 방지: 소켓당 600ms 속도 제한.
            if (now - (socketEmoteAt.get(socket.id) ?? 0) < 600)
                return;
            socketEmoteAt.set(socket.id, now);
            socketActivityAt.set(socket.id, now);
            const session = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
            if (!session)
                return;
            const playerIndex = session.socketIds.indexOf(socket.id);
            if (playerIndex < 0)
                return;
            io.to(session.id).emit("emote", { playerIndex, emoji: EMOTES[index] });
        });
        // 로비: 방 코드를 만들거나 참가해 특정 상대와 경기한다.
        socket.on("create-room", () => {
            if (socketRoomCodes.has(socket.id) || socketSessionIds.has(socket.id))
                return;
            let code = "";
            do {
                code = Array.from(randomBytes(4), (value) => roomAlphabet[value % roomAlphabet.length]).join("");
            } while (rooms.has(code));
            rooms.set(code, { hostId: socket.id, guestId: null });
            socketRoomCodes.set(socket.id, code);
            socketActivityAt.set(socket.id, Date.now());
            socket.emit("room-created", { code });
            broadcastRoomList();
        });
        socket.on("join-room", (rawCode) => {
            if (typeof rawCode !== "string" || socketSessionIds.has(socket.id))
                return;
            const code = rawCode.trim().toUpperCase();
            const room = rooms.get(code);
            if (room?.hostId === socket.id)
                return;
            if (!room) {
                socket.emit("room-error", { reason: "not-found" });
                return;
            }
            if (room.guestId && room.guestId !== socket.id) {
                socket.emit("room-error", { reason: "full" });
                return;
            }
            room.guestId = socket.id;
            socketRoomCodes.set(socket.id, code);
            socketActivityAt.set(socket.id, Date.now());
            const payload = {
                code,
                players: [socketNames.get(room.hostId) ?? "Guest", socketNames.get(socket.id) ?? "Guest"],
            };
            io.sockets.sockets.get(room.hostId)?.emit("room-ready", { ...payload, playerIndex: 0 });
            socket.emit("room-ready", { ...payload, playerIndex: 1 });
            broadcastRoomList();
        });
        // 같은 네트워크 사용자를 방으로 초대한다(호스트 전용, 대상은 수락해야 참가).
        socket.on("invite-lan", (rawPeerId) => {
            if (typeof rawPeerId !== "string")
                return;
            const code = socketRoomCodes.get(socket.id);
            const room = code ? rooms.get(code) : undefined;
            if (!room || room.hostId !== socket.id || room.guestId)
                return;
            const targetSocketId = peerIdSockets.get(rawPeerId);
            if (!targetSocketId || targetSocketId === socket.id)
                return;
            if (socketPublicIps.get(targetSocketId) !== socketPublicIps.get(socket.id))
                return;
            io.sockets.sockets.get(targetSocketId)?.emit("room-invite", { code, host: socketNames.get(socket.id) ?? "Guest" });
        });
        socket.on("leave-room", () => leaveRoom(socket.id));
        // 같은 네트워크 P2P를 위한 WebRTC 시그널 중계. 서버는 내용을 보지 않고 상대에게만 전달한다.
        socket.on("rtc-signal", (payload) => {
            const code = socketRoomCodes.get(socket.id);
            const room = code ? rooms.get(code) : undefined;
            if (!room)
                return;
            const peerId = room.hostId === socket.id ? room.guestId : room.hostId;
            if (peerId)
                io.sockets.sockets.get(peerId)?.emit("rtc-signal", payload);
        });
        // 방에서 서버 권위 경기 시작(P2P가 안 되거나 원하지 않을 때의 기본 경로).
        socket.on("start-room-match", () => {
            const code = socketRoomCodes.get(socket.id);
            const room = code ? rooms.get(code) : undefined;
            if (!room || !room.guestId || room.hostId !== socket.id)
                return;
            const matchId = `room-${code}-${randomBytes(4).toString("base64url")}`;
            pendingMatches.set(matchId, { socketIds: [room.hostId, room.guestId], timer: setTimeout(() => beginOnlineSession(matchId), 0) });
        });
        // P2P 락스텝 경기: 서버는 판정하지 않고 공개 기록만 등록한다.
        socket.on("start-room-p2p", () => {
            const code = socketRoomCodes.get(socket.id);
            const room = code ? rooms.get(code) : undefined;
            if (!room || !room.guestId || room.hostId !== socket.id)
                return;
            const sessionId = `p2p-${code}-${randomBytes(4).toString("base64url")}`;
            for (const id of [room.hostId, room.guestId]) {
                io.sockets.sockets.get(id)?.join(sessionId);
            }
            sessions.set(sessionId, new Set([room.hostId, room.guestId]));
            registerPublicMatch(sessionId, [room.hostId, room.guestId]);
            io.to(sessionId).emit("p2p-match", { sessionId });
        });
        socket.on("result", (result) => {
            const sessionId = [...socket.rooms].find((room) => room !== socket.id);
            const match = sessionId ? publicMatches.get(sessionId) : undefined;
            if (match?.status === "live") {
                match.status = "completed";
                match.endedAt = new Date().toISOString();
                if (Array.isArray(result?.score) && result.score.length === 2 && result.score.every((score) => typeof score === "number" && Number.isFinite(score))) {
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
            leaveRoom(socket.id);
            socketActivityAt.delete(socket.id);
            socketEmoteAt.delete(socket.id);
            const departedIp = socketPublicIps.get(socket.id);
            socketPublicIps.delete(socket.id);
            const departedPeerId = socketPeerIds.get(socket.id);
            socketPeerIds.delete(socket.id);
            if (departedPeerId)
                peerIdSockets.delete(departedPeerId);
            broadcastLanPeers(departedIp);
            const queueIndex = queuedSockets.indexOf(socket.id);
            if (queueIndex >= 0)
                queuedSockets.splice(queueIndex, 1);
            const onlineSession = onlineSessions.get(socketSessionIds.get(socket.id) ?? "");
            if (onlineSession && !onlineSession.frozen && onlineSession.state.status === "playing") {
                // 재접속 유예: 경기를 동결하고 15초 안에 돌아오지 못하면 몰수패로 확정한다.
                onlineSession.frozen = true;
                io.to(onlineSession.id).emit("opponent-disconnected", { graceSeconds: 15 });
                onlineSession.graceTimer = setTimeout(() => forfeitOnlineSession(onlineSession, socket.id), 15_000);
            }
            for (const [matchId, pending] of pendingMatches) {
                if (!pending.socketIds.includes(socket.id))
                    continue;
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
            stats.activeConnections = Math.max(0, stats.activeConnections - 1);
            socketNames.delete(socket.id);
            broadcastSnapshot();
            io.emit("reconnect-grace", { socketId: socket.id, seconds: 15 });
        });
    });
    const listen = (port = 0, host = "127.0.0.1") => new Promise((resolve) => http.listen(port, host, () => resolve(http.address().port)));
    const close = () => {
        for (const pending of pendingMatches.values())
            clearTimeout(pending.timer);
        for (const session of onlineSessions.values()) {
            clearInterval(session.interval);
            if (session.graceTimer)
                clearTimeout(session.graceTimer);
        }
        if (snapshotTimer)
            clearTimeout(snapshotTimer);
        snapshotTimer = null;
        return new Promise((resolve) => io.close(() => http.close(() => resolve())));
    };
    return { io, http, listen, close };
}
