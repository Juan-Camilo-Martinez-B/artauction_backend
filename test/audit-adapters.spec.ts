import { Environment } from '../src/common/config/environment';
import { FakeAiAuditAdapter } from '../src/infra/ai/fake-ai-audit.adapter';
import { GeminiAiAuditAdapter, parseAuditPayload } from '../src/infra/ai/gemini-ai-audit.adapter';

describe('adaptadores de auditoría', () => {
  const fake = new FakeAiAuditAdapter();

  it('marca el acrílico anterior a 1950 como anacronismo', async () => {
    const result = await fake.audit({
      lotId: '00000000-0000-4000-8000-000000000001',
      title: 'Retrato',
      description: 'Obra declarada del siglo XVIII.',
      materials: 'acrílico sobre lienzo',
      creationYear: 1760,
      imageHashes: [],
    });
    expect(result.score).toBe(28);
    expect(result.critical).toBe(true);
    expect(result.priceMax).toBeGreaterThanOrEqual(result.priceMin);
  });

  it('aprueba un óleo coherente', async () => {
    const result = await fake.audit({
      lotId: '00000000-0000-4000-8000-000000000002',
      title: 'Paisaje',
      description: 'Óleo sin conflicto de materiales.',
      materials: 'óleo',
      creationYear: 1890,
      imageHashes: ['abc'],
    });
    expect(result.score).toBe(82);
    expect(result.critical).toBe(false);
  });

  it('interpreta el JSON de Gemini', () => {
    const result = parseAuditPayload(
      'gemini-test',
      JSON.stringify({
        score: 150,
        critical: false,
        priceMin: 40,
        priceMax: 10,
        findings: [{ code: 'NOTE', severity: 'MAYBE', message: 'ok' }],
      }),
    );
    expect(result.score).toBe(100);
    expect(result.priceMin).toBe(10);
    expect(result.priceMax).toBe(40);
    expect(result.findings[0]?.severity).toBe('INFO');
  });

  it('llama a Gemini cuando hay clave', async () => {
    const env = new Environment();
    env.GEMINI_API_KEY = 'test-key';
    env.GEMINI_MODEL = 'gemini-test';
    const adapter = new GeminiAiAuditAdapter(env);
    const payload = {
      candidates: [
        {
          content: {
            parts: [
              {
                text: JSON.stringify({
                  score: 77,
                  critical: false,
                  priceMin: 100,
                  priceMax: 200,
                  findings: [],
                }),
              },
            ],
          },
        },
      ],
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(payload),
    });
    const original = global.fetch;
    global.fetch = fetchMock;
    try {
      const result = await adapter.audit({
        lotId: '00000000-0000-4000-8000-000000000003',
        title: 'Busto',
        description: 'Mármol revisado por el modelo.',
        materials: 'mármol',
        creationYear: 1901,
        imageHashes: [],
      });
      expect(result.score).toBe(77);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      global.fetch = original;
    }
  });
});
