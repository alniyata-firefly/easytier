use easytier_proto::{
    api::config::{
        ConfigRpc, GetConfigRequest, GetConfigResponse, PatchConfigRequest, PatchConfigResponse,
    },
    rpc_types::{self, controller::BaseController},
};

use crate::{
    config::{api::network_config_from_toml, toml::ConfigLoader as _},
    management::apply_config_patch,
};

use super::{ReadOnlyInstanceResolver, ResolvedInstanceManagementRpc};

#[async_trait::async_trait]
impl<R> ConfigRpc for ResolvedInstanceManagementRpc<R>
where
    R: ReadOnlyInstanceResolver,
{
    type Controller = BaseController;

    async fn patch_config(
        &self,
        _: BaseController,
        request: PatchConfigRequest,
    ) -> rpc_types::error::Result<PatchConfigResponse> {
        let rpc = self.clone();
        // A native atomic file write may outlive its caller's cancellation.
        // Keep the whole resolve/persist/commit transaction alive with the
        // manager lock, so overwrite cannot install a new Arc in that gap.
        tokio::spawn(async move {
            let _mutation = match rpc.resolver.mutation_lock() {
                Some(lock) => Some(lock.lock_owned().await),
                None => None,
            };
            let instance = rpc.instance(request.instance.as_ref())?;
            if rpc.resolver.has_pending_config_save(instance.instance_id()) {
                return Err(anyhow::anyhow!(
                    "instance has unapplied saved configuration; apply or discard the saved configuration before applying a live patch"
                ).into());
            }
            if let Some(patch) = request.patch {
                // Lock order: manager mutation, then Instance operation.
                apply_config_patch(&instance, patch, rpc.config_patch_persistence.as_deref())
                    .await?;
            }
            Ok(PatchConfigResponse::default())
        })
        .await
        .map_err(|error| anyhow::anyhow!("config patch transaction failed: {error}"))?
    }

    async fn get_config(
        &self,
        _: BaseController,
        request: GetConfigRequest,
    ) -> rpc_types::error::Result<GetConfigResponse> {
        let config = self
            .instance(request.instance.as_ref())?
            .toml_config()
            .ok_or_else(|| anyhow::anyhow!("shared TOML configuration is not available"))?;
        Ok(GetConfigResponse {
            config: Some(network_config_from_toml(&config)),
            toml_config: config.dump(),
        })
    }
}
