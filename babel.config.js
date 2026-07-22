/**
 * Babel is only configured here because NativeWind needs two things:
 *   1. `jsxImportSource: 'nativewind'` so JSX elements accept `className`
 *   2. the `nativewind/babel` preset to compile Tailwind classes
 *
 * Everything else (Reanimated / Worklets, React Compiler, Expo Router) is
 * handled automatically by `babel-preset-expo`. Do not add plugins for those.
 */
module.exports = function (api) {
  api.cache(true);

  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
  };
};
