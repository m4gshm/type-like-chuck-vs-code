import { FimTemplate } from './types';

function fim(prefixToken: string, suffixToken: string, middleToken: string, reserved: string[]): FimTemplate {
  return {
    id: '',
    reservedTokens: reserved,
    markers: { prefix: prefixToken, suffix: suffixToken, middle: middleToken },
    render: (prefix, suffix) => prefixToken + prefix + suffixToken + suffix + middleToken,
  };
}

/**
 * Built-in FIM templates. Markers follow each model family's documented
 * fill-in-the-middle format; reserved tokens double as stop sequences.
 */

const qwen2: FimTemplate = {
  ...fim(
    '<|fim_prefix|>',
    '<|fim_suffix|>',
    '<|fim_middle|>',
    [
      '<|fim_prefix|>',
      '<|fim_suffix|>',
      '<|fim_middle|>',
      '<|fim_pad|>',
      '<|repo_name|>',
      '<|file_sep|>',
      '<|end_of_text|>',
      '<|endoftext|>',
    ],
  ),
  id: 'qwen2',
};

const qwen3: FimTemplate = {
  ...fim(
    '<|fim_prefix|>',
    '<|fim_suffix|>',
    '<|fim_middle|>',
    [
      '<|fim_prefix|>',
      '<|fim_suffix|>',
      '<|fim_middle|>',
      '<|fim_pad|>',
      '<|repo_name|>',
      '<|file_sep|>',
      '<|im_end|>',
      '<|endoftext|>',
    ],
  ),
  id: 'qwen3',
};

// Mellum (JetBrains): FIM markers without pipes, verified against the Mellum tokenizer.
const mellum: FimTemplate = {
  ...fim(
    '<fim_prefix>',
    '<fim_suffix>',
    '<fim_middle>',
    [
      '<fim_prefix>',
      '<fim_suffix>',
      '<fim_middle>',
      '<fim_pad>',
      '<reponame>',
      '<filename>',
      '<|endoftext|>',
    ],
  ),
  id: 'mellum',
};

export const BUILTIN_TEMPLATES: readonly FimTemplate[] = [qwen2, qwen3, mellum];

export const DEFAULT_TEMPLATE_ID = 'qwen2';
