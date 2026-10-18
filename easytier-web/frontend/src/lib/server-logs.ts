import type { ServerLogPage, ServerLogQuery } from './api';

/** Export only the log response and applied filters, never the API client or session. */
export function serializeServerLogs(page: ServerLogPage, filters: ServerLogQuery): string {
    return JSON.stringify({
        instance_id: page.instance_id,
        started_at: page.started_at,
        capacity: page.capacity,
        dropped_entries: page.dropped_entries,
        filters: { level: filters.level, target: filters.target, q: filters.q, before_id: filters.before_id },
        entries: page.entries.map(({ id, occurred_at, level, target, message, fields }) => ({ id, occurred_at, level, target, message, fields })),
    }, null, 2) + '\n';
}
