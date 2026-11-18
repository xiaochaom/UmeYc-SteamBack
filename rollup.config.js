import deckyPlugin from "@decky/rollup";
import typescript from "@rollup/plugin-typescript";
import ts from "typescript";

const config = deckyPlugin();

// 一次性构建无需文件监控，避免 TypeScript 的 macOS 监控句柄阻止退出。
// rollup -w 仍使用官方默认监控方式。
if (!process.env.ROLLUP_WATCH) {
  const compiler = {
    ...ts,
    sys: {
      ...ts.sys,
      watchFile: () => ({ close() {} }),
      watchDirectory: () => ({ close() {} }),
    },
  };
  config.plugins = config.plugins.map(plugin =>
    plugin.name === "typescript" ? typescript({ typescript: compiler }) : plugin
  );
}

export default config;
