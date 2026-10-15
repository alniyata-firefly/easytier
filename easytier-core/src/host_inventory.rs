//! Read-only Host observations, independent of an Instance's uplink policy.
//!
//! Native Adapters perform enumeration. Core only carries the resulting data
//! across its process-management seam; observations never amend configuration
//! or the addresses advertised to peers.

use std::net::IpAddr;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NetworkInterfaceInventory {
    pub supported: bool,
    pub sampled_at_unix_ms: u64,
    pub namespace: Option<String>,
    pub interfaces: Vec<NetworkInterfaceInfo>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkInterfaceInfo {
    pub name: String,
    pub index: u32,
    pub addresses: Vec<NetworkInterfaceAddress>,
    pub kind: String,
    /// None means the Host cannot observe the current link state.
    pub up: Option<bool>,
    pub auto_eligible: bool,
    pub manual_selectable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetworkInterfaceAddress {
    pub address: IpAddr,
    pub prefix_length: Option<u32>,
}
