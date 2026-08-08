import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // void asyncFn() in useEffect is a legitimate and common pattern
      "react-hooks/set-state-in-effect": "off",
      "@eslint-react/hooks-extra/no-direct-set-state-in-use-effect": "off",
    },
  },
]);

export default eslintConfig;
