import { onMounted, onUnmounted } from 'vue';

/** Serial polling; hidden tabs pause, failures back off, and teardown stops rescheduling. */
export function useVisiblePolling(task: () => Promise<unknown>, interval: number) {
    let active = false, running = false, failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
        clearTimeout(timer);
        if (!active || running || document.hidden) return;
        running = true;
        try { const result = await task(); failures = result === false ? Math.min(failures + 1, 4) : 0; } catch { failures = Math.min(failures + 1, 4); }
        finally {
            running = false;
            if (active && !document.hidden) timer = setTimeout(run, interval * 2 ** failures);
        }
    };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void run(); };
    onMounted(() => { active = true; document.addEventListener('visibilitychange', visibility); void run(); });
    onUnmounted(() => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); });
    return run;
}
