import { normalizeUplinkInventory } from '../../../frontend-lib/src/modules/uplinkInventoryRpc';
import axios, { AxiosError, AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import type * as Api from '../../../frontend-lib/src/modules/api';
import type * as NetworkTypes from '../../../frontend-lib/src/types/network';
import type * as Utils from '../../../frontend-lib/src/modules/utils';
import * as RuntimeDisplay from '../../../frontend-lib/src/modules/runtimeDisplay';
import * as ObservabilityDisplay from '../../../frontend-lib/src/modules/observabilityDisplay';
import { Md5 } from 'ts-md5';

// Keep the existing UUID wire conversion independent of the configuration codecs.
function strToUuid(uuid: string): Utils.UUID {
    const hex = uuid.replace(/-/g, '');
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
        throw new Error(`Invalid UUID: ${uuid}`);
    }
    return {
        part1: Number.parseInt(hex.slice(0, 8), 16),
        part2: Number.parseInt(hex.slice(8, 16), 16),
        part3: Number.parseInt(hex.slice(16, 24), 16),
        part4: Number.parseInt(hex.slice(24, 32), 16),
    };
}

export interface ValidateConfigResponse {
    toml_config: string;
}

export interface OidcConfigResponse {
    enabled: boolean;
}

// 定义接口返回的数据结构
export interface LoginResponse {
    success: boolean;
    message: string;
}

export interface RegisterResponse {
    success: boolean;
    message: string;
}

// 定义请求体数据结构
export interface Credential {
    username: string;
    password: string;
}

export interface RegisterData {
    credentials: Credential;
    captcha: string;
}

export interface Summary {
    device_count: number;
}

export interface ManagementConnectionEvent {
    id: number;
    device_id: string;
    event: 'authorized' | 'disconnected' | 'authentication_rejected' | 'pending_approval' | 'configuration_apply_failed';
    reason: string;
    occurred_at: number;
    peer_ip?: string | null;
    instance_id?: string | null;
}

export interface ManagementConnectionEventPage {
    events: ManagementConnectionEvent[];
    next_before_id: number | null;
}

export type ServerLogLevel = 'INFO' | 'WARN' | 'ERROR';
export interface ServerLogEntry {
    id: number;
    occurred_at: number;
    level: ServerLogLevel;
    target: string;
    message: string;
    fields: Record<string, string>;
}
export interface ServerLogQuery {
    level?: ServerLogLevel;
    target?: string;
    q?: string;
    before_id?: number;
    limit?: number;
}
export interface ServerLogPage {
    entries: ServerLogEntry[];
    next_before_id: number | null;
    instance_id: string;
    started_at: number;
    capacity: number;
    dropped_entries: number;
}

export interface ListNetworkInstanceIdResponse {
    running_inst_ids: Array<Utils.UUID>,
    disabled_inst_ids: Array<Utils.UUID>,
}

export interface GenerateConfigRequest {
    config: NetworkTypes.NetworkConfig;
}

export interface GenerateConfigResponse {
    toml_config?: string;
    error?: string;
}

export interface ParseConfigRequest {
    toml_config: string;
}

export interface ParseConfigResponse {
    config?: NetworkTypes.NetworkConfig;
    error?: string;
}

export interface CentralNetworkTransport {
    data_compress_algo?: 1 | 2;
    encryption_algorithm?: string;
    disable_encryption?: boolean;
    default_protocol?: string;
    tld_dns_zone?: string;
    enable_kcp_proxy?: boolean;
    disable_kcp_input?: boolean;
    enable_quic_proxy?: boolean;
    disable_quic_input?: boolean;
}

export interface CentralNetworkSettings {
    display_name: string;
    network_name?: string | null;
    networking_method: string;
    public_server_url?: string | null;
    peer_urls: string[];
    virtual_cidr?: string | null;
    secure_mode?: boolean;
    prefer_ipv6?: boolean;
    transport?: CentralNetworkTransport;
}

export interface CentralNetworkSummary {
    network_id: string;
    display_name: string;
    network_name: string;
    networking_method: string;
    virtual_cidr?: string | null;
    secure_mode?: boolean;
    prefer_ipv6?: boolean;
    member_count: number;
    online_member_count: number;
}

export interface DeploymentStatus {
    state: 'waiting_offline' | 'pending' | 'applied' | 'failed' | 'unknown';
    desired_revision?: string | null;
    applied_revision?: string | null;
    last_error?: string | null;
}

export interface NetworkDeployment extends DeploymentStatus {
    devices: Array<DeploymentStatus & { device_id: string }>;
    gateway?: (DeploymentStatus & { running: boolean; peer_id?: number | null; peer_url?: string | null }) | null;
}

