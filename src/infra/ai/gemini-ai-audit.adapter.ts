import { Inject, Injectable } from '@nestjs/common';
import { ENV, type Environment } from '../../common/config/environment';
import { clampScore, normalizePriceBand, type AuditResult } from '../../modules/auditoria-ia/score';
import type { AiAuditPort, AuditInput } from './ai-audit.port';

@Injectable()
export class GeminiAiAuditAdapter implements AiAuditPort {
  readonly model: string;

  constructor(@Inject(ENV) private readonly env: Environment) {
    this.model = env.GEMINI_MODEL;
  }

  async audit(input: AuditInput): Promise<AuditResult> {
    if (!this.env.geminiConfigured) {
      throw new Error('GEMINI_API_KEY no está configurada');
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(input) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 },
      }),
    });
    if (!response.ok) {
      throw new Error(`Gemini respondió ${String(response.status)}`);
    }
    const payload: unknown = await response.json();
    return parseAuditPayload(this.model, readText(payload));
  }
}

function buildPrompt(input: AuditInput): string {
  return [
    'Audita esta obra. Responde solo JSON con score (0-100), critical (boolean),',
    'priceMin, priceMax y findings [{code,severity,message}].',
    'severity es INFO, WARNING o CRITICAL.',
    `Título: ${input.title}`,
    `Descripción: ${input.description}`,
    `Materiales: ${input.materials}`,
    `Año: ${input.creationYear === null ? 'desconocido' : String(input.creationYear)}`,
    `Hashes: ${input.imageHashes.join(',') || 'ninguno'}`,
  ].join('\n');
}

function readText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('candidates' in payload)) {
    throw new Error('Respuesta de Gemini sin candidatos');
  }
  const candidates = payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('Respuesta de Gemini vacía');
  }
  const first: unknown = candidates[0];
  if (typeof first !== 'object' || first === null || !('content' in first)) {
    throw new Error('Candidato de Gemini inválido');
  }
  const content = first.content;
  if (typeof content !== 'object' || content === null || !('parts' in content)) {
    throw new Error('Contenido de Gemini inválido');
  }
  const parts = content.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error('Gemini no devolvió texto');
  }
  const part: unknown = parts[0];
  if (typeof part !== 'object' || part === null || !('text' in part) || typeof part.text !== 'string') {
    throw new Error('Gemini no devolvió texto');
  }
  return part.text;
}

export function parseAuditPayload(model: string, text: string): AuditResult {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('JSON de auditoría inválido');
  }
  const score = 'score' in parsed ? Number(parsed.score) : Number.NaN;
  const critical = 'critical' in parsed ? Boolean(parsed.critical) : false;
  const priceMin = 'priceMin' in parsed ? Number(parsed.priceMin) : 0;
  const priceMax = 'priceMax' in parsed ? Number(parsed.priceMax) : priceMin;
  const band = normalizePriceBand(priceMin, priceMax);
  return {
    model,
    promptVersion: 'v1',
    score: clampScore(score),
    critical,
    priceMin: band.priceMin,
    priceMax: band.priceMax,
    findings: readFindings(parsed),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readFindings(parsed: object): AuditResult['findings'] {
  if (!isRecord(parsed) || !Array.isArray(parsed['findings'])) {
    return [];
  }
  const findings: AuditResult['findings'] = [];
  for (const item of parsed['findings']) {
    if (!isRecord(item)) {
      continue;
    }
    const code = typeof item['code'] === 'string' ? item['code'] : 'NOTE';
    const message = typeof item['message'] === 'string' ? item['message'] : '';
    const severityRaw = typeof item['severity'] === 'string' ? item['severity'] : 'INFO';
    const severity = severityRaw === 'CRITICAL' || severityRaw === 'WARNING' ? severityRaw : 'INFO';
    findings.push({ code, severity, message });
  }
  return findings;
}
