import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * `base: "./"` — GitHub Pages 커스텀 도메인(soccer.oa.gg)과 `jhs512.github.io/soccer/` 양쪽에서
 * 같은 산출물이 동작해야 하므로 상대 경로로 낸다.
 *
 * 운영 빌드는 `admin/index.html`을 두 번째 엔트리로 갖는다(배포된 산출물에 admin-*.js가 있다).
 * 관리 화면은 아직 재작성 전이라 엔트리를 넣지 않았다. 복원하면 rollupOptions.input에 추가한다.
 */
export default defineConfig({
  base: "./",
  plugins: [react()],
  // 클라이언트 예측이 packages/server/src/simulation.ts를 그대로 import한다(물리 복제 금지).
  // 워크스페이스 루트 밖으로 나가는 게 아니라 형제 패키지이므로 dev 서버에 그 경로를 열어준다.
  server: { fs: { allow: [".."] } },
});