export interface CentralNetworkDetail extends Omit<CentralNetworkSummary, 'online_member_count'> {
    deployment?: NetworkDeployment;
    network_secret: string;
    virtual_cidr?: string | null;
    public_server_url?: string | null;
    peer_urls: string[];
    transport?: CentralNetworkTransport;
}

export interface CentralNetworkMember {
    deployment?: DeploymentStatus;
    member_id: string;
    device_id: string;
    hostname: string | null;
    hostname_override: string | null;
    alias?: string | null;
    virtual_ipv4: string | null;
    allocated_ipv4?: string | null;
    online: boolean;
    running: boolean | null;
    runtime_virtual_ipv4: string | null;
    version: string | null;
    error_msg: string | null;
    runtime_query_error?: 'timeout' | 'unavailable' | null;
    has_override?: boolean;
    proxy_cidrs?: string[];
    temporary?: boolean;
    credential_id?: string | null;
    credential_expiry_unix?: number | null;
}

export interface GatewayInfo {
    enabled: boolean;
    peer_url?: string;
    relay_data: boolean;
}

export interface NodeRouteInfo {
    peer_id: number;
    hostname: string;
    ipv4_addr?: { address?: { addr?: number }, network_length?: number } | null;
    cost: number;
    ipv6_addr?: { address?: NetworkTypes.Ipv6Addr; network_length?: number } | null;
    stun_info?: NetworkTypes.StunInfo;
    path_latency: number;
    proxy_cidrs: string[];
    version: string;
    next_hop_peer_id: number;
}

export interface NodePeerConn {
    conn_id: string;
    tunnel?: { tunnel_type?: string, local_addr?: any, remote_addr?: any } | null;
    stats?: { latency_us?: number | string, rx_bytes?: number | string, tx_bytes?: number | string } | null;
    loss_rate?: number;
    is_closed?: boolean;
}

export interface NodePeerInfo {
    peer_id: number;
    conns: NodePeerConn[];
}

export interface NodeAclRuleStat {
    rule?: { name?: string };
    stat?: { packet_count?: number | string, byte_count?: number | string };
}

export interface MetricSnapshot { name: string; value?: number | string; labels?: Record<string, string>; }
export interface NodeStatsSnapshot { metrics: MetricSnapshot[]; host_resources?: ObservabilityDisplay.HostResources; host_resources_supported?: boolean; }
export interface ServerResourcesSnapshot { host_resources_supported: boolean; host_resources?: ObservabilityDisplay.HostResources; }
export interface ObservabilityCapabilities { history_available: boolean; collector_enabled: boolean; min_step_seconds: number; max_range_seconds: number; max_points_per_series: number; metrics: Array<{ id: string; unit: string }>; }
export interface MetricHistory { available: boolean; metric: string; unit: string; start: number; end: number; step: number; series: ObservabilityDisplay.HistorySeries[]; }

export interface InterfaceNetwork { name: string; address: { ipv4?: NetworkTypes.Ipv4Addr; ipv6?: NetworkTypes.Ipv6Addr }; prefix_length?: number; }

export interface NodeRuntimeInfo { peer_id?: number; hostname?: string; ipv4_addr?: string; public_ipv6_addr?: { address?: NetworkTypes.Ipv6Addr; network_length?: number }; stun_info?: NetworkTypes.StunInfo; ip_list?: { interface_networks?: InterfaceNetwork[]; interface_ipv4s?: NetworkTypes.Ipv4Addr[]; interface_ipv6s?: NetworkTypes.Ipv6Addr[] }; }

export interface DeviceAccessToken { status?: string; id: string; label: string; machine_id?: string | null; created_at: string; bound_at?: string | null; last_used_at?: string | null; expires_at?: string | null; revoked_at?: string | null; auth_generation?: number; }

export interface DeviceRebindRequest {
    id: string;
    token_id: string;
    token_label: string;
    old_machine_id: string;
    new_machine_id: string;
    old_device_alias?: string | null;
    old_hostname?: string | null;
    hostname: string;
    easytier_version: string;
    device_os: string;
    created_at: string;
    last_seen_at: string;
    attempt_count: number;
    status: string;
}

export interface DeviceRebindApproval {
    request_id: string;
    old_machine_id: string;
    new_machine_id: string;
    token_id: string;
    auth_generation: number;
}

export interface CredentialGrant { acl_groups?: string[]; allow_relay?: boolean; allowed_proxy_cidrs?: string[]; device_id?: string | null; }

