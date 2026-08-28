import { BALL_RADIUS, PROJECTILE_RADIUS } from "../../../server/src/simulation.js";
import type { MatchSnapshot } from "../backend/protocol.js";

/**
 * 경기 화면의 순간 연출.
 *
 * 서버는 "충격탄이 공을 맞혔다"는 사건을 따로 보내주지 않는다. 대신 스냅샷에서 충격탄이 사라진
 * 자리를 보고 역산한다 — 공 근처에서 사라졌으면 명중, 경기장 밖에서 사라졌으면 그냥 소멸이다.
 * 프로토콜을 건드리지 않고 얻을 수 있는 정보이고, 틀려도 연출만 안 나온다.
 */

const IMPACT_SECONDS = 0.42;
const SPARK_COUNT = 9;

type Impact = { x: number; y: number; angle: number; power: number; startedAt: number };

export class MatchEffects {
  private previous: MatchSnapshot["projectiles"] = [];
  private impacts: Impact[] = [];

  reset() {
    this.previous = [];
    this.impacts = [];
  }

  /** 진행 중인 명중 연출 수. 캔버스를 눈으로 확인할 수 없으므로 이 값으로 검증한다. */
  get activeImpacts() {
    return this.impacts.length;
  }

  /** 스냅샷이 바뀔 때마다 호출. 사라진 충격탄을 명중으로 판정한다. */
  observe(snapshot: MatchSnapshot, nowSeconds: number) {
    const survived = new Set(snapshot.projectiles.map((projectile) => `${projectile.owner}:${Math.round(projectile.x)}`));
    for (const gone of this.previous) {
      // 같은 충격탄이 살아남았는지 대충 맞춰본다. 정확한 id가 없으니 소유자와 위치로 본다.
      const stillAlive = snapshot.projectiles.some(
        (projectile) => projectile.owner === gone.owner && Math.hypot(projectile.x - gone.x, projectile.y - gone.y) < 400,
      );
      if (stillAlive || survived.has(`${gone.owner}:${Math.round(gone.x)}`)) continue;
      const distance = Math.hypot(snapshot.ball.x - gone.x, snapshot.ball.y - gone.y);
      if (distance > BALL_RADIUS + PROJECTILE_RADIUS + 60) continue;
      this.impacts.push({
        x: gone.x,
        y: gone.y,
        angle: Math.atan2(snapshot.ball.y - gone.y, snapshot.ball.x - gone.x),
        power: Math.min(1, Math.hypot(gone.vx, gone.vy) / 960),
        startedAt: nowSeconds,
      });
    }
    this.previous = snapshot.projectiles.map((projectile) => ({ ...projectile }));
  }

  draw(context: CanvasRenderingContext2D, nowSeconds: number) {
    this.impacts = this.impacts.filter((impact) => nowSeconds - impact.startedAt < IMPACT_SECONDS);
    for (const impact of this.impacts) {
      const progress = (nowSeconds - impact.startedAt) / IMPACT_SECONDS;
      const fade = 1 - progress;

      context.save();
      context.translate(impact.x, impact.y);

      // 충격 고리: 맞은 자리에서 퍼져나간다.
      context.beginPath();
      context.arc(0, 0, 8 + progress * 54 * impact.power, 0, Math.PI * 2);
      context.strokeStyle = `rgba(248, 250, 252, ${fade * 0.85})`;
      context.lineWidth = 3 * fade + 0.5;
      context.stroke();

      // 불꽃: 진행 방향을 중심으로 부챗살처럼 튄다. 어느 쪽에서 맞았는지가 보인다.
      context.strokeStyle = `rgba(34, 211, 238, ${fade})`;
      context.lineWidth = 2;
      context.beginPath();
      for (let index = 0; index < SPARK_COUNT; index += 1) {
        const spread = ((index / (SPARK_COUNT - 1)) - 0.5) * 2.1;
        const direction = impact.angle + spread;
        const inner = 6 + progress * 26;
        const outer = inner + 16 * fade * (1 - Math.abs(spread) / 1.4);
        context.moveTo(Math.cos(direction) * inner, Math.sin(direction) * inner);
        context.lineTo(Math.cos(direction) * outer, Math.sin(direction) * outer);
      }
      context.stroke();
      context.restore();
    }
  }
}
