import { describe, expect, it } from "vitest";
import type { MatchSnapshot } from "../backend/protocol.js";
import { SnapshotBuffer } from "./snapshot-buffer.js";

const player = (x: number) => ({
  x,
  y: 400,
  vx: 0,
  vy: 0,
  dashCooldown: 0,
  dashTime: 0,
  abilityGauge: 0,
  face: 1,
  moveX: 0,
  moveY: 0,
});

function snapshot(t: number, ballX: number, overrides: Partial<MatchSnapshot> = {}): MatchSnapshot {
  return {
    players: [player(200), player(600)],
    ball: { x: ballX, y: 400, vx: 0, vy: 0 },
    projectiles: [],
    score: [0, 0],
    status: "playing",
    kickoffRemaining: 0,
    lastScorer: null,
    goalCount: 0,
    t,
    ...overrides,
  };
}

/** 60Hz로 n개를 채운다. 로컬 시각과 서버 t가 같은 속도로 흐르는 이상적인 경우. */
function fill(buffer: SnapshotBuffer, count: number, startLocal = 100) {
  for (let index = 0; index < count; index += 1) {
    const seconds = startLocal + index / 60;
    buffer.push(snapshot(index / 60, 100 + index * 60), seconds);
  }
  return startLocal + (count - 1) / 60;
}

describe("SnapshotBuffer", () => {
  it("보간 지연은 관측된 패킷 간격의 1.5배다", () => {
    const buffer = new SnapshotBuffer();
    fill(buffer, 30);
    expect(buffer.interpolationDelay).toBeCloseTo((1 / 60) * 1.5, 4);
  });

  it("도착 시각이 아니라 서버 t를 축으로 두 스냅샷 사이를 보간한다", () => {
    const buffer = new SnapshotBuffer();
    // t=0에 x=0, t=1에 x=100. 두 패킷이 같은 순간에 몰려 도착해도 보간은 t를 따른다.
    buffer.push(snapshot(0, 0), 100);
    buffer.push(snapshot(1, 100), 100);

    // 오프셋은 최속 패킷이 정한다: t=1이 local=100에 왔으므로 offset=-99.
    // 보간지연은 간격 EMA(초기 1/60에서 1 쪽으로 조금 이동)의 1.5배.
    const delay = buffer.interpolationDelay;
    const sampled = buffer.sample(100 + 0.5 - (1 - delay));
    expect(sampled).not.toBeNull();
    expect(sampled!.ball.x).toBeGreaterThan(0);
    expect(sampled!.ball.x).toBeLessThan(100);
  });

  it("패킷이 지터로 몰려 와도 표시 좌표는 일정한 속도로 흐른다", () => {
    const buffer = new SnapshotBuffer();
    // 서버 t는 정확히 1/60씩, 도착은 들쭉날쭉.
    const arrivals = [0, 0.001, 0.05, 0.051, 0.052, 0.1, 0.101, 0.15];
    arrivals.forEach((arrival, index) => buffer.push(snapshot(index / 60, index * 60), 100 + arrival));

    const positions: number[] = [];
    for (let step = 0; step < 4; step += 1) {
      const sampled = buffer.sample(100.05 + step * 0.01);
      if (sampled) positions.push(sampled.ball.x);
    }
    const deltas = positions.slice(1).map((value, index) => value - positions[index]!);
    // 도착 지터가 그대로 속도로 새면 간격 편차가 커진다. t축 보간이면 고르게 움직인다.
    const spread = Math.max(...deltas) - Math.min(...deltas);
    expect(spread).toBeLessThan(Math.max(...deltas.map(Math.abs)) + 1e-6);
  });

  it("득점으로 위치가 재배치되는 구간은 섞지 않는다", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(0, 700), 100);
    buffer.push(snapshot(1, 400, { goalCount: 1 }), 100.5);

    // 어느 시점을 찍든 두 좌표의 중간값(킥오프로 미끄러지는 모습)이 나오면 안 된다.
    for (let step = 0; step <= 10; step += 1) {
      const sampled = buffer.sample(100 + step * 0.1);
      if (sampled) expect([700, 400]).toContain(sampled.ball.x);
    }
  });

  it("발사체 개수가 달라지면 짝을 억지로 맞추지 않는다", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(0, 100, { projectiles: [] }), 100);
    buffer.push(snapshot(1, 100, { projectiles: [{ owner: 0, x: 500, y: 400, vx: 0, vy: 0 }] }), 100.5);
    const sampled = buffer.sample(100.6);
    expect(sampled!.projectiles).toHaveLength(1);
    expect(sampled!.projectiles[0]!.x).toBe(500);
  });

  it("버퍼가 비어 있으면 null, 하나뿐이면 그것을 그대로 준다", () => {
    const buffer = new SnapshotBuffer();
    expect(buffer.sample(100)).toBeNull();
    buffer.push(snapshot(0, 42), 100);
    expect(buffer.sample(100)!.ball.x).toBe(42);
  });

  it("reset 뒤에는 이전 경기의 시간축이 남지 않는다", () => {
    const buffer = new SnapshotBuffer();
    fill(buffer, 30);
    buffer.reset();
    expect(buffer.sample(100)).toBeNull();
    expect(buffer.interpolationDelay).toBeCloseTo((1 / 60) * 1.5, 6);
  });
});
