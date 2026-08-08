import { Server } from "socket.io";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
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
        stats.activeConnections += 1;
        stats.totalConnections += 1;
        broadcastSnapshot();
        socket.on("join-queue", () => {
            if (queuedSockets.includes(socket.id) || socketSessionIds.has(socket.id) || [...pendingMatches.values()].some((pending) => pending.socketIds.includes(socket.id)))
                return;
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
