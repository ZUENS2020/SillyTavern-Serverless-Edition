import { HttpError, json, readJson, safeName } from '../http';
import type { Router } from '../router';
import { deleteSnapshot, findSnapshot, listSnapshots, readSnapshot } from '../storage/snapshots';

const SYSTEM_BACKUP_PREFIXES = [
    'avatars/', 'characters/', 'chats/', 'worlds/', 'backgrounds/', 'sprites/',
    'gallery/', 'assets/', 'files/', 'data-bank/', 'thumbnails/', 'vector-source/',
] as const;

function backupJobId(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) throw new HttpError(400, 'Invalid backup job id');
    return value;
}

async function requireCompletedBackup(env: Env, id: string): Promise<void> {
    const row = await env.DB.prepare("SELECT status FROM jobs WHERE id = ? AND type = 'backup'").bind(id).first<{ status: string }>();
    if (!row) throw new HttpError(404, 'Backup job not found');
    if (row.status !== 'complete') throw new HttpError(409, 'Backup job is not complete');
}

async function serveBackupObject(object: R2ObjectBody | null, expectedEtag?: string): Promise<Response> {
    if (!object) throw new HttpError(404, 'Backup content not found');
    if (expectedEtag && object.httpEtag !== expectedEtag) throw new HttpError(409, 'Backup source changed after the manifest was created');
    const headers = new Headers({ 'cache-control': 'private, no-store', 'etag': object.httpEtag });
    object.writeHttpMetadata(headers);
    headers.set('content-length', String(object.size));
    return new Response(object.body, { headers });
}

function humanFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function registerBackupRoutes(router: Router): void {
    router.on('GET', '/api/backups/system/:id/manifest', async ({ env, params }) => {
        const id = backupJobId(params.id);
        await requireCompletedBackup(env, id);
        return serveBackupObject(await env.BUCKET.get(`backups/${id}/manifest.json`));
    });
    router.on('GET', '/api/backups/system/:id/parts/:part', async ({ env, params }) => {
        const id = backupJobId(params.id);
        if (!/^(?:r2|d1)-\d{6}\.json$/u.test(params.part ?? '')) throw new HttpError(400, 'Invalid backup part');
        await requireCompletedBackup(env, id);
        return serveBackupObject(await env.BUCKET.get(`backups/${id}/${params.part}`));
    });
    router.on('GET', '/api/backups/system/:id/object', async ({ env, params, url }) => {
        const id = backupJobId(params.id);
        await requireCompletedBackup(env, id);
        const key = url.searchParams.get('key') ?? '';
        if (!SYSTEM_BACKUP_PREFIXES.some(prefix => key.startsWith(prefix)) || key.includes('\0')) {
            throw new HttpError(400, 'Invalid backup object key');
        }
        const etag = url.searchParams.get('etag') ?? undefined;
        return serveBackupObject(await env.BUCKET.get(key), etag);
    });

    router.on('POST', '/api/backups/chat/get', async ({ env }) => {
        const snapshots = await listSnapshots(env, 'chat');
        return json(snapshots.map(snapshot => ({
            file_name: snapshot.sourceKey,
            file_size: humanFileSize(snapshot.byteLength),
            chat_items: typeof snapshot.metadata.messageCount === 'number' ? snapshot.metadata.messageCount : 0,
            mes: typeof snapshot.metadata.lastMessage === 'string' ? snapshot.metadata.lastMessage : '[The chat is empty]',
            last_mes: new Date(typeof snapshot.metadata.updatedAt === 'number' ? snapshot.metadata.updatedAt : snapshot.createdAt).toISOString(),
        })));
    });
    router.on('POST', '/api/backups/chat/download', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const name = safeName(body.name);
        if (!name.startsWith('chat_')) throw new HttpError(400, 'Invalid chat backup name');
        const snapshot = await findSnapshot(env, 'chat', name);
        if (!snapshot) throw new HttpError(404, 'Backup not found');
        const object = await readSnapshot(env, snapshot);
        const headers = new Headers({
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${name.replaceAll('"', '')}"`,
            'cache-control': 'private, no-store',
            'content-length': String(object.size),
        });
        return new Response(object.body, { headers });
    });
    router.on('POST', '/api/backups/chat/delete', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const name = safeName(body.name);
        if (!name.startsWith('chat_')) throw new HttpError(400, 'Invalid chat backup name');
        const snapshot = await findSnapshot(env, 'chat', name);
        if (!snapshot) throw new HttpError(404, 'Backup not found');
        await deleteSnapshot(env, snapshot);
        return json({ ok: true });
    });
}
