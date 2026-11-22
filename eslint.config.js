// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    // tests/fixtures/** 为迁移前源码的冻结副本（等价测试基线），
    // 逐字节保留原始实现，不参与 lint 维护。
    ignores: ["dist/*", "tests/fixtures/**"],
  }
]);
