/// <reference types="vite/client" />
import { io, type Socket } from "socket.io-client";
import type { ClientEvents, ServerEvents } from "./protocol.js";

export type BackendSocket = Socket<ServerEvents, ClientEvents>;

const tokenKey = "blob-soccer-anonymous-token";
const nicknameKey = "blob-soccer-nickname";
const worldResumeKey = "blob-soccer-world-resume";

export function getBackendUrl() {
  return (import.meta.env.VITE_BACKEND_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
}

export function getStoredNickname() {
  return localStorage.getItem(nicknameKey);
}

/** 서버가 서명해준 마지막 월드 위치. 재접속 때 world-resume으로 돌려준다. */
export function readWorldResume() {
  return localStorage.getItem(worldResumeKey);
}

export function writeWorldResume(signed: string) {
  localStorage.setItem(worldResumeKey, signed);
}

async function issueAnonymousProfile(backendUrl: string) {
  const response = await fetch(`${backendUrl}/anonymous-profile`, { method: "POST" });
  if (!response.ok) throw new Error(`anonymous profile request failed: ${response.status}`);
  const profile = (await response.json()) as { token: string; nickname: string };
  localStorage.setItem(tokenKey, profile.token);
  localStorage.setItem(nicknameKey, profile.nickname);
  return profile.token;
}

function openSocket(backendUrl: string, token: string) {
  return new Promise<BackendSocket>((resolve, reject) => {
    const socket: BackendSocket = io(backendUrl, {
      auth: { token },
      transports: ["websocket", "polling"],
      timeout: 5_000,
    });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

/**
 * 익명 프로필을 확보하고 소켓을 연다.
 *
 * 서버는 프로세스 메모리에만 토큰을 들고 있어서 재시작하면 저장해둔 토큰이 무효가 된다.
 * 그때는 조용히 새 프로필을 발급받아 다시 시도한다 — 사용자에게 보일 실패가 아니다.
 */
export async function connectBackend() {
  const backendUrl = getBackendUrl();
  const savedToken = localStorage.getItem(tokenKey);
  const token = savedToken ?? (await issueAnonymousProfile(backendUrl));
  try {
    return await openSocket(backendUrl, token);
  } catch (error) {
    if (!savedToken) throw error;
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(nicknameKey);
    return openSocket(backendUrl, await issueAnonymousProfile(backendUrl));
  }
}
