import * as vscode from 'vscode';

const SECRET_KEY = 'tlc.apiKey';

/** Stores the API key in VS Code secret storage (never in plain settings). */
export class ApiKeyStorage {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async get(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async set(value: string): Promise<void> {
    await this.secrets.store(SECRET_KEY, value);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}
