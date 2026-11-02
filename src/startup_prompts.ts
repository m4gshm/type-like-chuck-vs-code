import { DEFAULT_LOCAL_MODEL, isLocalModelId } from './local_engine/model_catalog';
import { probeCapability } from './local_engine/capability';

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
    `TLC: no completion server is reachable at ${host.baseUrl}. `
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

export const offerRecommendedLocalEngine = async (host: {
  dismissed: boolean;
  kindChosen: boolean;
  deviceChosen: boolean;
  currentDevice: string;
  currentKind: string;
  probe?: () => Promise<import('./local_engine/capability').RecommendedPath>;
  ask: AskFn;
  info: LogFn;
  applyRecommendation: (kind: 'llama.cpp' | 'ovgenai' | 'mlx', device: 'npu' | 'gpu' | 'auto') => Promise<void>;
  dismiss: () => Promise<void>;
}): Promise<void> => {
  const rec = await (host.probe ?? probeCapability)({ platform: process.platform, arch: process.arch });
  if (rec.kind === 'local') {
    host.info(`TLC local engine recommendation: ${rec.engineKind} (${rec.device}). ${rec.reason}.`);
    if (host.dismissed) {
      return;
    }
    if (host.kindChosen) {
      return;
    }
    if (host.deviceChosen && host.currentDevice === rec.device && host.currentKind === rec.engineKind) {
      return;
    }
    const header = host.deviceChosen
      ? `TLC: recommended local engine`
      : 'TLC: no local engine selected — the best match';
    const choice = await host.ask(
      `${header} — ${rec.engineKind} (${rec.device === 'auto' ? 'auto device' : `${rec.device.toUpperCase()} device`}). ${rec.reason}`,
      'Apply Recommendation',
      "Don't Ask Again",
    );
    if (choice === 'Apply Recommendation') {
      await host.applyRecommendation(rec.engineKind!, rec.device!);
    } else if (choice === "Don't Ask Again") {
      await host.dismiss();
    }
  } else {
    host.info(`TLC local engine recommendation: remote API. ${rec.reason}.`);
    if (host.dismissed || host.deviceChosen) {
      return;
    }
    const choice = await host.ask(
      `TLC: no local engine is selected and no local acceleration is available on this platform (${rec.reason}); the remote API will be used.`,
      "Don't Ask Again",
    );
    if (choice === "Don't Ask Again") {
      await host.dismiss();
    }
  }
};

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
    host.warn('TLC local engine: model "custom" has no tlc.local.customModelPath — reset to the default model.');
  } else if (storedModel.length > 0 && storedModel !== 'custom' && !isLocalModelId(storedModel)) {
    await host.updateModel(undefined);
    host.warn(`TLC local engine: model "${storedModel}" is not a catalog entry — reset to the default (${host.defaultModel}).`);
    host.notify(`TLC: local model "${storedModel}" is unknown — reset to ${DEFAULT_LOCAL_MODEL}.`);
  }
};
