import { describe, expect, it } from 'vitest';
import { effectiveLocalModel, localModelDiskDialog, localModelDisplayName, localModelPickerItems } from '../../local_engine/model_picker';

describe('effectiveLocalModel', () => {
  it('prefers an explicit modelPath over the catalog id', () => {
    expect(effectiveLocalModel('custom', 'C:\\models\\m.gguf')).toBe('path:C:\\models\\m.gguf');
    expect(effectiveLocalModel('Qwen2.5-Coder 1.5B', '')).toBe('id:Qwen2.5-Coder 1.5B');
    expect(effectiveLocalModel('Qwen2.5-Coder 1.5B', 'C:\\models\\m.gguf')).toBe('id:Qwen2.5-Coder 1.5B');
  });
});

describe('localModelDisplayName', () => {
  it('drops the device-specific IR format suffix', () => {
    expect(localModelDisplayName('ovgenai', 'Qwen2.5-Coder 1.5B')).toBe('Qwen2.5-Coder 1.5B');
    expect(localModelDisplayName('llama.cpp', 'Qwen2.5-Coder 1.5B')).toBe('Qwen2.5-Coder 1.5B');
    expect(localModelDisplayName('ovgenai', 'custom')).toBe('model');
  });
});

describe('localModelPickerItems', () => {
  it('lists the three catalog models plus the From disk entry', () => {
    const items = localModelPickerItems('llama.cpp', 'Qwen2.5-Coder 1.5B');
    expect(items.map((i) => i.value)).toEqual(['Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder 3B', 'disk']);
    expect(items[1].description).toBe('$(check) current');
    expect(items[0].description).toBeUndefined();
    expect(items[3].label).toBe('$(folder-opened) From disk…');
  });

  it('describes the disk entry per engine kind', () => {
    expect(localModelPickerItems('llama.cpp', '').at(-1)?.detail).toContain('GGUF');
    expect(localModelPickerItems('ovgenai', '').at(-1)?.detail).toContain('IR model directory');
    expect(localModelPickerItems('mlx', '').at(-1)?.detail).toContain('mlx model directory');
  });

  it('marks the From disk entry as current when the model id is custom', () => {
    expect(localModelPickerItems('llama.cpp', 'custom').at(-1)?.description).toBe('$(check) current');
    expect(localModelPickerItems('llama.cpp', 'Qwen2.5-Coder 1.5B').at(-1)?.description).toBeUndefined();
  });

  it('uses catalog-specific sizes and labels per kind', () => {
    const gguf = localModelPickerItems('llama.cpp', '')[1];
    const ir = localModelPickerItems('ovgenai', '')[1];
    expect(gguf.detail).toContain('GB download');
    expect(ir.label).toContain('OpenVINO IR');
  });
});

describe('localModelDiskDialog', () => {
  it('filters by the model file type per kind', () => {
    expect(localModelDiskDialog('llama.cpp').filters).toEqual({ 'GGUF model': ['gguf'] });
    expect(localModelDiskDialog('ovgenai')).toEqual({ canSelectFolders: true, canSelectFiles: false, filters: {} });
    const mlx = localModelDiskDialog('mlx');
    expect(mlx.canSelectFolders).toBe(true);
    expect(mlx.filters).toEqual({});
    expect(localModelDiskDialog('llama.cpp').canSelectFolders).toBe(false);
  });
});
