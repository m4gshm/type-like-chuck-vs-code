import { describe, expect, it } from 'vitest';
import { localModelDiskDialog, localModelPickerItems } from '../../local_engine/model_picker';

describe('localModelPickerItems', () => {
  it('lists the three catalog models plus the From disk entry', () => {
    const items = localModelPickerItems('llama.cpp', '1.5b');
    expect(items.map((i) => i.value)).toEqual(['0.5b', '1.5b', '3b', 'disk']);
    expect(items[1].description).toBe('$(check) current');
    expect(items[0].description).toBeUndefined();
    expect(items[3].label).toBe('$(folder-opened) From disk…');
  });

  it('describes the disk entry per engine kind', () => {
    expect(localModelPickerItems('llama.cpp', '').at(-1)?.detail).toContain('GGUF');
    expect(localModelPickerItems('ovgenai', '').at(-1)?.detail).toContain('IR .xml');
    expect(localModelPickerItems('mlx', '').at(-1)?.detail).toContain('mlx model directory');
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
    expect(localModelDiskDialog('ovgenai').filters).toEqual({ 'OpenVINO IR model': ['xml'] });
    const mlx = localModelDiskDialog('mlx');
    expect(mlx.canSelectFolders).toBe(true);
    expect(mlx.filters).toEqual({});
    expect(localModelDiskDialog('llama.cpp').canSelectFolders).toBe(false);
  });
});