export interface NetworkCredential extends CredentialGrant {
    credential_id: string;
    credential_secret: string;
    expiry_unix: number;
    reusable: boolean;
    online_peers: TemporaryPeer[];
}

/// A device currently online through a credential; `credential_id` is null
/// when it matches no stored credential anymore (e.g. revoked mid-flight).
export interface TemporaryPeer {
    peer_id: number;
    credential_id: string | null;
    credential_expiry_unix: number | null;
    hostname: string | null;
    ipv4: string | null;
    version: string | null;
}

export interface BlockedDevice {
    id: string;
    user_id: number;
    hostname: string;
    alias?: string | null;
    blocked_time: string;
    attempt_count: number;
    last_attempt_time?: string | null;
}

export interface ConsoleInfo {
    username: string;
    advertised_config_server_url?: string | null;
    registration_enabled?: boolean;
    config_server_protocol: string;
    config_server_port: number;
    webhook_auth: boolean;
    server_logs_access?: boolean;
}

export type AclSelector =
    | { type: 'all' }
    | { type: 'member'; member_id: string }
    | { type: 'subnet'; member_id: string; cidrs: string[] }
    | { type: 'group'; name: string };

export interface AclProtocolTarget {
    protocol: 'tcp' | 'udp' | 'icmp' | 'icmpv6' | 'any';
    ports: string[];
    stateful: boolean;
}

export interface AclPolicyRule {
    id: string;
    name: string;
    enabled: boolean;
    action: 'allow' | 'deny';
    sources: AclSelector[];
    destinations: AclSelector[];
    protocols: AclProtocolTarget[];
}

export interface AclPolicy {
    default_action: 'allow' | 'deny';
    rules: AclPolicyRule[];
}

export interface AclPolicyInfo {
    policy: AclPolicy;
}

export class ApiClient {
    private client: AxiosInstance;
    private authFailedCb: Function | undefined;
    private snapshots = new Map<string, { time: number; promise: Promise<any> }>();
    private cacheGeneration = 0;

    public clear_snapshots() { this.cacheGeneration++; this.snapshots.clear(); }
    private snapshot<T>(key: string, request: () => Promise<T>): Promise<T> {
        const old = this.snapshots.get(key);
        if (old && Date.now() - old.time < 2000) return old.promise;
        const generation = this.cacheGeneration;
        const promise = request().catch(error => {
            if (generation === this.cacheGeneration && this.snapshots.get(key)?.promise === promise) this.snapshots.delete(key);
            throw error;
        });
        this.snapshots.set(key, { time: Date.now(), promise });
        return promise;
    }

