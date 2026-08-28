import { renderExtensionTemplateAsync } from './extensions.js';
import { POPUP_TYPE, callGenericPopup } from './popup.js';

export class ScraperManager {
    static #scrapers = [];

    static async registerDataBankScraper(scraper) {
        if (!scraper || typeof scraper.id !== 'string' || typeof scraper.scrape !== 'function') {
            throw new Error('Invalid Data Bank importer');
        }
        if (ScraperManager.#scrapers.some(item => item.id === scraper.id)) return;
        if (scraper.init) await scraper.init();
        ScraperManager.#scrapers.push(scraper);
    }

    static getDataBankScrapers() {
        return ScraperManager.#scrapers.map(({ id, name, description, iconClass, iconAvailable }) => (
            { id, name, description, iconClass, iconAvailable }
        ));
    }

    static async runDataBankScraper(scraperId) {
        const scraper = ScraperManager.#scrapers.find(item => item.id === scraperId);
        if (!scraper) throw new Error(`Unknown Data Bank importer: ${scraperId}`);
        return scraper.scrape();
    }

    static async isScraperAvailable(scraperId) {
        return ScraperManager.#scrapers.some(item => item.id === scraperId);
    }
}

class NotepadImporter {
    constructor() {
        this.id = 'text';
        this.name = 'Notepad';
        this.description = 'Create a plain-text Data Bank file in the browser.';
        this.iconClass = 'fa-solid fa-note-sticky';
        this.iconAvailable = true;
    }

    async scrape() {
        const template = $(await renderExtensionTemplateAsync('attachments', 'notepad', {}));
        let fileName = `Untitled - ${new Date().toLocaleString()}`;
        let content = '';
        template.find('input[name="notepadFileName"]').val(fileName).on('input', event => {
            fileName = String(event.target.value).trim();
        });
        template.find('textarea[name="notepadFileContent"]').on('input', event => {
            content = String(event.target.value);
        });
        const accepted = await callGenericPopup(template, POPUP_TYPE.CONFIRM, '', {
            wide: true, large: true, okButton: 'Save', cancelButton: 'Cancel',
        });
        if (!accepted || !content) return [];
        return [new File([content], `${fileName || 'Untitled'}.txt`, { type: 'text/plain' })];
    }
}

class TextFileImporter {
    constructor() {
        this.id = 'file';
        this.name = 'Text files';
        this.description = 'Choose text, Markdown, JSON, CSV, or YAML files in the browser.';
        this.iconClass = 'fa-solid fa-file-arrow-up';
        this.iconAvailable = true;
    }

    async scrape() {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            input.accept = '.txt,.md,.markdown,.json,.jsonl,.csv,.tsv,.yaml,.yml,text/*,application/json';
            input.addEventListener('change', () => resolve(Array.from(input.files || [])), { once: true });
            input.addEventListener('cancel', () => resolve([]), { once: true });
            input.click();
        });
    }
}

export async function initScrapers() {
    await ScraperManager.registerDataBankScraper(new TextFileImporter());
    await ScraperManager.registerDataBankScraper(new NotepadImporter());
}
