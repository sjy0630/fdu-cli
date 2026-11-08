import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 测试里不弹登录窗口（专门测自动登录的用例自己打开）
    env: { FDU_AUTO_LOGIN: '0' },
  },
});
