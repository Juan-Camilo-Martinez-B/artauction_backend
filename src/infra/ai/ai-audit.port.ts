import type { AuditResult } from '../../modules/auditoria-ia/score';

export interface AuditInput {
  lotId: string;
  title: string;
  description: string;
  materials: string;
  creationYear: number | null;
  imageHashes: string[];
}

export interface AiAuditPort {
  readonly model: string;
  audit(input: AuditInput): Promise<AuditResult>;
}

export const AI_AUDIT_PORT = Symbol('AI_AUDIT_PORT');
