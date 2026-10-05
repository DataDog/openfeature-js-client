module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: { __BUILD_ENV__SDK_VERSION__: '1.0.0-test' },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: require.resolve('./tsconfig.test.json'),
      },
    ],
  },
  testMatch: ['**/*.spec.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
}
