import { useEffect } from "react";
import type { MatchInput } from "../backend/protocol.js";

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  KeyS: [0, 1],
  KeyA: [-1, 0],
  KeyD: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};

// 운영 화면 하단 안내바 기준: "WASD / 방향키로 이동", "Space / N 대시", "B 발사".
const DASH_KEYS = new Set(["Space", "KeyN"]);
const FIRE_KEYS = new Set(["KeyB"]);

/**
 * 경기 조작. 이동은 8방향 풀속도 디지털 벡터로 양자화한다.
 *
 * 아날로그 크기를 그대로 보내면 안 된다 — 모바일 조이스틱을 살짝만 기울인 사람이 키보드 사용자보다
 * 느려져서 입력 장치가 실력이 된다. 서버도 같은 전제로 튜닝돼 있다.
 */
export function useMatchControls(enabled: boolean, input: React.RefObject<MatchInput>) {
  useEffect(() => {
    if (!enabled) return;
    const pressed = new Set<string>();

    const apply = () => {
      let x = 0;
      let y = 0;
      for (const code of pressed) {
        const vector = MOVE_KEYS[code];
        if (vector) {
          x += vector[0];
          y += vector[1];
        }
      }
      const magnitude = Math.hypot(x, y);
      input.current.moveX = magnitude > 0 ? x / magnitude : 0;
      input.current.moveY = magnitude > 0 ? y / magnitude : 0;
    };

    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (DASH_KEYS.has(event.code)) {
        event.preventDefault();
        input.current.dash = true;
        return;
      }
      if (FIRE_KEYS.has(event.code)) {
        event.preventDefault();
        input.current.fire = true;
        return;
      }
      if (!MOVE_KEYS[event.code] || pressed.has(event.code)) return;
      event.preventDefault();
      pressed.add(event.code);
      apply();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!pressed.delete(event.code)) return;
      apply();
    };

    // 창을 벗어나면 keyup을 놓쳐 키가 눌린 채 남는다. 그러면 선수가 혼자 계속 달린다.
    const onBlur = () => {
      pressed.clear();
      apply();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      input.current.moveX = 0;
      input.current.moveY = 0;
    };
  }, [enabled, input]);
}
