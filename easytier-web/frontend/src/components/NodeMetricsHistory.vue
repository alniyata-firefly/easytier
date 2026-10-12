<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button, Message, Select, SelectButton } from 'primevue';
import { ObservabilityDisplay } from 'easytier-frontend-lib';
import ApiClient, { type ObservabilityCapabilities, type MetricHistory } from '../modules/api';
import { useVisiblePolling } from '../modules/polling';
import MetricHistoryChart from './MetricHistoryChart.vue';

const props = defineProps<{ api?: ApiClient; machineId: string; instanceId: string; active: boolean }>();
const { t } = useI18n();
const capabilities = ref<ObservabilityCapabilities>();
const range = ref(3600), group = ref('traffic');
const localDateTime = (timestamp: number) => { const date = new Date(timestamp); return new Date(timestamp - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const customStart = ref(localDateTime(Date.now() - 3600000)), customEnd = ref(localDateTime(Date.now()));
const customError = ref('');
const customWindow = ref<{ start: number; end: number }>();
const loading = ref(false), error = ref('');
const results = ref<MetricHistory[]>([]), queryErrors = ref<string[]>([]);
const queriedRange = ref<{ start: number; end: number; step: number }>();
const groupDefinitions = [
    { id: 'traffic', metrics: ['traffic_rx_rate', 'traffic_tx_rate'] },
    { id: 'cpu', metrics: ['host_cpu_percent'] },
    { id: 'memory', metrics: ['host_memory_used_bytes', 'host_process_rss_bytes'] },
    { id: 'disks', metrics: ['host_disk_used_bytes'] },
    { id: 'rpc', metrics: ['rpc_error_rate'] },
];
const groups = computed(() => groupDefinitions.filter(definition => !capabilities.value || definition.metrics.some(metric => capabilities.value?.metrics.some(available => available.id === metric))).map(definition => ({ label: t(`web.observability.history_group_${definition.id}`), value: definition.id })));
const ranges = computed(() => [...[3600, 21600, 86400, 604800, 2592000].filter(seconds => !capabilities.value || seconds <= capabilities.value.max_range_seconds).map(seconds => ({ value: seconds, label: t(`web.observability.range_${seconds}`) })), { value: -1, label: t('web.observability.range_custom') }]);
const title = computed(() => t(`web.observability.history_group_${group.value}`));
const series = computed(() => results.value.flatMap(result => result.series.map(row => ({
    name: `${t(`web.observability.metric_${result.metric}`)}${row.labels.mount_point ? ` · ${row.labels.mount_point}` : ''}`,
    values: row.values,
}))));
const hasSamples = computed(() => series.value.some(row => row.values.some(point => point[1] != null)));
let generation = 0, loadingGeneration: number | undefined;

const load = async () => {
    if (!props.active || !props.api || document.hidden || loadingGeneration === generation) return;
    const request = generation, machine = props.machineId, instance = props.instanceId;
    loadingGeneration = request; loading.value = true; error.value = ''; queryErrors.value = [];
    const current = () => request === generation && props.active && machine === props.machineId && instance === props.instanceId;
    try {
        const available = await props.api.get_observability_capabilities();
        if (!current()) return;
        capabilities.value = available;
        if (!available.history_available) { results.value = []; queriedRange.value = undefined; return; }
        if (range.value > available.max_range_seconds) { range.value = Math.min(3600, available.max_range_seconds); return; }
        if (range.value === -1 && !customWindow.value) { results.value = []; queriedRange.value = undefined; return; }
        const ids = groupDefinitions.find(definition => definition.id === group.value)?.metrics.filter(metric => available.metrics.some(item => item.id === metric)) ?? [];
        if (!ids.length) { results.value = []; queriedRange.value = undefined; return; }
        const end = range.value === -1 ? customWindow.value!.end : Math.floor(Date.now() / 1000), start = range.value === -1 ? customWindow.value!.start : end - range.value;
        const step = ObservabilityDisplay.historyStep(end - start, available.min_step_seconds, available.max_points_per_series);
        const responses = await Promise.allSettled(ids.map(metric => props.api!.get_node_metrics_history(machine, instance, metric, start, end, step)));
        if (!current()) return;
        results.value = responses.flatMap(response => response.status === 'fulfilled' && response.value.available ? [response.value] : []);
        queryErrors.value = responses.flatMap((response, index) => response.status === 'rejected' ? [`${t(`web.observability.metric_${ids[index]}`)}: ${response.reason?.response?.data?.message ?? t('web.observability.history_request_failed')}`] : []);
        queriedRange.value = { start, end, step };
    } catch (failure: any) {
        if (!current()) return;
        results.value = []; queriedRange.value = undefined;
        error.value = failure?.response?.data?.message ?? t('web.observability.history_request_failed');
    } finally { if (request === generation) { loading.value = false; loadingGeneration = undefined; } }
};

const applyCustomWindow = () => {
    const start = Math.floor(new Date(customStart.value).getTime() / 1000), end = Math.floor(new Date(customEnd.value).getTime() / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end > Math.floor(Date.now() / 1000) || end - start > (capabilities.value?.max_range_seconds ?? 2678400)) {
        customError.value = t('web.observability.custom_invalid'); return;
    }
    customError.value = ''; customWindow.value = { start, end };
};
watch(() => [props.machineId, props.instanceId, props.active, range.value, group.value, customWindow.value], () => {
    generation++; loadingGeneration = undefined; loading.value = false; results.value = []; queryErrors.value = []; error.value = ''; queriedRange.value = undefined;
    if (props.active) void load();
}, { immediate: true });
useVisiblePolling(load, 60000);
onUnmounted(() => { generation++; });
</script>

<template>
    <section class="node-metrics-history" :aria-label="t('web.observability.history')" data-testid="metrics-history" :aria-busy="loading">
        <div class="history-toolbar">
            <h3>{{ t('web.observability.history') }}</h3>
            <Button icon="pi pi-refresh" severity="secondary" text :aria-label="t('web.observability.refresh_history')" :loading="loading" @click="load" />
        </div>
        <Message v-if="error" severity="warn" :closable="false">{{ t('web.observability.history_unavailable') }}: {{ error }}</Message>
        <Message v-else-if="capabilities && !capabilities.history_available" severity="secondary" :closable="false">{{ t('web.observability.history_disabled') }}</Message>
        <template v-else>
            <div class="history-controls">
                <Select v-model="group" :options="groups" optionLabel="label" optionValue="value" :aria-label="t('web.observability.history_metric')" />
                <SelectButton v-model="range" :options="ranges" optionLabel="label" optionValue="value" :allowEmpty="false" :aria-label="t('web.observability.history_range')" />
            </div>
            <div v-if="range === -1" class="history-custom-window">
                <label>{{ t('web.observability.start_time') }}<input v-model="customStart" type="datetime-local" /></label>
                <label>{{ t('web.observability.end_time') }}<input v-model="customEnd" type="datetime-local" /></label>
                <Button :label="t('web.observability.apply_range')" severity="secondary" outlined @click="applyCustomWindow" />
                <span v-if="customError" class="history-custom-error">{{ customError }}</span>
            </div>
            <Message v-for="message in queryErrors" :key="message" severity="warn" :closable="false" class="mb-2">{{ message }}</Message>
            <p v-if="loading && !queriedRange" class="history-empty muted">{{ t('web.console.loading') }}</p>
            <p v-else-if="!hasSamples" class="history-empty muted">{{ t('web.observability.history_empty') }}</p>
            <MetricHistoryChart v-else-if="queriedRange" :title="title" :unit="results[0]?.unit ?? ''" :start="queriedRange.start" :end="queriedRange.end" :step="queriedRange.step" :series="series" />
        </template>
    </section>
</template>

<style scoped>
.node-metrics-history { border-top: 1px solid var(--p-content-border-color); margin: .5rem 0; padding-top: .75rem; min-width: 0; }
.history-toolbar { display: flex; align-items: center; justify-content: space-between; gap: .75rem; margin-bottom: .5rem; }
h3 { margin: 0; font-size: .875rem; font-weight: 600; }
.history-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-bottom: .85rem; }
.history-empty { padding: 1rem; text-align: center; font-size: .8rem; }
.history-controls :deep(.p-togglebutton-content) { padding: .15rem .2rem; }
.history-controls :deep(.p-selectbutton) { display: flex; flex-wrap: wrap; max-width: 100%; }
.history-custom-window { display: flex; flex-wrap: wrap; gap: .75rem; align-items: flex-end; margin-bottom: .85rem; }
.history-custom-window label { display: flex; flex-direction: column; gap: .4rem; font-size: .75rem; color: var(--p-text-muted-color); min-width: 0; }
.history-custom-window input { border: 1px solid var(--p-content-border-color); border-radius: .4rem; background: var(--p-content-background); color: var(--p-text-color); padding: .5rem; font-family: inherit; min-width: 0; max-width: 100%; }
.history-custom-error { color: var(--p-red-500); flex-basis: 100%; font-size: .75rem; }
@media (max-width: 500px) { .history-controls { flex-direction: column; align-items: stretch; } .history-controls :deep(.p-togglebutton) { flex: 1 0 auto; min-width: 0; } .history-custom-window label { flex-basis: 100%; } }
</style>
