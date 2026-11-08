import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { createRiskAnalysisService } from '../src/analysis/riskAnalysisService.js';
import { goodJupiter, goodSecurity, job, MINT, NOW } from './riskFixtures.js';

const logger = pino({ level: 'silent' });
const config = loadConfig({
  DATABASE_URL: 'postgresql://localhost/solemn',
  TOKEN_RISK_ANALYSIS_ENABLED: 'true',
});
describe('bounded risk orchestration', () => {
  it('claims a bounded batch, evaluates both sources, persists and schedules a bounded retry', async () => {
    const repository = {
      request: vi.fn(),
      claim: vi.fn().mockResolvedValue([job()]),
      persist: vi.fn().mockResolvedValue('CURRENT'),
      expire: vi.fn().mockResolvedValue(undefined),
    };
    const service = createRiskAnalysisService(config, repository, logger, {
      jupiter: {
        getMany: vi.fn().mockResolvedValue(new Map([[MINT, goodJupiter()]])),
        invalidate: vi.fn(),
      },
      security: {
        getMany: vi.fn().mockResolvedValue(new Map([[MINT, goodSecurity()]])),
      },
      now: () => Date.parse(NOW),
    });
    expect(await service.runOnce()).toBe(1);
    expect(repository.claim.mock.calls[0]?.[0]).toBe(2);
    expect(repository.persist.mock.calls[0]?.[0].status).toBe('ELIGIBLE');
    expect(repository.persist.mock.calls[0]?.[1]).not.toBeNull();
    await service.stop();
  });
  it('records failed enrichment as UNKNOWN instead of retaining eligibility', async () => {
    const repository = {
      request: vi.fn(),
      claim: vi.fn().mockResolvedValue([job()]),
      persist: vi.fn().mockResolvedValue('CURRENT'),
      expire: vi.fn().mockResolvedValue(undefined),
    };
    const service = createRiskAnalysisService(config, repository, logger, {
      jupiter: {
        getMany: vi.fn().mockRejectedValue(new Error('PRIVATE_KEY')),
        invalidate: vi.fn(),
      },
      security: {
        getMany: vi.fn().mockResolvedValue(new Map([[MINT, goodSecurity()]])),
      },
      now: () => Date.parse(NOW),
    });
    await service.runOnce();
    expect(repository.persist.mock.calls[0]?.[0].status).toBe('UNKNOWN');
    expect(service.metrics().enrichmentFailures).toBe(1);
    await service.stop();
  });
  it('performs no external calls or worklist claims when disabled', async () => {
    const repository = {
      request: vi.fn(),
      claim: vi.fn(),
      persist: vi.fn(),
      expire: vi.fn(),
    };
    const getMany = vi.fn();
    const service = createRiskAnalysisService(
      { ...config, TOKEN_RISK_ANALYSIS_ENABLED: false },
      repository,
      logger,
      { jupiter: { getMany, invalidate: vi.fn() }, security: { getMany } },
    );
    await service.start();
    expect(await service.runOnce()).toBe(0);
    await service.stop();
    expect(getMany).not.toHaveBeenCalled();
    expect(repository.claim).not.toHaveBeenCalled();
  });
});
