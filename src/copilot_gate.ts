export type CopilotEnableSetting = Record<string, boolean> | undefined;

/**
 * Whether GitHub Copilot inline completions are on for the given language:
 * the extension is installed, ghost text is not disabled
 * (`github.copilot.inlineSuggest.enable`), and the per-language
 * `github.copilot.enable` map does not turn it off (missing map or missing
 * key means the Copilot default, which is enabled).
 */
export function copilotActive(
  installed: boolean,
  enable: CopilotEnableSetting,
  inlineSuggest: boolean | undefined,
  languageId: string,
): boolean {
  if (!installed || inlineSuggest === false) {
    return false;
  }
  const override = enable?.[languageId] ?? enable?.['*'];
  return override ?? true;
}
