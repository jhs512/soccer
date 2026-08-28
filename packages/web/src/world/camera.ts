/**
 * 카메라 스무딩.
 *
 * 서버 월드 틱이 50ms(20Hz)라 서버 좌표를 그대로 그리면 초당 20번만 움직인다 — 화면은 60Hz인데
 * 위치가 3프레임에 한 번씩 툭툭 바뀌어 끊겨 보인다. 운영 화면도 같은 상태다(700ms 동안
 * 43프레임에 서로 다른 위치는 12개뿐이었다).
 *
 * 매 프레임 목표 좌표 쪽으로 지수적으로 다가가면 두 가지가 한꺼번에 해결된다. 프레임 사이가
 * 메워져 부드러워지고, 출발·정지가 살짝 늦게 따라오면서 관성처럼 읽힌다. 서버 월드 이동에는
 * 가속도가 없어서(즉시 최고속) 이 감속이 없으면 딱딱하게 느껴진다.
 *
 * 표시 전용이다. 판정은 전부 서버가 하고 이 값은 어디에도 보고되지 않는다.
 */

/** 목표까지 남은 거리가 e분의 1로 줄어드는 시간(초). 크면 물컹하고 작으면 다시 딱딱해진다. */
const TIME_CONSTANT = 0.06;
/** 이보다 멀면 따라가지 않고 즉시 맞춘다 — 재접속·순간이동에서 화면이 길게 미끄러지지 않게. */
const SNAP_DISTANCE = 600;

export class SmoothCamera {
  private current: { x: number; y: number } | null = null;

  reset() {
    this.current = null;
  }

  /** 이번 프레임에 그릴 카메라 좌표. */
  follow(target: { x: number; y: number }, frameSeconds: number) {
    if (!this.current) {
      this.current = { x: target.x, y: target.y };
      return this.current;
    }
    if (Math.hypot(target.x - this.current.x, target.y - this.current.y) > SNAP_DISTANCE) {
      this.current = { x: target.x, y: target.y };
      return this.current;
    }
    const alpha = 1 - Math.exp(-frameSeconds / TIME_CONSTANT);
    this.current.x += (target.x - this.current.x) * alpha;
    this.current.y += (target.y - this.current.y) * alpha;
    return this.current;
  }
}
