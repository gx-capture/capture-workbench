import {
  HlmCaption,
  HlmTBody,
  HlmTd,
  HlmTFoot,
  HlmTh,
  HlmTHead,
  HlmTable,
  HlmTableContainer,
  HlmTr,
} from './lib/hlm-table';

export * from './lib/hlm-table';

export const HlmTableImports = [
  HlmTableContainer,
  HlmTable,
  HlmTHead,
  HlmTBody,
  HlmTFoot,
  HlmTr,
  HlmTh,
  HlmTd,
  HlmCaption,
] as const;
