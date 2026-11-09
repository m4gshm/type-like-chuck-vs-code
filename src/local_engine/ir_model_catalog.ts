import { DEFAULT_HF_BASE } from './model_catalog';
import { LocalModelId } from './model_catalog';

export interface IrModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  format: IrFormat;
  /** Files that must be present in the model directory for the pipeline to load. */
  files: string[];
  /** Built-in FIM template id matching the model family. */
  template: string;
  approximateBytes: number;
  contextLength: number;
}

export type IrFormat = 'nf4' | 'int8';

const IR_FILES = [
  'openvino_model.xml',
  'openvino_model.bin',
  'openvino_tokenizer.xml',
  'openvino_tokenizer.bin',
  'openvino_detokenizer.xml',
  'openvino_detokenizer.bin',
  'tokenizer.json',
];

// nf4 weights are the native NPU format; int8 suits GPU/CPU (no per-token
// dequantization, better quality). The format is picked by the device.
const IR_NF4: Record<LocalModelId, IrModelSpec> = {
  'Qwen2.5-Coder 0.5B': {
    id: 'Qwen2.5-Coder 0.5B',
    label: 'Qwen2.5-Coder 0.5B (OpenVINO IR, nf4)',
    format: 'nf4',
    repo: 'm4gshm/Qwen2.5-Coder-0.5B-nf4-sym-g-1-se-awq',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 330_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 1.5B': {
    id: 'Qwen2.5-Coder 1.5B',
    label: 'Qwen2.5-Coder 1.5B (OpenVINO IR, nf4)',
    format: 'nf4',
    repo: 'm4gshm/Qwen2.5-Coder-1.5B-nf4-sym-g-1-se-awq',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 910_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 3B': {
    id: 'Qwen2.5-Coder 3B',
    label: 'Qwen2.5-Coder 3B (OpenVINO IR, nf4)',
    format: 'nf4',
    repo: 'm4gshm/Qwen2.5-Coder-3B-nf4-sym-g-1-se-awq',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 1_730_000_000,
    contextLength: 32_768,
  },
};

const IR_INT8: Record<LocalModelId, IrModelSpec> = {
  'Qwen2.5-Coder 0.5B': {
    id: 'Qwen2.5-Coder 0.5B',
    label: 'Qwen2.5-Coder 0.5B (OpenVINO IR, int8)',
    format: 'int8',
    repo: 'OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int8-ov',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 515_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 1.5B': {
    id: 'Qwen2.5-Coder 1.5B',
    label: 'Qwen2.5-Coder 1.5B (OpenVINO IR, int8)',
    format: 'int8',
    repo: 'OpenVINO/Qwen2.5-Coder-1.5B-Instruct-int8-ov',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 1_570_000_000,
    contextLength: 32_768,
  },
  'Qwen2.5-Coder 3B': {
    id: 'Qwen2.5-Coder 3B',
    label: 'Qwen2.5-Coder 3B (OpenVINO IR, int8)',
    format: 'int8',
    repo: 'OpenVINO/Qwen2.5-Coder-3B-Instruct-int8-ov',
    files: IR_FILES,
    template: 'qwen2',
    approximateBytes: 3_110_000_000,
    contextLength: 32_768,
  },
};

export function irModel(id: LocalModelId, format: IrFormat = 'nf4'): IrModelSpec {
  return (format === 'int8' ? IR_INT8 : IR_NF4)[id];
}

export function irModelFileUrl(spec: IrModelSpec, fileName: string, hfBase: string = DEFAULT_HF_BASE): string {
  return `${hfBase.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${fileName}`;
}
