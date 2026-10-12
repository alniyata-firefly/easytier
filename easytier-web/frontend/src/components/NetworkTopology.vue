<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { Button, Message } from 'primevue';
import { RuntimeDisplay } from 'easytier-frontend-lib';
import { useI18n } from 'vue-i18n';
import ApiClient, { type CentralNetworkMember, type NodePeerInfo, type NodeRouteInfo, type NodeRuntimeInfo, type TemporaryPeer, type NetworkDeployment } from '../modules/api';
import { useVisiblePolling } from '../modules/polling';

const props = defineProps<{ api: ApiClient; networkId: string; members: CentralNetworkMember[]; temporaryPeers?: TemporaryPeer[]; gateway?: NetworkDeployment['gateway'] }>();
const { t } = useI18n();
type Observation = { deviceId: string; info?: NodeRuntimeInfo; peers: NodePeerInfo[]; routes: NodeRouteInfo[] };
const observations = ref<Observation[]>([]), refreshed = ref(''), error = ref(''), loading = ref(false);
let generation = 0;
const load = async () => {
    if (loading.value || document.hidden) return;
    const request = ++generation, networkId = props.networkId;
    loading.value = true;
    try {
        const records = await Promise.allSettled(props.members.filter(m => m.online).map(async member => {
            const [info, peers, routes] = await Promise.all([
                props.api.get_node_info(member.device_id, networkId),
                props.api.get_node_peers(member.device_id, networkId),
                props.api.get_node_routes(member.device_id, networkId),
            ]);
            return { deviceId: member.device_id, info, peers, routes };
        }));
        if (request !== generation || networkId !== props.networkId) return;
        observations.value = records.flatMap(record => record.status === 'fulfilled' ? [record.value] : []);
        error.value = records.some(record => record.status === 'rejected') ? t('web.adaptation.topology_partial') : '';
        refreshed.value = new Date().toLocaleTimeString();
    } finally { loading.value = false; }
};
watch(() => props.networkId, () => { generation++; observations.value = []; refreshed.value = ''; });
useVisiblePolling(load, 8000);
onUnmounted(() => { generation++; });
const externalTemporaryPeers = computed(() => {
    const managed = new Set(props.members.flatMap(member => member.credential_id ? [member.credential_id] : []));
    return (props.temporaryPeers ?? []).filter(peer => !peer.credential_id || !managed.has(peer.credential_id));
});
const nodes = computed(() => [...props.members, ...externalTemporaryPeers.value.map(peer => ({
    device_id: `temporary:${peer.peer_id}`, hostname: peer.hostname, runtime_virtual_ipv4: peer.ipv4,
    hostname_override: null, alias: null, virtual_ipv4: null, allocated_ipv4: null, online: true,
})), ...(props.gateway ? [{ device_id: 'gateway', hostname: 'Gateway', hostname_override: null,
    alias: null, runtime_virtual_ipv4: props.gateway.peer_url || null, virtual_ipv4: null, allocated_ipv4: null,
    online: props.gateway.running,
}] : [])].map((member, index, all) => {
    const angle = 2 * Math.PI * index / Math.max(all.length, 1) - Math.PI / 2;
    return { ...member, name: member.hostname_override || member.alias || member.hostname || member.device_id.slice(0, 8),
        x: all.length === 1 ? 420 : 420 + Math.cos(angle) * 275,
        y: all.length === 1 ? 260 : 260 + Math.sin(angle) * 185 };
}));
const edges = computed(() => {
    const nodeByDevice = new Map(nodes.value.map(node => [node.device_id, node]));
    const deviceByPeer = new Map(observations.value.flatMap(observation => observation.info?.peer_id == null
        ? [] : [[observation.info.peer_id, observation.deviceId] as const]));
    if (props.gateway?.running && props.gateway.peer_id != null) deviceByPeer.set(props.gateway.peer_id, 'gateway');
    for (const peer of externalTemporaryPeers.value) deviceByPeer.set(peer.peer_id, `temporary:${peer.peer_id}`);
    const result = new Map<string, { from: typeof nodes.value[number]; to: typeof nodes.value[number]; direct: boolean; label: string }>();
    for (const observation of observations.value) {
        const from = nodeByDevice.get(observation.deviceId);
        if (!from) continue;
        for (const peer of observation.peers) {
            const targetId = deviceByPeer.get(peer.peer_id), to = targetId && nodeByDevice.get(targetId);
            const conns = peer.conns?.filter(conn => conn.is_closed !== true && conn.tunnel) ?? [];
            if (!to || to === from || !conns.length) continue;
            const key = [from.device_id, to.device_id].sort().join(':');
            const protocols = [...new Set(conns.map(conn => {
                const remote = conn.tunnel?.remote_addr?.url;
                return `${conn.tunnel?.tunnel_type ?? '?'} ${RuntimeDisplay.endpointFamily(remote)}`.trim();
            }))];
            result.set(key, { from, to, direct: true, label: protocols.join(' / ') });
        }
        // A route alone only proves a logical route. Draw it dashed and state the next hop.
        for (const route of observation.routes) {
            const targetId = deviceByPeer.get(route.peer_id), to = targetId && nodeByDevice.get(targetId);
            if (!to || to === from) continue;
            const key = [from.device_id, to.device_id].sort().join(':');
            if (!result.has(key)) result.set(key, { from, to, direct: false, label: `${t('web.adaptation.next_hop')} #${route.next_hop_peer_id}` });
        }
    }
    return [...result.entries()].map(([key, value]) => ({ key, ...value }));
});
</script>

