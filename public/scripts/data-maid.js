import { getRequestHeaders } from '../script.js';
import { t } from './i18n.js';
import { callGenericPopup, Popup, POPUP_TYPE } from './popup.js';
import { renderTemplateAsync } from './templates.js';
import { humanFileSize } from './utils.js';

const TERMINAL_JOB_STATES = new Set(['complete', 'failed', 'cancelled']);

async function startJob(type) {
    const response = await fetch('/api/jobs', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ type }),
    });
    if (!response.ok) throw new Error(`Unable to start ${type}: ${response.status}`);
    return response.json();
}

async function waitForJob(id, onProgress) {
    while (true) {
        const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, {
            headers: getRequestHeaders({ omitContentType: true }),
        });
        if (!response.ok) throw new Error(`Unable to read maintenance job: ${response.status}`);
        const job = await response.json();
        onProgress(job);
        if (TERMINAL_JOB_STATES.has(job.status)) {
            if (job.status !== 'complete') throw new Error(job.errorCode || `Maintenance job ${job.status}`);
            return job;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
    }
}

async function fetchBackupPart(jobId, name) {
    const response = await fetch(`/api/backups/system/${encodeURIComponent(jobId)}/parts/${encodeURIComponent(name)}`, {
        headers: getRequestHeaders({ omitContentType: true }),
    });
    if (!response.ok) throw new Error(`Unable to download backup part ${name}: ${response.status}`);
    return response.text();
}

async function mapConcurrent(values, concurrency, callback) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (cursor < values.length) {
            const index = cursor++;
            await callback(values[index], index);
        }
    });
    await Promise.all(workers);
}

async function downloadSystemBackup(button) {
    button.disabled = true;
    try {
        const started = await startJob('backup');
        await waitForJob(started.id, current => {
            button.querySelector('span').textContent = `${t`Backing up`} ${current.progress || 0}%`;
        });
        const manifestResponse = await fetch(`/api/backups/system/${encodeURIComponent(started.id)}/manifest`, {
            headers: getRequestHeaders({ omitContentType: true }),
        });
        if (!manifestResponse.ok) throw new Error(`Unable to download backup manifest: ${manifestResponse.status}`);
        const manifestText = await manifestResponse.text();
        const manifest = JSON.parse(manifestText);
        await import('../lib/jszip.min.js');
        const zip = new window.JSZip();
        zip.file('manifest.json', manifestText);

        const objects = [];
        for (let index = 1; index <= Number(manifest.r2Parts || 0); index += 1) {
            const name = `r2-${String(index).padStart(6, '0')}.json`;
            const text = await fetchBackupPart(started.id, name);
            zip.file(`manifests/${name}`, text);
            const part = JSON.parse(text);
            if (Array.isArray(part.objects)) objects.push(...part.objects);
        }
        for (let index = 1; index <= Number(manifest.d1Parts || 0); index += 1) {
            const name = `d1-${String(index).padStart(6, '0')}.json`;
            zip.file(`d1/${name}`, await fetchBackupPart(started.id, name));
        }

        await mapConcurrent(objects, 4, async (object, index) => {
            button.querySelector('span').textContent = `${t`Downloading objects`} ${index + 1}/${objects.length}`;
            const query = new URLSearchParams({ key: String(object.key), etag: String(object.etag || '') });
            const response = await fetch(`/api/backups/system/${encodeURIComponent(started.id)}/object?${query}`, {
                headers: getRequestHeaders({ omitContentType: true }),
            });
            if (!response.ok) throw new Error(`Unable to download ${object.key}: ${response.status}`);
            zip.file(`r2/${object.key}`, await response.blob(), { binary: true });
        });

        button.querySelector('span').textContent = t`Building ZIP in browser`;
        const archive = await zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(archive);
        link.download = `sillytavern-serverless-${new Date().toISOString().replaceAll(':', '-')}.zip`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
        toastr.success(t`System backup exported.`);
    } catch (error) {
        console.error('System backup failed', error);
        toastr.error(t`System backup failed. Check the maintenance job status.`);
    } finally {
        button.disabled = false;
        button.querySelector('span').textContent = t`Export system backup`;
    }
}

