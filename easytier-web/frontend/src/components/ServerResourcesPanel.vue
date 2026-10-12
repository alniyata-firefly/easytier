<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ObservabilityDisplay } from 'easytier-frontend-lib';
import ApiClient from '../modules/api';
import { useVisiblePolling } from '../modules/polling';
import HostResourcesPanel from './HostResourcesPanel.vue';

const props = defineProps<{ api: ApiClient }>();
const { t } = useI18n();
const resources = ref<ObservabilityDisplay.HostResources>(), supported = ref<boolean>();
const error = ref(''), loading = ref(false), attempted = ref(false), forbidden = ref(false), now = ref(Date.now());
let active = true, generation = 0, pending = false;
let clock: ReturnType<typeof setInterval> | undefined;

const load = async () => {
    if (!active || pending || forbidden.value || document.hidden) return;
    const request = ++generation, api = props.api;
    pending = true; loading.value = true;
    try {
        const snapshot = await api.get_server_resources();
        if (!active || request !== generation || api !== props.api) return;
        resources.value = snapshot.host_resources; supported.value = snapshot.host_resources_supported;
        error.value = ''; now.value = Date.now();
        return true;
    } catch (failure: any) {
        if (!active || request !== generation || api !== props.api) return;
        resources.value = undefined; supported.value = undefined; now.value = Date.now();
        if (failure?.response?.status === 403) { forbidden.value = true; error.value = ''; return true; }
        error.value = t('web.observability.server_resources_unavailable');
        return false;
    } finally {
        if (active && request === generation && api === props.api) { pending = false; loading.value = false; attempted.value = true; }
    }
};

const refresh = useVisiblePolling(load, 10000);
const updateClock = () => { if (!document.hidden) now.value = Date.now(); };
watch(() => props.api, () => {
    generation++; pending = false; resources.value = undefined; supported.value = undefined;
    forbidden.value = false; attempted.value = false; error.value = '';
    void refresh();
});
onMounted(() => { clock = setInterval(updateClock, 1000); document.addEventListener('visibilitychange', updateClock); });
onUnmounted(() => { active = false; generation++; clearInterval(clock); document.removeEventListener('visibilitychange', updateClock); });
defineExpose({ refresh });
</script>

<template>
    <section v-if="attempted && !forbidden" class="console-panel server-resources-panel" :aria-label="t('web.observability.server_resources')" data-testid="server-resources" :aria-busy="loading">
        <HostResourcesPanel :resources="resources" :supported="supported" :loading="loading" :error="error"
            :title="t('web.observability.server_resources')" :process-label="t('web.observability.web_rss')"
            :unavailable-label="t('web.observability.server_resources_unavailable')" :unsupported-label="t('web.observability.server_resources_unsupported')"
            :now="now" :hide-stale-values="true" />
    </section>
</template>

<style scoped>
.server-resources-panel { padding: 20px; min-width: 0; }
.server-resources-panel :deep(.observability-heading h3) { font-size: 1rem; }
.server-resources-panel :deep(.resource-card) { min-height: 128px; padding: 1rem; }
.server-resources-panel :deep(.resource-card strong) { font-size: 1.6rem; }
@media (max-width: 767px) { .server-resources-panel { padding: 16px; } .server-resources-panel :deep(.resource-card) { min-height: 116px; padding: .85rem; } .server-resources-panel :deep(.resource-card strong) { font-size: 1.3rem; } }
</style>
