/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/modules/subastas/**/*.ts',
    'src/modules/auditoria-ia/**/*.ts',
    'src/infra/ai/**/*.ts',
    'src/common/domain/**/*.ts',
  ],
  coveragePathIgnorePatterns: ['\\.module\\.ts$', 'gateway\\.ts$', 'auction-closer\\.ts$'],
  coverageThreshold: {
    global: {
      lines: 70,
      statements: 70,
    },
  },
};
