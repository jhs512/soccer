import type { MatchSnapshot } from "../backend/protocol.js";

/**
 * 권위 서버 스냅샷을 시간축에 쌓아 두 스냅샷 사이를 보간한다(Valve식 스냅샷 버퍼 보간).
 *
 * 시간축은 **도착 시각이 아니라 서버가 찍어 보낸 `t`(시뮬레이션 시각)** 다. 도착 시각을 기준으로
 * lerp하면 패킷 지터가 그대로 속도 요동이 돼서 공이 출렁인다 — 이전에 그렇게 만들었다가 폐기한
 * 접근이다(`memory/blob-soccer-architecture.md`).
 *
 * 렌더 시각 = 추정 서버시각 − 보간지연. 추정 서버시각은 가장 빨리 도착한 패킷이 정의하고,
 * 보간지연은 관측된 패킷 간격의 1.5배다. 1배면 스냅샷 하나만 늦어도 보간할 뒷 스냅샷이 없어
 * 화면이 멈춘다.
 */
const MAX_SNAPSHOTS = 32;
const INTERPOLATION_DELAY_FACTOR = 1.5;
const DEFAULT_INTERVAL_SECONDS = 1 / 60;
/** 간격 EMA 계수. 낮을수록 순간 지터에 둔감하다. */
const INTERVAL_SMOOTHING = 0.1;
/**
 * 오프셋을 '최속 패킷의 최댓값'으로만 두면 한 번 튄 패킷이 영원히 기준이 되고,
 * 클럭 드리프트도 흡수하지 못한다. 매 패킷 아주 조금씩 현재 관측값 쪽으로 흘려보낸다.
 */
const OFFSET_DECAY = 0.002;

export class SnapshotBuffer {
  private snapshots: MatchSnapshot[] = [];
  private clockOffset: number | null = null;
  private intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  private lastT: number | null = null;

  push(snapshot: MatchSnapshot, localSeconds: number) {
    const observedOffset = snapshot.t - localSeconds;
    if (this.clockOffset === null || observedOffset > this.clockOffset) this.clockOffset = observedOffset;
    else this.clockOffset += (observedOffset - this.clockOffset) * OFFSET_DECAY;

    if (this.lastT !== null) {
      const gap = snapshot.t - this.lastT;
      // 되돌아온 패킷(재정렬)은 간격 추정에 넣지 않는다.
      if (gap > 0) this.intervalSeconds += (gap - this.intervalSeconds) * INTERVAL_SMOOTHING;
    }
    this.lastT = snapshot.t;

    this.snapshots.push(snapshot);
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }

  get interpolationDelay() {
    return this.intervalSeconds * INTERPOLATION_DELAY_FACTOR;
  }

  get latest(): MatchSnapshot | undefined {
    return this.snapshots[this.snapshots.length - 1];
  }

  reset() {
    this.snapshots = [];
    this.clockOffset = null;
    this.lastT = null;
    this.intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  }

  /**
   * 표시용 상태. 버퍼가 비면 null, 렌더 시각이 버퍼 밖이면 가장 가까운 끝을 그대로 준다
   * (짧은 외삽을 하지 않는다 — 외삽은 방향이 틀리면 되돌아오는 게 더 눈에 띈다).
   */
  sample(localSeconds: number): MatchSnapshot | null {
    if (this.snapshots.length === 0 || this.clockOffset === null) return null;
    if (this.snapshots.length === 1) return this.snapshots[0]!;

    const renderT = localSeconds + this.clockOffset - this.interpolationDelay;
    const first = this.snapshots[0]!;
    const last = this.snapshots[this.snapshots.length - 1]!;
    if (renderT <= first.t) return first;
    if (renderT >= last.t) return last;

    let before = first;
    let after = last;
    for (let index = 1; index < this.snapshots.length; index += 1) {
      const candidate = this.snapshots[index]!;
      if (candidate.t >= renderT) {
        before = this.snapshots[index - 1]!;
        after = candidate;
        break;
      }
    }

    const span = after.t - before.t;
    const alpha = span > 0 ? (renderT - before.t) / span : 0;
    return blend(before, after, alpha);
  }
}

const lerp = (a: number, b: number, alpha: number) => a + (b - a) * alpha;

/**
 * 두 스냅샷을 섞는다.
 *
 * 득점 연출로 위치가 재배치되는 순간(`goalCount` 변화)에는 섞지 않는다. 킥오프로 순간이동한
 * 좌표를 보간하면 공과 선수가 화면을 가로질러 미끄러진다.
 */
function blend(before: MatchSnapshot, after: MatchSnapshot, alpha: number): MatchSnapshot {
  if (before.goalCount !== after.goalCount || before.status !== after.status) return after;
  return {
    ...after,
    players: [
      blendPlayer(before.players[0], after.players[0], alpha),
      blendPlayer(before.players[1], after.players[1], alpha),
    ],
    ball: {
      x: lerp(before.ball.x, after.ball.x, alpha),
      y: lerp(before.ball.y, after.ball.y, alpha),
      vx: lerp(before.ball.vx, after.ball.vx, alpha),
      vy: lerp(before.ball.vy, after.ball.vy, alpha),
    },
    // 발사체는 생겼다 사라지므로 개수가 다르면 섞지 않는다. 짝을 잘못 맞추면 순간이동해 보인다.
    projectiles:
      before.projectiles.length === after.projectiles.length
        ? after.projectiles.map((projectile, index) => {
            const previous = before.projectiles[index]!;
            return previous.owner === projectile.owner
              ? { ...projectile, x: lerp(previous.x, projectile.x, alpha), y: lerp(previous.y, projectile.y, alpha) }
              : projectile;
          })
        : after.projectiles,
    kickoffRemaining: lerp(before.kickoffRemaining, after.kickoffRemaining, alpha),
    t: lerp(before.t, after.t, alpha),
  };
}

function blendPlayer(
  before: MatchSnapshot["players"][number],
  after: MatchSnapshot["players"][number],
  alpha: number,
): MatchSnapshot["players"][number] {
  return {
    ...after,
    x: lerp(before.x, after.x, alpha),
    y: lerp(before.y, after.y, alpha),
    vx: lerp(before.vx, after.vx, alpha),
    vy: lerp(before.vy, after.vy, alpha),
    moveX: lerp(before.moveX, after.moveX, alpha),
    moveY: lerp(before.moveY, after.moveY, alpha),
    abilityGauge: lerp(before.abilityGauge, after.abilityGauge, alpha),
  };
}
