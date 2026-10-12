<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { Button, Column, DataTable, Dialog, InputText, Message, Select, Tag, useToast } from 'primevue';
import { useI18n } from 'vue-i18n';
import { RuntimeDisplay } from 'easytier-frontend-lib';
import ApiClient, { type ConsoleInfo, type DeviceAccessToken } from '../modules/api';
import { enrollmentCommand } from '../modules/enrollment';
import { useVisiblePolling } from '../modules/polling';

const props = defineProps<{ api: ApiClient; visible: boolean; machineId?: string }>();
const emit = defineEmits<{ 'update:visible': [boolean] }>();
const { t } = useI18n();
const toast = useToast();
const tokens = ref<DeviceAccessToken[]>([]);
const info = ref<ConsoleInfo>();
const loading = ref(false), busy = ref(false), error = ref('');
const label = ref(''), machineId = ref(''), ttl = ref<number | null>(null);
// The secret is never stored in snapshots, browser storage, or table rows.
const secret = ref('');
let generation = 0, loadGeneration = 0;
let issuedInfo: DeviceAccessToken | undefined;
let channel: BroadcastChannel | undefined;
onMounted(() => {
    if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('easytier-device-access-tokens');
        channel.onmessage = () => { if (props.visible) void load().catch(() => {}); };
    }
});
onUnmounted(() => { generation++; loadGeneration++; secret.value = ''; issuedInfo = undefined; channel?.close(); });
const ttlOptions = computed(() => [
    { label: t('web.adaptation.no_expiry'), value: null },
    { label: t('web.network_detail.ttl_24h'), value: 86400 },
    { label: t('web.network_detail.ttl_7d'), value: 604800 },
    { label: t('web.network_detail.ttl_30d'), value: 2592000 },
]);
const command = computed(() => {
    try { return info.value && secret.value ? enrollmentCommand(info.value, secret.value) : ''; }
    catch { return ''; }
});
const status = (token: DeviceAccessToken) => token.revoked_at ? 'revoked'
    : token.expires_at && Date.parse(token.expires_at) <= Date.now() ? 'expired'
    : token.machine_id ? 'bound' : 'unbound';
const canUse = (token: DeviceAccessToken) => !['revoked', 'expired'].includes(status(token));
const load = async () => {
    const request = ++loadGeneration, view = generation;
    const server = await props.api.get_console_info();
    const records = server.webhook_auth ? [] : await props.api.list_device_access_tokens();
    if (request !== loadGeneration || view !== generation || !props.visible) return;
    info.value = server;
    tokens.value = records;
    if (server.webhook_auth) { secret.value = ''; issuedInfo = undefined; }
    if (issuedInfo) {
        const current = records.find(record => record.id === issuedInfo?.id);
        if (!current || !canUse(current) || current.auth_generation !== issuedInfo.auth_generation) { secret.value = ''; issuedInfo = undefined; }
    }
};
watch(() => props.visible, async visible => {
    generation++; loadGeneration++; secret.value = ''; issuedInfo = undefined; error.value = '';
    if (!visible) return;
    label.value = ''; machineId.value = props.machineId ?? ''; ttl.value = null;
    loading.value = true;
    const view = generation;
    try { await load(); } catch (e: any) { if (view === generation && props.visible) error.value = e?.response?.data?.message ?? t('web.console.load_failed'); }
    finally { if (view === generation) loading.value = false; }
}, { flush: 'sync' });
const action = async (operation: () => Promise<{ token: string; info: DeviceAccessToken } | void>) => {
    if (busy.value) return;
    const request = generation;
    busy.value = true; error.value = ''; secret.value = ''; issuedInfo = undefined;
    try {
        const result = await operation();
        if (request !== generation || !props.visible) return;
        if (result) { secret.value = result.token; issuedInfo = result.info; }
        channel?.postMessage('changed');
        await load();
    } catch (e: any) { if (request === generation && props.visible) error.value = e?.response?.data?.message ?? t('web.console.load_failed'); }
    finally { busy.value = false; }
};
useVisiblePolling(async () => {
    if (!props.visible || busy.value) return;
    try { await load(); return true; } catch { return false; }
}, 5000);
const create = () => action(() => props.api.create_device_access_token({
    label: label.value.trim(), machine_id: machineId.value.trim() || undefined,
    expires_in_seconds: ttl.value ?? undefined,
}));
const copy = async () => toast.add({ severity: await RuntimeDisplay.copyText(command.value) ? 'success' : 'error',
    summary: t('web.console.enroll_copy'), life: 2500 });