    constructor(baseUrl: string, authFailedCb: Function | undefined = undefined) {
        this.client = axios.create({
            baseURL: baseUrl.replace(/\/+$/, '') + '/api/v1',
            withCredentials: true, // 如果需要支持跨域携带cookie
            headers: {
                'Content-Type': 'application/json',
            },
        });
        this.authFailedCb = authFailedCb;

        // 添加请求拦截器
        this.client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
            const readonlyRpc = config.url?.endsWith('/proxy-rpc') && ['list_route', 'list_peer', 'get_acl_stats', 'show_node_info', 'get_stats', 'get_prometheus_stats', 'get_logger_config', 'get_vpn_portal_info', 'get_network_interfaces'].includes(config.data?.method_name);
            if (config.method && !['get', 'head'].includes(config.method.toLowerCase()) && !readonlyRpc) this.clear_snapshots();
            return config;
        }, (error: any) => {
            return Promise.reject(error);
        });

        // 添加响应拦截器
        this.client.interceptors.response.use((response: AxiosResponse) => {
            // Responses may contain one-time device tokens or network credentials.
            // Never log response bodies.
            return response.data; // 假设服务器返回的数据都在data属性中
        }, (error: any) => {
            if (error.response) {
                let response: AxiosResponse = error.response;
                if (response.status == 401 && this.authFailedCb) {
                    this.clear_snapshots();
                    this.authFailedCb();
                } else if (!(response.status === 403 && response.config.url === '/server/resources')) {
                    // 请求已发出，但是服务器响应的状态码不在2xx范围
                    console.error('API request failed:', response.status);
                }
            } else if (error.request) {
                // 请求已发出，但是没有收到响应
                console.error('API request did not receive a response');
            } else {
                // 发生了一些问题导致请求未发出
                console.error('Error:', error.message);
            }
            return Promise.reject(error);
        });
    }

    // 注册
    public async register(data: RegisterData): Promise<RegisterResponse> {
        try {
            data.credentials.password = Md5.hashStr(data.credentials.password);
            await this.client.post<RegisterResponse>('/auth/register', data);
            this.clear_snapshots();
            return { success: true, message: 'Register success', };
        } catch (error) {
            if (error instanceof AxiosError) {
                return { success: false, message: 'Failed to register, error: ' + JSON.stringify(error.response?.data), };
            }
            return { success: false, message: 'Unknown error, error: ' + error, };
        }
    }

    // 登录
    public async login(data: Credential): Promise<LoginResponse> {
        try {
            data.password = Md5.hashStr(data.password);
            await this.client.post<any>('/auth/login', data);
            this.clear_snapshots();
            return { success: true, message: 'Login success', };
        } catch (error) {
            if (error instanceof AxiosError) {
                if (error.response?.status === 401) {
                    return { success: false, message: 'Invalid username or password', };
                } else {
                    return { success: false, message: 'Unknown error, status code: ' + error.response?.status, };
                }
            }
            return { success: false, message: 'Unknown error, error: ' + error, };
        }
    }

    public async logout() {
        this.clear_snapshots();
        await this.client.get('/auth/logout');
        if (this.authFailedCb) {
            this.authFailedCb();
        }
    }

    public async change_password(new_password: string) {
        await this.client.put('/auth/password', { new_password: Md5.hashStr(new_password) });
    }

    public async check_login_status() {
        try {
            await this.client.get('/auth/check_login_status');
            return true;
        } catch (error) {
            return false;
        }
    }

    public async list_session() {
        const response = await this.client.get('/sessions');
        return response;
    }

    public async list_machines(): Promise<Array<any>> {
        return this.snapshot('machines', async () => {
            const response = await this.client.get<any, Record<string, Array<any>>>('/machines');
            return response.machines;
        });
    }

    public async list_management_connection_events(options: { device_id?: string; before_id?: number; limit?: number } = {}): Promise<ManagementConnectionEventPage> {
        return this.client.get<any, ManagementConnectionEventPage>('/management-connection-events', { params: options });
    }

    public async list_server_logs(options: ServerLogQuery = {}): Promise<ServerLogPage> {
        return this.client.get<any, ServerLogPage>('/server/logs', { params: options });
    }

    public async get_node_runtime_infos(machine_id: string): Promise<Record<string, NetworkTypes.NetworkInstanceRunningInfo>> {
        const response = await this.client.get<any, Api.CollectNetworkInfoResponse>(`/machines/${encodeURIComponent(machine_id)}/networks/info`);
        return Object.fromEntries(Object.entries(response.info?.map ?? {}).flatMap(([id, info]) => {
            const runtime = RuntimeDisplay.normalizeNetworkRuntime(info);
            return runtime ? [[id, { ...runtime, running: runtime.running ?? false }]] : [];
        }));
    }

    public async delete_machine(machine_id: string, block = false): Promise<undefined> {
        await this.client.delete(`/machines/${machine_id}`, { params: block ? { block: true } : {} });
    }

    public async update_machine_alias(machine_id: string, alias: string): Promise<undefined> {
        await this.client.put(`/machines/${machine_id}/alias`, { alias });
    }

    public async list_blocked_devices(): Promise<BlockedDevice[]> {
        const response = await this.client.get<any, { blocked: BlockedDevice[] }>('/blocked-devices');
        return response.blocked;
    }

    public async list_device_rebind_requests(): Promise<DeviceRebindRequest[]> {
        const response = await this.client.get<any, { requests: DeviceRebindRequest[] }>('/device-rebind-requests');
        return response.requests;
    }

    public async approve_device_rebind_request(id: string): Promise<DeviceRebindApproval> {
        return this.client.post<any, DeviceRebindApproval>(`/device-rebind-requests/${encodeURIComponent(id)}/approve`);
    }

    public async reject_device_rebind_request(id: string): Promise<void> {
        await this.client.post(`/device-rebind-requests/${encodeURIComponent(id)}/reject`);
    }

    public async unblock_device(machine_id: string): Promise<undefined> {
        await this.client.delete(`/blocked-devices/${machine_id}`);
    }

    public async get_console_info(): Promise<ConsoleInfo> {
        const response = await this.client.get<any, ConsoleInfo>('/console-info');
        return response;
    }

    public async get_summary(): Promise<Summary> {
        return this.snapshot('summary', () => this.client.get<any, Summary>('/summary'));
    }

    // --- Central networks ---

    public async list_networks(): Promise<CentralNetworkSummary[]> {
        return this.snapshot('networks', async () => {
            const response = await this.client.get<any, { networks: CentralNetworkSummary[] }>('/networks');
            return response.networks;
        });
    }

    public async create_network(settings: CentralNetworkSettings, network_secret?: string): Promise<CentralNetworkDetail> {
        return await this.client.post<any, CentralNetworkDetail>('/networks', {
            settings,
            network_secret,
        });
    }

    public async get_network(network_id: string): Promise<CentralNetworkDetail> {
        return await this.client.get<any, CentralNetworkDetail>(`/networks/${network_id}`);
    }

    public async update_network(network_id: string, settings: CentralNetworkSettings, network_secret?: string): Promise<CentralNetworkDetail> {
        return await this.client.patch<any, CentralNetworkDetail>(`/networks/${network_id}`, {
            settings,
            network_secret,
        });
    }

    public async delete_network(network_id: string): Promise<undefined> {
        await this.client.delete(`/networks/${network_id}`);
    }

    public async list_network_members(network_id: string): Promise<{ members: CentralNetworkMember[]; temporary_peers: TemporaryPeer[] }> {
        const response = await this.client.get<any, { members: CentralNetworkMember[]; temporary_peers?: TemporaryPeer[] }>(`/networks/${network_id}/members`);
        return { members: response.members, temporary_peers: response.temporary_peers ?? [] };
    }

    public async add_network_members(network_id: string, device_ids: string[], temporary = false, ttl_seconds?: number): Promise<undefined> {
        await this.client.post(`/networks/${network_id}/members`, { device_ids, temporary, ttl_seconds });
    }

    public async get_network_acl_policy(network_id: string): Promise<AclPolicyInfo> {
        const response = await this.client.get<any, AclPolicyInfo>(`/networks/${network_id}/acl-policy`);
        return response;
    }

    public async update_network_acl_policy(network_id: string, policy: AclPolicy): Promise<AclPolicyInfo> {
        const response = await this.client.put<any, AclPolicyInfo>(`/networks/${network_id}/acl-policy`, policy);
        return response;
    }

    public async update_network_member(network_id: string, device_id: string, update: { hostname_override?: string | null, virtual_ipv4?: string | null, proxy_cidrs?: string[] }): Promise<CentralNetworkMember> {
        return await this.client.patch<any, CentralNetworkMember>(`/networks/${network_id}/members/${device_id}`, update);
    }

    public async remove_network_member(network_id: string, device_id: string): Promise<undefined> {
        await this.client.delete(`/networks/${network_id}/members/${device_id}`);
    }

    // --- Node runtime detail (per network instance, via proxy-rpc) ---

    public async get_node_routes(machine_id: string, inst_id: string): Promise<NodeRouteInfo[]> {
        const response = await this.client.post<any, { routes?: NodeRouteInfo[] }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.PeerManageRpcService',
            method_name: 'list_route',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return response.routes ?? [];
    }

    public async get_node_peers(machine_id: string, inst_id: string): Promise<NodePeerInfo[]> {
        const response = await this.client.post<any, { peer_infos?: NodePeerInfo[] }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.PeerManageRpcService',
            method_name: 'list_peer',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return RuntimeDisplay.normalizePeerInfos(response.peer_infos ?? []);
    }

    public async get_node_acl_stats(machine_id: string, inst_id: string): Promise<NodeAclRuleStat[]> {
        const response = await this.client.post<any, { acl_stats?: { rules?: NodeAclRuleStat[] } }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.AclManageRpcService',
            method_name: 'get_acl_stats',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return response.acl_stats?.rules ?? [];
    }

    public async get_member_config(network_id: string, device_id: string): Promise<any> {
        return await this.client.get(`/networks/${network_id}/members/${device_id}/config`);
    }

    public async set_member_config(network_id: string, device_id: string, config: object): Promise<CentralNetworkMember> {
        return await this.client.put(`/networks/${network_id}/members/${device_id}/config`, { config });
    }

    public async clear_member_config(network_id: string, device_id: string): Promise<undefined> {
        await this.client.delete(`/networks/${network_id}/members/${device_id}/config`);
    }

    /// Full TOML config of the member's instance (what `easytier-cli node
    /// config` prints), via proxy-rpc.
    public async get_node_toml_config(machine_id: string, inst_id: string): Promise<string> {
        const response = await this.client.post<any, { node_info?: { config?: string } }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.PeerManageRpcService',
            method_name: 'show_node_info',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return response.node_info?.config ?? '';
    }

    /// Device-wide logger level (0=disabled .. 5=trace), via proxy-rpc.
    public async get_node_logger_level(machine_id: string): Promise<number> {
        const response = await this.client.post<any, { level?: number | string }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.logger.LoggerRpcService',
            method_name: 'get_logger_config',
            payload: {},
        });
        const level = response.level ?? 0;
        return typeof level === 'number' ? level
            : ['DISABLED', 'ERROR', 'WARNING', 'INFO', 'DEBUG', 'TRACE'].indexOf(level);
    }

    public async set_node_logger_level(machine_id: string, level: number): Promise<undefined> {
        await this.client.post(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.logger.LoggerRpcService',
            method_name: 'set_logger_config',
            payload: { level },
        });
    }

    /// Interface IPv4 addresses reported by the device (per instance),
    /// used to suggest selectable subnets in the member editor.
    public async get_node_interface_ips(machine_id: string, inst_id: string): Promise<number[]> {
        const response = await this.client.post<any, {
            node_info?: { ip_list?: { interface_ipv4s?: Array<{ addr?: number }> } },
        }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.PeerManageRpcService',
            method_name: 'show_node_info',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return (response.node_info?.ip_list?.interface_ipv4s ?? [])
            .map(entry => entry.addr)
            .filter((addr): addr is number => addr != null);
    }

    public async list_credentials(network_id: string): Promise<NetworkCredential[]> {
        const response = await this.client.get<any, { credentials: NetworkCredential[] }>(`/networks/${network_id}/credentials`);
        return response.credentials;
    }

    public async generate_credential(network_id: string, ttl_seconds: number, reusable = true, credential_id?: string, grant?: CredentialGrant): Promise<NetworkCredential> {
        return await this.client.post<any, NetworkCredential>(`/networks/${network_id}/credentials`, {
            ttl_seconds,
            reusable,
            credential_id,
            ...grant,
        });
    }

    public async revoke_credential(network_id: string, credential_id: string): Promise<undefined> {
        await this.client.delete(`/networks/${network_id}/credentials/${encodeURIComponent(credential_id)}`);
    }

    public async get_gateway_info(): Promise<GatewayInfo> {
        return await this.client.get<any, GatewayInfo>('/networks/gateway-info');
    }

    public async get_auth_config(): Promise<{ registration_enabled: boolean }> {
        const response = await axios.get<{ registration_enabled: boolean; oidc_enabled?: boolean }>(this.client.defaults.baseURL!.replace(/\/api\/v1$/, '') + '/auth/config', { withCredentials: true });
        return response.data;
    }

    public async list_device_access_tokens(): Promise<DeviceAccessToken[]> {
        const response = await this.client.get<any, { tokens: DeviceAccessToken[] }>('/device-access-tokens');
        return response.tokens;
    }
    public async create_device_access_token(data: { label: string; machine_id?: string; expires_in_seconds?: number }): Promise<{ token: string; info: DeviceAccessToken }> {
        return this.client.post<any, { token: string; info: DeviceAccessToken }>('/device-access-tokens', data);
    }
    public async rotate_device_access_token(id: string): Promise<{ token: string; info: DeviceAccessToken }> {
        return this.client.post<any, { token: string; info: DeviceAccessToken }>(`/device-access-tokens/${encodeURIComponent(id)}/rotate`);
    }
    public async revoke_device_access_token(id: string): Promise<void> {
        await this.client.delete(`/device-access-tokens/${encodeURIComponent(id)}`);
    }
    public async get_node_info(machine_id: string, inst_id: string): Promise<NodeRuntimeInfo | undefined> {
        const response = await this.client.post<any, { node_info?: NodeRuntimeInfo }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.PeerManageRpcService', method_name: 'show_node_info',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return response.node_info;
    }
    public async get_node_stats(machine_id: string, inst_id: string): Promise<MetricSnapshot[]> {
        return (await this.get_node_stats_snapshot(machine_id, inst_id)).metrics;
    }
    public async get_server_resources(): Promise<ServerResourcesSnapshot> {
        const response = await this.client.get<any, ServerResourcesSnapshot>('/server/resources', { timeout: 10000 });
        if (typeof response.host_resources_supported !== 'boolean') throw new Error('Invalid server resources response');
        return { host_resources_supported: response.host_resources_supported,
            host_resources: ObservabilityDisplay.normalizeHostResources(response.host_resources) };
    }
    public async get_node_stats_snapshot(machine_id: string, inst_id: string): Promise<NodeStatsSnapshot> {
        const response = await this.client.post<any, Partial<NodeStatsSnapshot>>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.StatsRpcService', method_name: 'get_stats',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return { metrics: RuntimeDisplay.normalizeMetrics(response.metrics),
            host_resources: ObservabilityDisplay.normalizeHostResources(response.host_resources),
            host_resources_supported: response.host_resources_supported };
    }
    public async get_observability_capabilities(): Promise<ObservabilityCapabilities> {
        return this.client.get<any, ObservabilityCapabilities>('/observability/capabilities', { timeout: 10000 });
    }
    public async get_node_metrics_history(machine_id: string, inst_id: string, metric: string, start: number, end: number, step: number): Promise<MetricHistory> {
        const response = await this.client.get<any, MetricHistory>(`/machines/${encodeURIComponent(machine_id)}/networks/${encodeURIComponent(inst_id)}/metrics/history`, { params: { metric, start, end, step }, timeout: 20000 });
        return { ...response, series: (response.series ?? []).map(series => ({ labels: series.labels ?? {}, values: ObservabilityDisplay.historyPoints(series.values, response.step) })) };
    }
    public async get_node_prometheus_stats(machine_id: string, inst_id: string): Promise<string> {
        const response = await this.client.post<any, { prometheus_text?: string }>(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.instance.StatsRpcService', method_name: 'get_prometheus_stats',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return response.prometheus_text ?? '';
    }
    public async get_node_http_metrics(machine_id: string, inst_id: string): Promise<string> {
        return this.client.get<any, string>(`/machines/${encodeURIComponent(machine_id)}/networks/${encodeURIComponent(inst_id)}/metrics`, { responseType: 'text' });
    }
    public async update_credential(network_id: string, credential_id: string, update: CredentialGrant & { ttl_seconds?: number; reusable?: boolean; rotate_secret?: boolean }): Promise<NetworkCredential> {
        return this.client.patch<any, NetworkCredential>(`/networks/${network_id}/credentials/${encodeURIComponent(credential_id)}`, update);
    }

    public captcha_url() {
        return this.client.defaults.baseURL + '/auth/captcha';
    }

    public async getOidcConfig(): Promise<OidcConfigResponse> {
        try {
            const response = await this.client.get<any, OidcConfigResponse>('/auth/oidc/config');
            return response;
        } catch (error) {
            return { enabled: false };
        }
    }

    public oidcLoginUrl() {
        return this.client.defaults.baseURL + '/auth/oidc/login';
    }

    public async get_network_interfaces(machine_id: string, inst_id?: string) {
        const response = await this.client.post(`/machines/${machine_id}/proxy-rpc`, {
            service_name: 'api.manage.WebClientService', method_name: 'get_network_interfaces',
            payload: inst_id ? { inst_id: strToUuid(inst_id) } : {},
        });
        return normalizeUplinkInventory(response);
    }

    public get_remote_client(machine_id: string): Api.RemoteClient {
        return new WebRemoteClient(machine_id, this.client);
    }
}

