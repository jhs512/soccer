import { describe, expect, it } from "vitest";
import { createKoreanNickname } from "./nickname.js";

describe("한글 익명 닉네임", () => {
  it("여러 한국형 유머 문장 템플릿을 제공한다", () => {
    expect(createKoreanNickname(Uint8Array.from([0, 0, 0, 0]))).toBe("자유로운 기린");
    expect(createKoreanNickname(Uint8Array.from([1, 0, 2, 0]))).toBe("김치냉장고 지키는 수달");
    expect(createKoreanNickname(Uint8Array.from([2, 0, 5, 0]))).toBe("한강에서 춤추는 반달곰");
    expect(createKoreanNickname(Uint8Array.from([3, 2, 4, 0]))).toBe("붕어빵 먹다 들킨 두루미");
  });

  it("결정적 엔트로피 1024개에서 500개 이상의 서로 다른 닉네임을 만든다", () => {
    const names = new Set(Array.from({ length: 1_024 }, (_, index) => createKoreanNickname(Uint8Array.from([
      index % 8,
      Math.floor(index / 8) % 32,
      Math.floor(index / 256) * 7 + index % 31,
      0,
    ]))));
    expect(names.size).toBeGreaterThanOrEqual(500);
  });
});
