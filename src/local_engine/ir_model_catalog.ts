import { DEFAULT_HF_BASE } from './model_catalog';
import { LocalModelId } from './model_catalog';

export interface IrModelSpec {
  id: LocalModelId;
  label: string;
  repo: string;
  /** Files that must be present in the model directory for the pipeline to load. */
  files: string[];
  /** Download directory name under the models dir (unique per model+format). */
  dirName: string;
  /** Built-in FIM template id matching the model family. */
  template: string;
  approximateBytes: number;
  contextLength: number;
}

const IR_FILES = [
  'openvino_model.xml',
  'openvino_model.bin',
  'openvino_tokenizer.xml',
  'openvino_tokenizer.bin',
  'openvino_detokenizer.xml',
  'openvino_detokenizer.bin',
  'tokenizer.json',
];

const IR_CATALOG: Record<LocalModelId, IrModelSpec> = {
  '0.5b': {
    id: '0.5b',
    label: 'Qwen2.5-Coder 0.5B (OpenVINO IR)',
    repo: 'OpenVINO/Qwen2.5-Coder-0.5B-Instruct-int8-ov',
    files: IR_FILES,
    dirName: '0.5b-int8-ov',
    template: 'qwen2',
    approximateBytes: 515_000_000,
    contextLength: 32_768,
  },
  '1.5b': {
    id: '1.5b',
    label: 'Qwen2.5-Coder 1.5B (OpenVINO IR)',
    repo: 'OpenVINO/Qwen2.5-Coder-1.5B-Instruct-int8-ov',
    files: IR_FILES,
    dirName: '1.5b-int8-ov',
    template: 'qwen2',
    approximateBytes: 1_570_000_000,
    contextLength: 32_768,
  },
  '3b': {
    id: '3b',
    label: 'Qwen2.5-Coder 3B (OpenVINO IR)',
    repo: 'OpenVINO/Qwen2.5-Coder-3B-Instruct-int8-ov',
    files: IR_FILES,
    dirName: '3b-int8-ov',
    template: 'qwen2',
    approximateBytes: 3_110_000_000,
    contextLength: 32_768,
  },
};

export function irModel(id: LocalModelId): IrModelSpec {
  return IR_CATALOG[id];
}

export function irModelFileUrl(spec: IrModelSpec, fileName: string, hfBase: string = DEFAULT_HF_BASE): string {
  return `${hfBase.replace(/\/+$/, '')}/${spec.repo}/resolve/main/${fileName}`;
}
