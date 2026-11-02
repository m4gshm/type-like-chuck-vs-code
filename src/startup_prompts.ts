import { DEFAULT_LOCAL_MODEL, isLocalModelId } from './local_engine/model_catalog';
import { BRAND } from './brand';

interface AskFn {
  (message: string, ...items: string[]): Promise<string | undefined>;
}

interface LogFn {
  (message: string): void;
}

/** Offers to set up the built-in engine when the configured server is unreachable. */
export const offerLocalEngine = async (host: {
  mode: string;
  baseUrl: string;
  dismissed: boolean;
  ask: AskFn;
  setMode: (mode: 'local') => Promise<void>;
  dismiss: () => Promise<void>;
}): Promise<void> => {
  if (host.dismissed || host.mode === 'local') {
    return;
  }
  const choice = await host.ask(
    `${BRAND}: no completion server is reachable at ${host.baseUrl}. `
    + 'Set up the built-in local engine (downloads llama.cpp and a Qwen2.5-Coder model)?',
    'Set Up Local Engine',
    'Not Now',
    "Don't Ask Again",
  );
  if (choice === 'Set Up Local Engine') {
    await host.setMode('local');
  } else if (choice === "Don't Ask Again") {
    await host.dismiss();
  }
};

export const offerRecommendedLocalEngine = undefined;

/** A stale local.model value (renamed catalog ids, hand-edited settings)
 * would fail the engine start; reset it to the default once, with a notice. */
export const normalizeLocalModelSetting = async (host: {
  storedModel: string;
  customModelPath: string;
  defaultModel: string;
  updateModel: (value: string | undefined) => Promise<void>;
  warn: LogFn;
  notify: (message: string) => void;
}): Promise<void> => {
  const { storedModel, customModelPath } = host;
  if (storedModel === 'custom' && customModelPath.length === 0) {
    await host.updateModel(host.defaultModel);
    host.warn(`${BRAND} local engine: model "custom" has no tlc.local.customModelPath — reset to the default model.`);
  } else if (storedModel.length > 0 && storedModel !== 'custom' && !isLocalModelId(storedModel)) {
    await host.updateModel(undefined);
    host.warn(`${BRAND} local engine: model "${storedModel}" is not a catalog entry — reset to the default (${host.defaultModel}).`);
    host.notify(`${BRAND}: local model "${storedModel}" is unknown — reset to ${DEFAULT_LOCAL_MODEL}.`);
  }
};
