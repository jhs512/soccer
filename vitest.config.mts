import { configDefaults, defineConfig } from "vitest/config";

/**
 * `.scratch/`에는 복원 과정에서 나온 구세대 소스 사본이 들어있고 그 안의 테스트는 실행 대상이 아니다.
 * 기본 exclude에 없으므로 여기서 명시적으로 뺀다.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".scratch/**", "prototype/**"],
  },
});
