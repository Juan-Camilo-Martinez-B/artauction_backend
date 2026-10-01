import { loadEnvironment } from '../src/common/config/environment';

describe('loadEnvironment', () => {
  const base = {
    DATABASE_URL: 'postgresql://artauction:artauction@localhost:5432/artauction',
    MONGODB_URI: 'mongodb://localhost:27017/artauction',
    JWT_ACCESS_SECRET: 'access-secret-value',
    JWT_REFRESH_SECRET: 'refresh-secret-value',
  };

  it('accepts a complete environment', () => {
    const env = loadEnvironment(base);
    expect(env.PORT).toBe(3001);
    expect(env.corsOriginList).toEqual(['http://localhost:3000']);
    expect(env.geminiConfigured).toBe(false);
  });

  it('rejects a short jwt secret', () => {
    expect(() => loadEnvironment({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(
      /Invalid environment/,
    );
  });
});
