import { HttpError, json, readJson, safeName } from '../http';
import type { Router } from '../router';
import { deleteSnapshot, findSnapshot, listSnapshots, readSnapshot } from '../storage/snapshots';

function humanFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function registerBackupRoutes(router: Router): void {
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
