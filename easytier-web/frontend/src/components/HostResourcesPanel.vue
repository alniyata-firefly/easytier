<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Message } from 'primevue';
import { ObservabilityDisplay, RuntimeDisplay } from 'easytier-frontend-lib';

const props = defineProps<{ resources?: ObservabilityDisplay.HostResources; supported?: boolean; loading: boolean; error?: string }>();
const { t } = useI18n();
const memory = computed(() => ObservabilityDisplay.usedMemory(props.resources?.memory_total_bytes, props.resources?.memory_available_bytes));
const cpu = computed(() => ObservabilityDisplay.percentage(props.resources?.cpu_usage_percent));
const resourcesStale = computed(() => !!props.resources && ObservabilityDisplay.staleSample(props.resources.sampled_at_unix_ms, Date.now(), 15000));
const disksStale = computed(() => !!props.resources?.disks?.length && ObservabilityDisplay.staleSample(props.resources.disks_sampled_at_unix_ms, Date.now(), 90000));
const sampleLabel = (value: unknown) => { const time = ObservabilityDisplay.sampleTimestamp(value); return time ? new Date(time).toLocaleTimeString() : '—'; };
const disks = computed(() => (props.resources?.disks ?? []).map(disk => ({ ...disk, usage: ObservabilityDisplay.usedMemory(disk.total_bytes, disk.available_bytes) })));
const errors = computed(() => (props.resources?.collection_errors ?? []).map(key => t(`web.observability.component_${key}`)).join(' · '));
</script>

<template>
    <section class="host-resources-panel" :aria-label="t('web.observability.host_resources')" data-testid="host-resources">
        <div class="observability-heading">
            <h3>{{ t('web.observability.host_resources') }}</h3>
            <span v-if="resources" class="text-xs muted">{{ sampleLabel(resources.sampled_at_unix_ms) }}</span>
        </div>
        <Message v-if="error" severity="warn" :closable="false">{{ t('web.observability.resources_unavailable') }}</Message>
        <Message v-else-if="!loading && !resources" severity="secondary" :closable="false">{{ t(supported === false ? 'web.observability.resources_unsupported' : supported === true ? 'web.observability.resources_unavailable' : 'web.observability.resources_old_core') }}</Message>
        <template v-else>
            <div class="resource-cards" :aria-busy="loading" :class="{ 'resource-stale': resourcesStale }">
                <article class="resource-card" data-testid="host-cpu">
                    <span>{{ t('web.observability.cpu') }}</span><strong>{{ cpu == null ? '—' : `${cpu.toFixed(1)}%` }}</strong>
                    <div class="resource-meter" aria-hidden="true"><i :style="{ width: `${cpu ?? 0}%` }" /></div>
                </article>
                <article class="resource-card" data-testid="host-memory">
                    <span>{{ t('web.observability.memory_used') }}</span><strong>{{ RuntimeDisplay.formatQuantity(memory?.used, true) }}</strong>
                    <small>{{ t('web.observability.total') }} {{ RuntimeDisplay.formatQuantity(resources?.memory_total_bytes, true) }}</small>
                    <div class="resource-meter" aria-hidden="true"><i :style="{ width: `${memory?.percent ?? 0}%` }" /></div>
                </article>
                <article class="resource-card" data-testid="host-rss">
                    <span>{{ t('web.observability.core_rss') }}</span><strong>{{ RuntimeDisplay.formatQuantity(resources?.process_rss_bytes, true) }}</strong>
                </article>
            </div>
            <p v-if="resourcesStale" class="text-xs resource-status">{{ t('web.observability.resources_stale') }}</p>
            <p v-if="errors" class="text-xs resource-status">{{ t('web.observability.collection_failed', { components: errors }) }}</p>
            <div v-if="disks.length" class="resource-disks" :class="{ 'resource-stale': disksStale }" data-testid="host-disks">
                <div class="observability-heading"><h4>{{ t('web.observability.disks') }}</h4><span class="text-xs muted">{{ sampleLabel(resources?.disks_sampled_at_unix_ms) }}</span></div>
                <div v-for="disk in disks" :key="disk.mount_point" class="resource-disk-row">
                    <span class="mono-value resource-mount">{{ disk.mount_point }}</span>
                    <span>{{ RuntimeDisplay.formatQuantity(disk.usage?.used, true) }} / {{ RuntimeDisplay.formatQuantity(disk.total_bytes, true) }}</span>
                    <strong>{{ disk.usage ? `${disk.usage.percent.toFixed(1)}%` : '—' }}</strong>
                    <div class="resource-meter" aria-hidden="true"><i :style="{ width: `${disk.usage?.percent ?? 0}%` }" /></div>
                </div>
                <p v-if="disksStale" class="text-xs resource-status">{{ t('web.observability.disks_stale') }}</p>
            </div>
        </template>
    </section>
</template>

<style scoped>
.host-resources-panel { margin-bottom: .5rem; min-width: 0; }
.observability-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .75rem; }
h3, h4 { margin: 0; font-size: .875rem; font-weight: 600; }
.resource-cards { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .75rem; }
.resource-card { display: flex; flex-direction: column; gap: .5rem; border: 1px solid var(--p-content-border-color); background: var(--p-content-background); border-radius: .6rem; padding: .85rem; }
.resource-card > span, .resource-card small { font-size: .75rem; color: var(--p-text-muted-color); }
.resource-card strong { font-size: 1.3rem; font-weight: 600; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.resource-meter { height: 4px; border-radius: 8px; background: var(--p-content-border-color); overflow: hidden; margin-top: auto; }
.resource-meter i { display: block; height: 100%; background: var(--p-primary-color); }
.resource-status { color: var(--p-text-muted-color); margin: .5rem 0; }
.resource-stale .resource-meter i { background: var(--p-text-muted-color); }
.resource-disks { margin-top: 1rem; }
.resource-disk-row { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; column-gap: .75rem; row-gap: .5rem; padding: .75rem 0; border-bottom: 1px solid var(--p-content-border-color); font-size: .75rem; }
.resource-disk-row .resource-meter { grid-column: 1 / -1; width: 100%; }
.resource-mount { overflow-wrap: anywhere; }
@media (max-width: 500px) { .resource-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } .resource-card:last-child { grid-column: 1 / -1; } .resource-card strong { font-size: 1.1rem; } .resource-disk-row { grid-template-columns: minmax(0, 1fr) auto; } .resource-disk-row > strong { grid-column: 2; grid-row: 1; } .resource-disk-row > span:nth-child(2) { grid-column: 1 / -1; } }
</style>
