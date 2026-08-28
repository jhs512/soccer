import {
  SUB_STEP_SECONDS,
  advanceSimBall,
  advanceSimPlayer,
  collideSimPlayerWithBall,
  type SimBall,
  type SimInput,
  type SimPlayer,
} from "../../../server/src/simulation.js";
import type { MatchPlayerSnapshot, MatchSnapshot } from "../backend/protocol.js";

/**
 * 내 선수만 로컬에서 예측한다.
 *
 * 물리는 **서버와 같은 모듈**(`packages/server/src/simulation.ts`)을 그대로 쓴다. 클라이언트에
 * 물리를 복제하면 반드시 갈라지고, 실제로 그 복제본 때문에 골문 안에서 공이 튕겨나가 득점이
 * 누락된 적이 있다(`memory/blob-soccer-architecture.md`).
 */

/** 패킷마다 서버 상태로 당겨오는 비율. 1이면 서버 지터가 그대로 화면에 튄다. */
const CORRECTION_RATE = 0.15;
/** 이보다 벌어지면 부드럽게 당기지 않고 즉시 맞춘다(순간이동·킥오프 재배치). */
const SNAP_DISTANCE = 90;
/** 예측이 폭주하지 않도록 한 프레임에 진행할 수 있는 최대 시간. */
const MAX_FRAME_SECONDS = 0.1;

export function toSimPlayer(snapshot: MatchPlayerSnapshot): SimPlayer {
  return {
    x: snapshot.x,
    y: snapshot.y,
    vx: snapshot.vx,
    vy: snapshot.vy,
    dashCooldown: snapshot.dashCooldown,
    dashTime: snapshot.dashTime,
    abilityGauge: snapshot.abilityGauge,
    face: snapshot.face === -1 ? -1 : 1,
    moveX: snapshot.moveX,
    moveY: snapshot.moveY,
  };
}

export class LocalPrediction {
  private player: SimPlayer | null = null;
  private accumulator = 0;

  reset() {
    this.player = null;
    this.accumulator = 0;
  }

  /** 권위 스냅샷 도착. 예측값을 서버 쪽으로 조금 당긴다. */
  reconcile(authoritative: MatchPlayerSnapshot) {
    if (!this.player) {
      this.player = toSimPlayer(authoritative);
      return;
    }
    const distance = Math.hypot(authoritative.x - this.player.x, authoritative.y - this.player.y);
    if (distance > SNAP_DISTANCE) {
      this.player = toSimPlayer(authoritative);
      return;
    }
    this.player.x += (authoritative.x - this.player.x) * CORRECTION_RATE;
    this.player.y += (authoritative.y - this.player.y) * CORRECTION_RATE;
    // 속도·쿨다운·게이지는 표시가 아니라 판정에 쓰이므로 서버 값을 그대로 받는다.
    this.player.vx = authoritative.vx;
    this.player.vy = authoritative.vy;
    this.player.dashCooldown = authoritative.dashCooldown;
    this.player.dashTime = authoritative.dashTime;
    this.player.abilityGauge = authoritative.abilityGauge;
    this.player.face = authoritative.face === -1 ? -1 : 1;
  }

  /** 프레임마다 내 입력으로 고정 스텝을 돌린다. 서버와 같은 120Hz 스텝이어야 결과가 일치한다. */
  advance(input: SimInput, frameSeconds: number): SimPlayer | null {
    if (!this.player) return null;
    this.accumulator += Math.min(frameSeconds, MAX_FRAME_SECONDS);
    while (this.accumulator >= SUB_STEP_SECONDS) {
      advanceSimPlayer(this.player, input, SUB_STEP_SECONDS);
      this.accumulator -= SUB_STEP_SECONDS;
    }
    return this.player;
  }

  get current() {
    return this.player;
  }
}

/**
 * 킥 선발동.
 *
 * 예측한 내 몸이 **표시되고 있는 공**에 닿으면, 서버 판정이 돌아오길 기다리지 않고 그 자리에서
 * 찬다. 서버가 실제로 찬 공이 도착하면 그쪽으로 크로스페이드해 메운다. 이게 없으면 내가 찬 순간과
 * 공이 움직이는 순간 사이에 왕복 지연만큼 빈 시간이 생겨 조작이 늦게 느껴진다.
 */
const KICK_CROSSFADE_SECONDS = 0.25;

export class KickPrediction {
  private ball: SimBall | null = null;
  private startedAt = 0;
  private touching = false;

  reset() {
    this.ball = null;
    this.touching = false;
  }

  /**
   * 접촉의 **시작 순간**에만 true. 호출한 쪽이 사운드·화면 흔들림을 같은 프레임에 낸다.
   *
   * 접촉이 이어지는 동안(드리블·몸싸움) 매 프레임 다시 차면 크로스페이드가 매번 0으로
   * 리셋돼 표시 공이 예측 위치로 되돌아갔다 서버 위치로 갔다를 반복한다 — 공이 출렁이는
   * 원인이 이것이다. 그래서 떨어졌다 다시 닿을 때까지 한 번만 발동한다.
   */
  tryKick(player: SimPlayer, displayed: MatchSnapshot["ball"], nowSeconds: number) {
    const candidate: SimBall = { x: displayed.x, y: displayed.y, vx: displayed.vx, vy: displayed.vy };
    if (!collideSimPlayerWithBall(candidate, player)) {
      this.touching = false;
      return false;
    }
    if (this.touching || this.ball) return false;
    this.touching = true;
    this.ball = candidate;
    this.startedAt = nowSeconds;
    return true;
  }

  /** 예측한 공과 서버 공을 섞어 표시용 공을 낸다. 크로스페이드가 끝나면 서버 공만 남는다. */
  blend(authoritative: MatchSnapshot["ball"], frameSeconds: number, nowSeconds: number) {
    if (!this.ball) return authoritative;
    const elapsed = nowSeconds - this.startedAt;
    if (elapsed >= KICK_CROSSFADE_SECONDS) {
      this.ball = null;
      return authoritative;
    }
    // 등속으로 밀면 서버 공(감속·벽 반사)과 갈라져 섞는 동안 경로가 휜다. 같은 물리로 굴린다.
    advanceSimBall(this.ball, frameSeconds);
    const alpha = elapsed / KICK_CROSSFADE_SECONDS;
    return {
      x: this.ball.x + (authoritative.x - this.ball.x) * alpha,
      y: this.ball.y + (authoritative.y - this.ball.y) * alpha,
      vx: authoritative.vx,
      vy: authoritative.vy,
    };
  }
}
