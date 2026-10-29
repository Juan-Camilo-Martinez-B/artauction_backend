// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Fronteras de la arquitectura de microservicios. Cada servicio tiene una capa
// `internal` (domain, application, infrastructure) y una capa `api`, la unica que
// habla con el exterior y con otros servicios. Estas reglas impiden que un tipo
// de transporte o de otro servicio se filtre hacia dentro.
const otherServices = {
  group: ['**/services/**', '*-service/**', '**/*-service/src/**'],
  message: 'Un servicio no importa codigo de otro servicio. Usa su contrato gRPC desde la capa api.',
};
const transport = {
  group: [
    '@artauction/contracts',
    '@artauction/contracts/**',
    '@artauction/service-kit',
    '@artauction/service-kit/**',
    '@grpc/*',
    '@nestjs/microservices',
  ],
  message: 'La capa internal no conoce el transporte. Define un puerto en application y implementalo en api.',
};
const apiLayer = {
  group: ['**/api/**', '../api', '../../api'],
  message: 'La capa internal no depende de la capa api (inversion de dependencias).',
};
const frameworks = {
  group: ['@nestjs/*', '@prisma/*', 'mongoose', 'pg-boss', 'socket.io', '**/generated/prisma', '**/generated/prisma/**'],
  message: 'El dominio es TypeScript puro: sin frameworks ni persistencia.',
};
const outerInternalLayers = {
  group: ['**/application/**', '**/infrastructure/**'],
  message: 'El dominio no depende de capas externas.',
};
const infrastructureLayer = {
  group: ['**/infrastructure/**'],
  message: 'application depende de puertos, no de su implementacion.',
};
const persistence = {
  group: ['@prisma/*', 'mongoose', 'pg-boss', '**/generated/prisma', '**/generated/prisma/**'],
  message: 'application usa puertos de repositorio; la persistencia vive en infrastructure.',
};

export default tseslint.config(
  {
    ignores: ['node_modules/**', '**/dist/**', 'coverage/**', '**/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
  {
    files: ['**/*.module.ts'],
    rules: {
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    files: ['services/*/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [otherServices] }],
    },
  },
  {
    files: ['services/*/src/internal/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [otherServices, transport, apiLayer] }],
    },
  },
  {
    files: ['services/*/src/internal/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [otherServices, transport, apiLayer, infrastructureLayer, persistence] },
      ],
    },
  },
  {
    files: ['services/*/src/internal/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [otherServices, transport, apiLayer, frameworks, outerInternalLayers] },
      ],
    },
  },
  {
    files: ['packages/platform/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            otherServices,
            { group: ['@artauction/contracts', '@artauction/contracts/**'], message: 'platform no conoce contratos de negocio.' },
          ],
        },
      ],
    },
  },
  {
    // describe y test de node:test devuelven promesas que gestiona el propio runner.
    files: ['e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['describe', 'test', 'before', 'after'] }] },
      ],
    },
  },
);
