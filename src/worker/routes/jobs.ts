import { HttpError, json, readJson } from '../http';
import type { Router } from '../router';
import { MAINTENANCE_JOB_TYPES, type MaintenanceJobParams, type MaintenanceJobType } from '../workflows/maintenance';

interface JobRow {
    id: string;
    type: MaintenanceJobType;
    status: string;
    progress: number;
    params_json: string;
    output_json: string | null;
    cancel_requested: number;
    error_code: string | null;
    created_at: number;
    updated_at: number;
    completed_at: number | null;
}

function jobId(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/iu.test(value)) throw new HttpError(400, 'Invalid job id');
    return value;
}

function jobType(value: unknown): MaintenanceJobType {
    if (typeof value !== 'string' || !MAINTENANCE_JOB_TYPES.includes(value as MaintenanceJobType)) {
        throw new HttpError(400, 'Invalid maintenance job type');
    }
    return value as MaintenanceJobType;
}

function decoded(row: JobRow): Record<string, unknown> {
    return {
        id: row.id,
        type: row.type,
        status: row.status,
        progress: row.progress,
        params: JSON.parse(row.params_json) as unknown,
        output: row.output_json ? JSON.parse(row.output_json) as unknown : null,
        cancelRequested: row.cancel_requested === 1,
        errorCode: row.error_code,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        completedAt: row.completed_at,
    };
}

const JOB_COLUMNS = `
    id, type, status, progress, params_json, output_json, cancel_requested,
    error_code, created_at, updated_at, completed_at
`;

export function registerJobRoutes(router: Router): void {
    router.on('POST', '/api/jobs', async ({ request, env }) => {
        const body = await readJson(request, 32_768);
        const type = jobType(body.type);
        const params = typeof body.params === 'object' && body.params !== null && !Array.isArray(body.params) ? body.params : {};
        const encoded = JSON.stringify(params);
        if (encoded.length > 16_384) throw new HttpError(413, 'Job parameters are too large');
        const id = crypto.randomUUID();
        const now = Date.now();
        try {
            await env.DB.prepare(`
                INSERT INTO jobs(id, type, status, progress, params_json, created_at, updated_at)
                VALUES (?, ?, 'queued', 0, ?, ?, ?)
            `).bind(id, type, encoded, now, now).run();
        } catch {
            throw new HttpError(409, 'Another large maintenance job is already active');
        }
        try {
            await env.MAINTENANCE.create({ id, params: { jobId: id, type } satisfies MaintenanceJobParams });
        } catch {
            await env.DB.prepare(`
                UPDATE jobs SET status = 'failed', error_code = 'WORKFLOW_CREATE_FAILED', updated_at = ?, completed_at = ? WHERE id = ?
            `).bind(Date.now(), Date.now(), id).run();
            throw new HttpError(503, 'Unable to start maintenance workflow');
        }
        return json({ id, type, status: 'queued', progress: 0 }, { status: 202 });
    });

    router.on('GET', '/api/jobs/:id', async ({ env, params }) => {
        const id = jobId(params.id);
        const row = await env.DB.prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = ?`).bind(id).first<JobRow>();
        if (!row) throw new HttpError(404, 'Job not found');
        return json(decoded(row));
    });

    router.on('POST', '/api/jobs/:id/cancel', async ({ env, params }) => {
        const id = jobId(params.id);
        const result = await env.DB.prepare(`
            UPDATE jobs SET status = 'cancelled', cancel_requested = 1, updated_at = ?, completed_at = ?
            WHERE id = ? AND status IN ('queued', 'running')
        `).bind(Date.now(), Date.now(), id).run();
        if (Number(result.meta.changes ?? 0) !== 1) throw new HttpError(409, 'Job is not active');
        const instance = await env.MAINTENANCE.get(id);
        await instance.terminate();
        return json({ id, status: 'cancelled' });
    });
}