function showResult(container, job) {
    const output = job.output || {};
    const results = container.querySelector('.dataMaidResultsList');
    const placeholder = container.querySelector('.dataMaidPlaceholder');
    results.replaceChildren();
    placeholder.classList.add('displayNone');

    const summary = document.createElement('div');
    summary.className = 'info-block';
    const scanned = Number(output.processed || 0);
    const orphans = Number(output.orphanCount || 0);
    const bytes = Number(output.orphanBytes || 0);
    summary.textContent = `${t`Scanned`} ${scanned} · ${t`Unreferenced objects`} ${orphans} · ${humanFileSize(bytes)}`;
    results.append(summary);

    if (orphans === 0) {
        const clean = document.createElement('div');
        clean.className = 'dataMaidPlaceholder';
        clean.textContent = t`No unreferenced R2 objects were found.`;
        results.append(clean);
        return;
    }

    const cleanup = document.createElement('button');
    cleanup.className = 'menu_button menu_button_icon';
    cleanup.textContent = t`Delete unreferenced objects`;
    cleanup.addEventListener('click', async () => {
        const confirmed = await Popup.show.confirm(
            t`Are you sure?`,
            t`This starts a resumable R2 garbage-collection workflow. Deleted objects cannot be recovered.`,
        );
        if (!confirmed) return;
        cleanup.disabled = true;
        try {
            const started = await startJob('r2-gc');
            await waitForJob(started.id, current => {
                cleanup.textContent = `${t`Cleaning`} ${current.progress || 0}%`;
            });
            cleanup.textContent = t`Cleanup complete`;
            toastr.success(t`Unreferenced R2 objects were removed.`);
        } catch (error) {
            cleanup.disabled = false;
            cleanup.textContent = t`Retry cleanup`;
            console.error('R2 garbage collection failed', error);
            toastr.error(t`Cleanup failed. Check the maintenance job status.`);
        }
    });
    results.append(cleanup);
}

class DataMaidDialog {
    constructor() {
        this.container = null;
        this.isScanning = false;
    }

    async setup() {
        const template = await renderTemplateAsync('dataMaidDialog');
        this.container = document.createElement('div');
        this.container.innerHTML = template;
        this.container.querySelector('.dataMaidStartButton').addEventListener('click', () => this.scan());
        const backupButton = this.container.querySelector('.systemBackupStartButton');
        backupButton.addEventListener('click', () => downloadSystemBackup(backupButton));
    }

    async scan() {
        if (this.isScanning) return;
        this.isScanning = true;
        const button = this.container.querySelector('.dataMaidStartButton');
        const spinner = this.container.querySelector('.dataMaidSpinner');
        const placeholder = this.container.querySelector('.dataMaidPlaceholder');
        button.disabled = true;
        spinner.classList.remove('displayNone');
        placeholder.classList.add('displayNone');
        try {
            const started = await startJob('data-maid');
            const job = await waitForJob(started.id, current => {
                button.querySelector('span').textContent = `${t`Scanning`} ${current.progress || 0}%`;
            });
            showResult(this.container, job);
        } catch (error) {
            placeholder.classList.remove('displayNone');
            placeholder.textContent = t`The scan failed. Check the maintenance job status and try again.`;
            console.error('Data Maid workflow failed', error);
            toastr.error(t`Data Maid scan failed.`);
        } finally {
            this.isScanning = false;
            button.disabled = false;
            button.querySelector('span').textContent = t`Scan`;
            spinner.classList.add('displayNone');
        }
    }

    async open() {
        await this.setup();
        await callGenericPopup(this.container, POPUP_TYPE.TEXT, '', { wide: true, large: true });
    }
}

export function initDataMaid() {
    document.getElementById('data_maid_button')?.addEventListener('click', () => new DataMaidDialog().open());
}