</script>

<template>
    <Dialog :visible="visible" @update:visible="emit('update:visible', $event)" modal class="console-dialog"
        :header="t('web.adaptation.device_tokens')" :style="{ width: 'min(65rem, 96vw)' }">
        <Message v-if="error" severity="error" :closable="false">{{ error }}</Message>
        <Message v-if="info?.webhook_auth" severity="info" :closable="false">{{ t('web.console.enroll_webhook_note') }}</Message>
        <template v-else>
            <form class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4" @submit.prevent="create">
                <label class="flex flex-col gap-1">{{ t('web.adaptation.token_label') }}<InputText v-model="label" maxlength="64" required /></label>
                <label class="flex flex-col gap-1">{{ t('web.adaptation.machine_id_optional') }}<InputText v-model="machineId" /></label>
                <label class="flex flex-col gap-1">{{ t('web.network_detail.expires_at') }}<Select v-model="ttl" :options="ttlOptions" optionLabel="label" optionValue="value" /></label>
                <Button type="submit" :label="t('web.adaptation.issue_token')" icon="pi pi-plus" :loading="busy" :disabled="loading || !label.trim()" />
            </form>
            <section v-if="secret" class="p-3 rounded mb-4" style="background: var(--console-ground)">
                <Message severity="warn" :closable="false">{{ t('web.adaptation.one_time_token') }}</Message>
                <div class="flex items-start gap-2 mt-3"><code class="mono-value break-all flex-1">{{ command || t('web.adaptation.invalid_entry') }}</code>
                    <Button icon="pi pi-copy" :aria-label="t('web.console.enroll_copy')" :disabled="!command" @click="copy" /></div>
                <p class="text-xs muted mt-2">{{ t('web.adaptation.management_only') }}</p>
            </section>
            <DataTable :value="tokens" dataKey="id" :loading="loading" class="console-table" size="small" :paginator="tokens.length > 10" :rows="10">
                <Column field="label" :header="t('web.adaptation.token_label')" />
                <Column field="machine_id" :header="t('web.adaptation.device_id')"><template #body="{ data }"><span class="mono-value">{{ data.machine_id || '—' }}</span></template></Column>
                <Column :header="t('web.device.status')"><template #body="{ data }"><Tag :value="t(`web.adaptation.token_${status(data)}`)" :severity="canUse(data) ? 'success' : 'secondary'" /></template></Column>
                <Column :header="t('web.device.last_seen')"><template #body="{ data }">{{ data.last_used_at || '—' }}</template></Column>
                <Column :header="t('web.network_detail.expires_at')"><template #body="{ data }">{{ data.expires_at || t('web.adaptation.no_expiry') }}</template></Column>
                <Column :header="t('web.console.manage')"><template #body="{ data }"><div class="flex gap-2">
                    <Button size="small" severity="secondary" :label="t('web.adaptation.rotate_token')" :disabled="busy || !canUse(data)" @click="action(() => api.rotate_device_access_token(data.id))" />
                    <Button size="small" severity="danger" :label="t('web.adaptation.revoke_token')" :disabled="busy || !!data.revoked_at" @click="action(() => api.revoke_device_access_token(data.id))" />
                </div></template></Column>
            </DataTable>
        </template>
    </Dialog>
</template>
