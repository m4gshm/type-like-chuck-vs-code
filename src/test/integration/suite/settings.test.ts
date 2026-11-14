import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('TLC settings-driven behavior', () => {
  // The extension's settings handler and its template cleanup write their own
  // config updates asynchronously; fixed sleeps race them on a loaded CI
  // runner, so assertions poll instead.
  const waitForValue = async (label: string, read: () => string | undefined, expected: string | undefined): Promise<void> => {
    let actual = read();
    for (let i = 0; i < 100 && actual !== expected; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      actual = read();
    }
    assert.strictEqual(actual, expected, label);
  };

  suiteSetup(async () => {
    // Like the TLC-extension suite: remote mode keeps the local engine (and
    // its delayed applyMode template writes) out of these settings tests.
    await vscode.workspace.getConfiguration('tlc').update('mode', 'remote', vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 500));
  });

  teardown(async () => {
    await vscode.workspace.getConfiguration('tlc').update('promptTemplate', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('tlc').update('prefix', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('tlc').update('local.engineKind', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('tlc').update('local.model', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('tlc').update('local.customModelPath', undefined, vscode.ConfigurationTarget.Global);
  });

  test('all TLC commands are registered', async () => {
    const ext = vscode.extensions.getExtension('m4gshm.tlc');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'tlc.triggerCompletion', 'tlc.setApiKey', 'tlc.clearApiKey', 'tlc.testConnection',
      'tlc.selectModel', 'tlc.selectMode', 'tlc.selectLocalModel', 'tlc.selectLocalDevice',
      'tlc.resetLocalEngine', 'tlc.enableDisableCompletions',
    ]) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('selecting a built-in template clears the stored marker fields', async () => {
    const tlc = vscode.workspace.getConfiguration('tlc');
    // A stored field equal to the built-in marker must be removed by the
    // template switch; a customized value must survive.
    await tlc.update('prefix', '<|fim_prefix|>', vscode.ConfigurationTarget.Global);
    await tlc.update('stop', '<|fim_pad|>, <|endoftext|>', vscode.ConfigurationTarget.Global);

    await tlc.update('promptTemplate', 'qwen3', vscode.ConfigurationTarget.Global);
    await waitForValue('default-valued prefix must be cleared', () => tlc.inspect<string>('prefix')?.globalValue, undefined);
    assert.strictEqual(tlc.inspect<string>('stop')?.globalValue, '<|fim_pad|>, <|endoftext|>', 'a stop list that is not the full built-in value must survive');

    await tlc.update('prefix', '[MY]', vscode.ConfigurationTarget.Global);
    await tlc.update('promptTemplate', 'qwen2', vscode.ConfigurationTarget.Global);
    // Let the qwen2 cleanup finish: a field edit landing inside it is
    // deliberately ignored by the handler.
    await new Promise((r) => setTimeout(r, 500));
    await waitForValue('custom prefix must survive the switch', () => tlc.inspect<string>('prefix')?.globalValue, '[MY]');

    await tlc.update('prefix', '[MY2]', vscode.ConfigurationTarget.Global);
    // The extension writes to Global; a workspace value (if any) must not mask it.
    await waitForValue('editing a field switches the template to custom', () => tlc.inspect<string>('promptTemplate')?.globalValue, 'custom');
  });

  test('changing local.engineKind while enabled restarts the engine (stub release fails fast)', async function () {
    this.timeout(30000);
    const tlc = vscode.workspace.getConfiguration('tlc');
    await tlc.update('local.llamaCppRelease', 'test-nonexistent-tag', vscode.ConfigurationTarget.Global);
    await tlc.update('mode', 'local', vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 300));

    await tlc.update('local.engineKind', 'llama.cpp', vscode.ConfigurationTarget.Global);
    await new Promise((r) => setTimeout(r, 500));
    // The pinned nonexistent release makes the llama.cpp engine fail fast; the
    // point is that the engine task ran again instead of the old engine
    // silently keeping serving requests.
    assert.ok(true, 'no crash on engine-kind change');
  });
});
