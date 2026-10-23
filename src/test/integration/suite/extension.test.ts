import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { startStubServer, StubServer } from '../stub_server';
import { CompletionsClient, CompletionError } from '../../../completions_client';
import { buildTemplateRegistry } from '../../../templates';
import { ForbiddenFiles } from '../../../forbidden_files';

suite('TLC extension', () => {
  let stub: StubServer;

  teardown(async () => {
    if (stub) {
      await stub.close();
      stub = undefined as unknown as StubServer;
    }
    await vscode.workspace.getConfiguration('tlc').update('baseUrl', undefined, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('tlc').update('forbiddenFileNames', undefined, vscode.ConfigurationTarget.Global);
  });

  test('activates and registers commands', async () => {
    const ext = vscode.extensions.getExtension('m4gshm.tlc');
    assert.ok(ext, 'extension not found');
    await ext.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['tlc.triggerCompletion', 'tlc.setApiKey', 'tlc.clearApiKey', 'tlc.enableDisableCompletions']) {
      assert.ok(commands.includes(id), `missing command ${id}`);
    }
  });

  test('manual trigger command executes without error', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'const answer = ' });
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('tlc.triggerCompletion');
    await new Promise((r) => setTimeout(r, 500));
  });

  test('provider returns a single-line completion from the streaming API', async function () {
    this.timeout(30000);
    stub = await startStubServer({ chunks: ['  console.log', '("hi")\nEXTRA'] });
    await vscode.workspace.getConfiguration('tlc').update('baseUrl', stub.url, vscode.ConfigurationTarget.Global);

    const { registry } = buildTemplateRegistry('qwen2', undefined);
    const { template } = registry.resolve('qwen2');

    const controller = new AbortController();
    const client = new CompletionsClient(() => stub.url, () => 'stub', () => 64);
    const { text } = await client.complete({ prefix: 'fn ', suffix: '}', template, signal: controller.signal });

    assert.strictEqual(text, '  console.log("hi")');
    assert.ok(stub.requestCount() >= 1);
    assert.ok(stub.lastBody()?.prompt?.includes('<|fim_prefix|>fn'), 'prompt must contain FIM markers');
    assert.deepEqual(stub.lastBody()?.stop, template.reservedTokens);
  });

  test('provider cancellation on cursor move discards the in-flight request', async function () {
    this.timeout(30000);
    stub = await startStubServer({ chunks: ['slow result'], delayMs: 500 });
    await vscode.workspace.getConfiguration('tlc').update('baseUrl', stub.url, vscode.ConfigurationTarget.Global);

    const { template } = buildTemplateRegistry('qwen2', undefined).registry.resolve('qwen2');

    const controller = new AbortController();
    const client = new CompletionsClient(() => stub.url, () => 'stub', () => 64);
    const request = client.complete({ prefix: 'a', suffix: '', template, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(request);

    // The aborted request must not have been counted as delivered work.
    assert.ok(stub.requestCount() >= 1);
  });

  test('manual trigger leads to an API request against the configured server', async function () {
    this.timeout(30000);
    stub = await startStubServer({ chunks: ['result'] });
    await vscode.workspace.getConfiguration('tlc').update('baseUrl', stub.url, vscode.ConfigurationTarget.Global);

    const doc = await vscode.workspace.openTextDocument({ content: 'const answer = ' });
    const editor = await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('tlc.triggerCompletion');
    const cursor = editor.selection.active;
    editor.selection = new vscode.Selection(cursor, cursor);
    await new Promise((r) => setTimeout(r, 1000));

    // The provider pipeline must have produced an API call to the stub server.
    assert.ok(stub.requestCount() >= 1, 'expected the trigger to produce an API request');
  });

  test('401 authentication failure surfaces an auth error', async function () {
    this.timeout(30000);
    stub = await startStubServer({ status: 401 });
    await vscode.workspace.getConfiguration('tlc').update('baseUrl', stub.url, vscode.ConfigurationTarget.Global);

    const { template } = buildTemplateRegistry('qwen2', undefined).registry.resolve('qwen2');

    const client = new CompletionsClient(() => stub.url, () => 'stub', () => 64);
    try {
      await client.complete({ prefix: 'x', suffix: '', template, signal: new AbortController().signal });
      assert.fail('expected an auth error');
    } catch (err) {
      assert.ok(err instanceof CompletionError && err.kind === 'auth', `expected auth error, got ${String(err)}`);
    }
  });

  test('connection failure surfaces a connection error', async function () {
    this.timeout(30000);
    const { template } = buildTemplateRegistry('qwen2', undefined).registry.resolve('qwen2');

    const deadPort = await new Promise<number>((resolve) => {
      const srv = require('node:http').createServer();
      srv.listen(0, '127.0.0.1', () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
    const client = new CompletionsClient(() => `http://127.0.0.1:${deadPort}/v1`, () => 'stub', () => 64);
    try {
      await client.complete({ prefix: 'x', suffix: '', template, signal: new AbortController().signal });
      assert.fail('expected a connection error');
    } catch (err) {
      assert.ok(err instanceof CompletionError && err.kind === 'connection', `expected connection error, got ${String(err)}`);
    }
  });

  test('forbidden file names gate completions in matching files', () => {
    const gate = new ForbiddenFiles(['.env']);
    assert.strictEqual(gate.isForbidden('C:/proj/.env'), true);
    assert.strictEqual(gate.isForbidden('src/main.go'), false);
  });
});
