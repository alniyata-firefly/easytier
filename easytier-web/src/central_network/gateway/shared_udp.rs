//! Control endpoints borrowed from the Web-owned UDP listeners.

use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
};

use easytier_core::connectivity::LocalListenerUrls;
use url::{Host, Url};

#[derive(Debug, Default)]
pub struct SharedUdpControlEndpoints {
    endpoints: Mutex<Vec<(Url, usize)>>,
}

impl SharedUdpControlEndpoints {
    pub fn register(self: &Arc<Self>, actual_url: &Url) -> Option<SharedUdpControlLease> {
        if actual_url.scheme() != "udp"
            || !match actual_url.host() {
                Some(Host::Ipv4(_)) | Some(Host::Ipv6(_)) => true,
                // UDP is a non-special URL scheme; IPv4 literals are Domain hosts.
                Some(Host::Domain(host)) => host.parse::<Ipv4Addr>().is_ok(),
                None => false,
            }
            || !actual_url.port().is_some_and(|port| port != 0)
        {
            return None;
        }

        let mut endpoints = self.endpoints.lock().unwrap();
        if let Some((_, count)) = endpoints.iter_mut().find(|(url, _)| url == actual_url) {
            *count += 1;
        } else {
            endpoints.push((actual_url.clone(), 1));
        }
        Some(SharedUdpControlLease {
            owner: self.clone(),
            actual_url: actual_url.clone(),
        })
    }
}

impl LocalListenerUrls for SharedUdpControlEndpoints {
    fn local_listener_urls(&self) -> Vec<Url> {
        self.endpoints
            .lock()
            .unwrap()
            .iter()
            .map(|(url, _)| url.clone())
            .collect()
    }
}

#[derive(Debug)]
pub struct SharedUdpControlLease {
    owner: Arc<SharedUdpControlEndpoints>,
    actual_url: Url,
}

impl Drop for SharedUdpControlLease {
    fn drop(&mut self) {
        let mut endpoints = self.owner.endpoints.lock().unwrap();
        let Some(index) = endpoints
            .iter()
            .position(|(url, _)| url == &self.actual_url)
        else {
            return;
        };
        if endpoints[index].1 == 1 {
            endpoints.remove(index);
        } else {
            endpoints[index].1 -= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bound_literal_udp_endpoints_can_be_registered() {
        let endpoints = Arc::new(SharedUdpControlEndpoints::default());
        for raw in [
            "tcp://0.0.0.0:22020",
            "udp://example.com:22020",
            "udp://0.0.0.0:0",
            "udp://[::]:0",
            "udp://0.0.0.0",
            "ring://00000000-0000-0000-0000-000000000001",
        ] {
            assert!(endpoints.register(&raw.parse().unwrap()).is_none(), "{raw}");
        }
        assert!(endpoints.local_listener_urls().is_empty());
    }

    #[test]
    fn duplicate_endpoint_leases_revoke_only_after_the_last_owner_drops() {
        let endpoints = Arc::new(SharedUdpControlEndpoints::default());
        let v4 = "udp://0.0.0.0:22020".parse().unwrap();
        let v6 = "udp://[::]:22020".parse().unwrap();
        let first = endpoints.register(&v4).unwrap();
        let duplicate = endpoints.register(&v4).unwrap();
        let other_family = endpoints.register(&v6).unwrap();
        assert_eq!(
            endpoints.local_listener_urls(),
            vec![v4.clone(), v6.clone()]
        );

        drop(first);
        assert_eq!(endpoints.local_listener_urls(), vec![v4, v6.clone()]);
        drop(duplicate);
        assert_eq!(endpoints.local_listener_urls(), vec![v6]);
        drop(other_family);
        assert!(endpoints.local_listener_urls().is_empty());
    }
}
