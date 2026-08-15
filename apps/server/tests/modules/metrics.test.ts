import { describe, expect, it } from 'vitest';
import { createMetrics } from '../../src/modules/metrics';

describe('createMetrics', () => {
  it('exposes the spec indicator names in the registry text', async () => {
    const metrics = createMetrics('inst_test');
    // Record something so the counters materialise in the exposition.
    metrics.httpRequestsTotal.labels('GET', '200').inc();
    metrics.mcpToolCallsTotal.inc();
    metrics.authFailuresTotal.labels('pat').inc();
    metrics.rateLimitedTotal.inc();
    metrics.sseConnections.inc();
    metrics.outboxUnpublished.set(5);
    metrics.outboxLagSeconds.set(12);

    const text = await metrics.registry.metrics();
    expect(text).toContain('ganttly_http_requests_total');
    expect(text).toContain('ganttly_http_request_duration_seconds');
    expect(text).toContain('ganttly_mcp_tool_calls_total');
    expect(text).toContain('ganttly_auth_failures_total');
    expect(text).toContain('ganttly_rate_limited_total');
    expect(text).toContain('ganttly_sse_connections');
    expect(text).toContain('ganttly_outbox_unpublished');
    expect(text).toContain('ganttly_outbox_lag_seconds');
  });

  it('tags samples with the instance label', async () => {
    const metrics = createMetrics('inst_abc');
    metrics.httpRequestsTotal.labels('GET', '200').inc();
    const text = await metrics.registry.metrics();
    expect(text).toContain('instance="inst_abc"');
  });

  it('uses the prometheus content type', () => {
    const metrics = createMetrics('inst_test');
    expect(metrics.registry.contentType).toMatch(/text\/plain/);
  });
});
