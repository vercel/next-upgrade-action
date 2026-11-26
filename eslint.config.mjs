import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";

export default [
  { ignores: [".claude/", "node_modules/"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
    plugins: { "@stylistic": stylistic, sonarjs },
    rules: {
      "no-empty": "error",
      "no-empty-function": "error",
      "no-unused-vars": ["error", { ignoreRestSiblings: true }],
      "no-param-reassign": "error",
      "sonarjs/prefer-immediate-return": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "FunctionDeclaration[params.length>1], :matches(VariableDeclarator, Property, ReturnStatement) > :matches(ArrowFunctionExpression, FunctionExpression)[params.length>1]",
          message: "Take one destructured object parameter instead of positional parameters.",
        },
        {
          selector: "ChainExpression",
          message: "Check for null or undefined explicitly instead of optional chaining.",
        },
        {
          selector:
            ":matches(FunctionDeclaration, ArrowFunctionExpression, FunctionExpression) > BlockStatement[body.length=1] > IfStatement[alternate=null] > BlockStatement[body.length=1] > ThrowStatement",
          message: "Write the check inline with if and throw instead of wrapping it in a helper.",
        },
      ],
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "block-like", next: "*" },
      ],
    },
  },
];