class WebRemoteClient implements Api.RemoteClient {
    private machine_id: string;
    private client: AxiosInstance;

    constructor(machine_id: string, client: AxiosInstance) {
        this.machine_id = machine_id;
        this.client = client;
    }
    async get_network_interfaces(inst_id?: string) {
        const response = await this.client.post(`/machines/${this.machine_id}/proxy-rpc`, {
            service_name: 'api.manage.WebClientService', method_name: 'get_network_interfaces',
            payload: inst_id ? { inst_id: strToUuid(inst_id) } : {},
        });
        return normalizeUplinkInventory(response);
    }
    async validate_config(config: NetworkTypes.NetworkConfig): Promise<Api.ValidateConfigResponse> {
        const { toBackendNetworkConfig } = await import('../../../frontend-lib/src/types/network');
        const response = await this.client.post<NetworkTypes.NetworkConfig, ValidateConfigResponse>(`/machines/${this.machine_id}/validate-config`, {
            config: toBackendNetworkConfig(config),
        });
        return response;
    }
    async run_network(config: NetworkTypes.NetworkConfig, save: boolean): Promise<undefined> {
        const { toBackendNetworkConfig } = await import('../../../frontend-lib/src/types/network');
        await this.client.post<string>(`/machines/${this.machine_id}/networks`, {
            config: toBackendNetworkConfig(config),
            save: save
        });
    }
    async get_network_info(inst_id: string): Promise<NetworkTypes.NetworkInstanceRunningInfo | undefined> {
        const response = await this.client.get<any, Api.CollectNetworkInfoResponse>('/machines/' + this.machine_id + '/networks/info/' + inst_id);
        return RuntimeDisplay.normalizeNetworkRuntime(response.info?.map?.[inst_id]);
    }
    async get_stats(inst_id: string): Promise<Api.RuntimeMetric[]> {
        const response = await this.client.post<any, { metrics?: Api.RuntimeMetric[] }>(`/machines/${this.machine_id}/proxy-rpc`, {
            service_name: 'api.instance.StatsRpcService', method_name: 'get_stats',
            payload: { instance: { id: strToUuid(inst_id) } },
        });
        return RuntimeDisplay.normalizeMetrics(response.metrics);
    }
    async get_vpn_portal_info(inst_id: string): Promise<NetworkTypes.VpnPortalInfo | undefined> {
        const response = await this.client.post<any, { vpn_portal_info?: NetworkTypes.VpnPortalInfo }>(
            `/machines/${this.machine_id}/proxy-rpc`,
            {
                service_name: 'api.instance.VpnPortalRpcService',
                method_name: 'get_vpn_portal_info',
                payload: {
                    instance: {
                        id: strToUuid(inst_id),
                    },
                },
            },
        );
        if (!response.vpn_portal_info) return undefined;
        const { normalizeVpnPortalInfo } = await import('../../../frontend-lib/src/types/network');
        return normalizeVpnPortalInfo(response.vpn_portal_info);
    }
    async patch_vpn_portal_clients(inst_id: string, patches: Array<Record<string, any>>): Promise<undefined> {
        await this.client.patch(
            `/machines/${this.machine_id}/networks/${inst_id}/vpn-portal-clients`,
            { patches },
        );
    }
    async add_vpn_portal_client(inst_id: string, client: { name: string, virtual_ip: string, groups: string[] }): Promise<undefined> {
        await this.patch_vpn_portal_clients(inst_id, [{
            action: 'ADD',
            client,
        }]);
    }
    async remove_vpn_portal_client(inst_id: string, name: string): Promise<undefined> {
        await this.patch_vpn_portal_clients(inst_id, [{
            action: 'REMOVE',
            client: { name, virtual_ip: '', groups: [] },
        }]);
    }
    async clear_vpn_portal_clients(inst_id: string): Promise<undefined> {
        await this.patch_vpn_portal_clients(inst_id, [{ action: 'CLEAR' }]);
    }
    async list_network_instance_ids(): Promise<Api.ListNetworkInstanceIdResponse> {
        const response = await this.client.get<any, ListNetworkInstanceIdResponse>('/machines/' + this.machine_id + '/networks');
        return response;
    }
    async delete_network(inst_id: string): Promise<undefined> {
        await this.client.delete<string>(`/machines/${this.machine_id}/networks/${inst_id}`);
    }
    async update_network_instance_state(inst_id: string, disabled: boolean): Promise<undefined> {
        await this.client.put<string>('/machines/' + this.machine_id + '/networks/' + inst_id, {
            disabled: disabled,
        });
    }
    async save_config(config: NetworkTypes.NetworkConfig): Promise<undefined> {
        const { toBackendNetworkConfig } = await import('../../../frontend-lib/src/types/network');
        await this.client.put(`/machines/${this.machine_id}/networks/config/${config.instance_id}`, {
            config: toBackendNetworkConfig(config)
        });
    }
    async get_network_config(inst_id: string): Promise<NetworkTypes.NetworkConfig> {
        const response = await this.client.get<any, NetworkTypes.NetworkConfig>('/machines/' + this.machine_id + '/networks/config/' + inst_id);
        const { normalizeNetworkConfig } = await import('../../../frontend-lib/src/types/network');
        return normalizeNetworkConfig(response);
    }
    async generate_config(config: NetworkTypes.NetworkConfig): Promise<Api.GenerateConfigResponse> {
        try {
            const { toBackendNetworkConfig } = await import('../../../frontend-lib/src/types/network');
            const response = await this.client.post<any, GenerateConfigResponse>('/generate-config', {
                config: toBackendNetworkConfig(config)
            });
            return response;
        } catch (error) {
            if (error instanceof AxiosError) {
                return { error: error.response?.data };
            }
            return { error: 'Unknown error: ' + error };
        }
    }
    async parse_config(toml_config: string): Promise<Api.ParseConfigResponse> {
        try {
            const response = await this.client.post<any, ParseConfigResponse>('/parse-config', { toml_config });
            if (response.config) {
                const { normalizeNetworkConfig } = await import('../../../frontend-lib/src/types/network');
                response.config = normalizeNetworkConfig(response.config);
            }
            return response;
        } catch (error) {
            if (error instanceof AxiosError) {
                return { error: error.response?.data };
            }
            return { error: 'Unknown error: ' + error };
        }
    }
    async get_network_metas(instance_ids: string[]): Promise<Api.GetNetworkMetasResponse> {
        const response = await this.client.post<any, Api.GetNetworkMetasResponse>(`/machines/${this.machine_id}/networks/metas`, {
            instance_ids: instance_ids
        });
        return response;
    }
}

export default ApiClient;
