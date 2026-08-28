import { useEffect } from "react";

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

const DASH_KEYS = new Set(["Space", "ShiftLeft", "ShiftRight"]);

/**
 * WASD·방향키를 이동 벡터로 바꾼다.
 *
 * 눌린 키를 집합으로 들고 매번 합성한다. keydown만 보고 방향을 덮어쓰면 두 키를 겹쳐 눌렀을 때
 * 나중 것만 남아 대각선 이동이 끊긴다.
 */
export function useKeyboardMovement(
  enabled: boolean,
  onMove: (x: number, y: number) => void,
  onDash: () => void,
  onFirstInput?: () => void,
) {
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
      onMove(x, y);
    };

    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (DASH_KEYS.has(event.code)) {
        event.preventDefault();
        onFirstInput?.();
        onDash();
        return;
      }
      if (!MOVE_KEYS[event.code]) return;
      event.preventDefault();
      onFirstInput?.();
      if (!pressed.has(event.code)) {
        pressed.add(event.code);
        apply();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!pressed.delete(event.code)) return;
      apply();
    };

    // 창을 벗어나면 keyup을 못 받아 키가 눌린 채로 남는다. 그러면 캐릭터가 혼자 계속 걷는다.
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
    };
  }, [enabled, onMove, onDash, onFirstInput]);
}