<template>
    <section class="console-panel">
        <header class="section-heading"><h2>{{ t('web.adaptation.topology') }}</h2><div class="flex items-center gap-3 text-xs muted">
            <span>{{ t('web.adaptation.topology_legend') }}</span><span>{{ refreshed || '—' }}</span>
            <Button icon="pi pi-refresh" :aria-label="t('web.console.refresh')" text :loading="loading" @click="load" />
        </div></header>
        <Message v-if="error" severity="warn" :closable="false">{{ error }}</Message>
        <svg v-if="nodes.length" viewBox="0 0 840 520" role="img" :aria-label="t('web.adaptation.topology')" class="topology-map">
            <g v-for="edge in edges" :key="edge.key">
                <line :x1="edge.from.x" :y1="edge.from.y" :x2="edge.to.x" :y2="edge.to.y" :class="{ logical: !edge.direct }" />
                <text :x="(edge.from.x + edge.to.x) / 2" :y="(edge.from.y + edge.to.y) / 2 - 8" class="edge-label">{{ edge.label }}</text>
            </g>
            <g v-for="node in nodes" :key="node.device_id" :transform="`translate(${node.x}, ${node.y})`">
                <circle r="25" :class="{ offline: !node.online }" /><text y="5" class="node-icon">◇</text>
                <text y="43" class="node-name">{{ node.name }}</text><text y="62" class="node-address">{{ node.runtime_virtual_ipv4 || node.virtual_ipv4 || node.allocated_ipv4 || '—' }}</text>
            </g>
        </svg>
        <div v-else class="console-empty-state">{{ t('web.console.networks_empty') }}</div>
    </section>
</template>

<style scoped>
.topology-map { width: 100%; min-height: 280px; max-height: 620px; }
line { stroke: var(--p-primary-color); stroke-width: 2; opacity: .8; }
line.logical { stroke: var(--console-muted); stroke-dasharray: 6 6; opacity: .55; }
circle { fill: var(--console-panel); stroke: var(--p-primary-color); stroke-width: 2; }
circle.offline { stroke: var(--console-muted); stroke-dasharray: 3 3; }
text { text-anchor: middle; fill: var(--p-text-color); font-size: 12px; paint-order: stroke; stroke: var(--console-panel); stroke-width: 4px; stroke-linejoin: round; }
.node-name { font-weight: 600; }.node-icon { font-size: 24px; }.node-address,.edge-label { font-size: 10px; fill: var(--console-muted); }
</style>
