// ESLint flat config (ESLint 9 + typescript-eslint 8) for every .js/.mjs/.ts file in the workspace.
// The last block enforces the sim determinism rules of docs/DESIGN.md §9 on production sim code
// (packages/shared/src/sim/**). Tests beside the sim are excluded from that block: they are not sim code
// and legitimately use math/rng (containment test), Map/Set, etc.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const banned = ['sin','cos','tan','asin','acos','atan','atan2','pow','exp','expm1','log','log2','log10','log1p','hypot','cbrt','sinh','cosh','tanh','asinh','acosh','atanh','random','fround'];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.tsout/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Plain Node scripts (packages/server/build.mjs, this file): the Node globals they use.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' },
    },
  },
  {
    files: ['packages/shared/src/sim/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-properties': ['error',
        ...banned.map((p) => ({ object: 'Math', property: p, message: 'Not bit-exact across engines; forbidden in sim' })),
        { object: 'Date', property: 'now', message: 'No time in sim' },
        { object: 'performance', property: 'now', message: 'No time in sim' }],
      'no-restricted-syntax': ['error',
        { selector: "BinaryExpression[operator='**']", message: 'Use multiplication' },
        { selector: "AssignmentExpression[operator='**=']", message: 'Use multiplication' },
        { selector: "NewExpression[callee.name='Date']", message: 'No time in sim' },
        { selector: "NewExpression[callee.name=/^(Float32Array|Map|Set|WeakMap|WeakSet)$/]", message: 'Only plain arrays, Uint8Array, Int16Array, DataView in sim' }],
      'no-restricted-imports': ['error', { patterns: ['**/math/rng', '**/math/rng.ts'] }],
    },
  },
);
