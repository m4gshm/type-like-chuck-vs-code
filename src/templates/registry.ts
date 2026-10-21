import { FimTemplate } from './types';

export class TemplateRegistry {
  private readonly templates = new Map<string, FimTemplate>();

  constructor(private readonly defaultTemplate: FimTemplate) {
    this.register(defaultTemplate);
  }

  register(template: FimTemplate): void {
    this.templates.set(template.id, template);
  }

  get default(): FimTemplate {
    return this.defaultTemplate;
  }

  /** Resolves a template id; falls back to the default when unknown. */
  resolve(id: string | undefined): { template: FimTemplate; found: boolean } {
    if (id && this.templates.has(id)) {
      return { template: this.templates.get(id)!, found: true };
    }
    return { template: this.defaultTemplate, found: false };
  }
}
