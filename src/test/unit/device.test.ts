import { describe, expect, it } from 'vitest';
import { deviceChain } from '../../local_engine/device';
import { llamaArgs } from '../../local_engine/engine_runner';

describe('deviceChain', () => {
  it('auto follows gpu, then cpu (the npu is opt-in, not a default)', () => {
    expect(deviceChain('auto')).toEqual(['gpu', 'cpu']);
  });

  it('tries an explicit device first, then cpu', () => {
    expect(deviceChain('npu')).toEqual(['npu', 'cpu']);
    expect(deviceChain('gpu')).toEqual(['gpu', 'cpu']);
    expect(deviceChain('cpu')).toEqual(['cpu']);
  });
});

describe('llamaArgs', () => {
  it('offloads to gpu by default, keeps cpu offload-free, and protects the server with the session key', () => {
    expect(llamaArgs(8192, 'auto')).toEqual(['-ngl', '999', '--host', '127.0.0.1', '--port', '{PORT}', '-m', '{MODEL}', '-c', '8192', '--api-key', '{KEY}']);
    expect(llamaArgs(8192, 'cpu')).toEqual(['--host', '127.0.0.1', '--port', '{PORT}', '-m', '{MODEL}', '-c', '8192', '--api-key', '{KEY}']);
  });
});
