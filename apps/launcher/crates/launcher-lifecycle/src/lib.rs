use launcher_core::PayloadEntry;
use launcher_platform::{LauncherPlatformError, ProcessSpec};
use launcher_proto::{
    RuntimeApp, RuntimeEndpoint, RuntimeMode, RuntimeNamespace, RuntimeSource, RuntimeStamp,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const LAUNCHER_CONFIG_FILE: &str = "launcher.json";
pub const LAUNCHER_CONFIG_SCHEMA_VERSION: u32 = 1;
pub const LAUNCHER_ROOT_ENV: &str = "OD_LAUNCHER_ROOT";
pub const RUNTIME_DESCRIPTOR_SCHEMA_VERSION: u32 = 1;
pub const RUNTIME_PLAN_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Error)]
pub enum LauncherLifecycleError {
    #[error("launcher root from {origin} does not contain launcher.json: {path}")]
    ForcedConfigMissing {
        origin: &'static str,
        path: String,
    },
    #[error("launcher config was not found at cwd or launcher exe directory")]
    ImplicitConfigMissing,
    #[error("launcher exe path has no parent directory: {0}")]
    ExeParentMissing(String),
    #[error("unsupported launcher config schema at {path}: expected {expected}, got {actual}")]
    UnsupportedConfigSchema {
        actual: u32,
        expected: u32,
        path: String,
    },
    #[error("launcher config does not contain a runtime descriptor")]
    MissingRuntimeDescriptor,
    #[error("unsupported runtime descriptor schema: expected {expected}, got {actual}")]
    UnsupportedRuntimeSchema { actual: u32, expected: u32 },
    #[error("runtime descriptor must contain at least one app")]
    EmptyRuntimeApps,
    #[error("runtime descriptor reuses endpoint {endpoint}")]
    DuplicateEndpoint { endpoint: String },
    #[error("{field} must not be empty")]
    EmptyField { field: &'static str },
    #[error("platform error: {0}")]
    Platform(#[from] LauncherPlatformError),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConfigSource {
    ExplicitRoot,
    EnvironmentRoot,
    CurrentDirectory,
    LauncherDirectory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct LauncherConfig {
    pub entry: PayloadEntry,
    pub payload_root: String,
    #[serde(default)]
    pub runtime: Option<RuntimeDescriptor>,
    pub schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDescriptor {
    pub apps: RuntimeAppsDescriptor,
    pub mode: RuntimeMode,
    pub namespace: RuntimeNamespace,
    pub namespace_root: String,
    pub schema_version: u32,
    pub source: RuntimeSource,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppsDescriptor {
    #[serde(default)]
    pub daemon: Option<RuntimeAppDescriptor>,
    #[serde(default)]
    pub desktop: Option<RuntimeAppDescriptor>,
    #[serde(default)]
    pub web: Option<RuntimeAppDescriptor>,
}

impl RuntimeAppsDescriptor {
    pub fn iter(&self) -> impl Iterator<Item = (RuntimeApp, &RuntimeAppDescriptor)> {
        [
            (RuntimeApp::Daemon, self.daemon.as_ref()),
            (RuntimeApp::Desktop, self.desktop.as_ref()),
            (RuntimeApp::Web, self.web.as_ref()),
        ]
        .into_iter()
        .filter_map(|(app, descriptor)| descriptor.map(|descriptor| (app, descriptor)))
    }

    pub fn is_empty(&self) -> bool {
        self.daemon.is_none() && self.desktop.is_none() && self.web.is_none()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppDescriptor {
    pub endpoint: RuntimeEndpoint,
    pub entry: PayloadEntry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConfigSearch {
    pub cwd: PathBuf,
    pub env_root: Option<PathBuf>,
    pub exe_path: PathBuf,
    pub explicit_root: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedLauncherConfig {
    pub config: LauncherConfig,
    pub config_path: PathBuf,
    pub config_root: PathBuf,
    pub payload_root: PathBuf,
    pub process: ProcessSpec,
    pub source: ConfigSource,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePlan {
    pub apps: Vec<RuntimeAppPlan>,
    pub cache_root: PathBuf,
    pub logs_root: PathBuf,
    pub mode: RuntimeMode,
    pub namespace: RuntimeNamespace,
    pub namespace_root: PathBuf,
    pub runtime_root: PathBuf,
    pub schema_version: u32,
    pub source: RuntimeSource,
    pub state_root: PathBuf,
    pub versions_root: PathBuf,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAppPlan {
    pub app: RuntimeApp,
    pub log_path: PathBuf,
    pub process: RuntimeProcessPlan,
    pub runtime_file_path: PathBuf,
    pub stamp: RuntimeStamp,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProcessPlan {
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
    pub executable: PathBuf,
}

pub fn resolve_launcher_config(search: &ConfigSearch) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    resolve_config_with_args(search, &[])
}

pub fn resolve_config_with_args(
    search: &ConfigSearch,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    if let Some(root) = &search.explicit_root {
        return load_from_root(
            &resolve_search_root(&search.cwd, root),
            ConfigSource::ExplicitRoot,
            Some("flag"),
            forwarded_args,
        );
    }
    if let Some(root) = &search.env_root {
        return load_from_root(
            &resolve_search_root(&search.cwd, root),
            ConfigSource::EnvironmentRoot,
            Some("environment"),
            forwarded_args,
        );
    }

    let cwd_config = search.cwd.join(LAUNCHER_CONFIG_FILE);
    if cwd_config.is_file() {
        return load_from_path(cwd_config, ConfigSource::CurrentDirectory, forwarded_args);
    }

    let exe_root = search
        .exe_path
        .parent()
        .ok_or_else(|| LauncherLifecycleError::ExeParentMissing(search.exe_path.display().to_string()))?;
    let exe_config = exe_root.join(LAUNCHER_CONFIG_FILE);
    if exe_config.is_file() {
        return load_from_path(exe_config, ConfigSource::LauncherDirectory, forwarded_args);
    }

    Err(LauncherLifecycleError::ImplicitConfigMissing)
}

pub fn build_process_spec(
    config_root: &Path,
    config: &LauncherConfig,
    forwarded_args: &[String],
) -> Result<ProcessSpec, LauncherLifecycleError> {
    require_non_empty(&config.payload_root, "payloadRoot")?;
    require_non_empty(&config.entry.executable, "entry.executable")?;
    let payload_root = resolve_config_path(config_root, &config.payload_root);
    let executable = resolve_config_path(config_root, &config.entry.executable);
    let cwd = config
        .entry
        .cwd
        .as_deref()
        .map(|cwd| resolve_config_path(config_root, cwd))
        .unwrap_or_else(|| payload_root.clone());
    let args = config
        .entry
        .args
        .iter()
        .cloned()
        .chain(forwarded_args.iter().cloned())
        .collect();

    Ok(ProcessSpec {
        args,
        cwd,
        env: config.entry.env.clone(),
        executable,
    })
}

pub fn load_launcher_config(path: &Path) -> Result<LauncherConfig, LauncherLifecycleError> {
    let config: LauncherConfig = launcher_platform::read_json_file(path)?;
    if config.schema_version != LAUNCHER_CONFIG_SCHEMA_VERSION {
        return Err(LauncherLifecycleError::UnsupportedConfigSchema {
            actual: config.schema_version,
            expected: LAUNCHER_CONFIG_SCHEMA_VERSION,
            path: path.display().to_string(),
        });
    }
    require_non_empty(&config.payload_root, "payloadRoot")?;
    require_non_empty(&config.entry.executable, "entry.executable")?;
    Ok(config)
}

pub fn launch_config(resolved: &ResolvedLauncherConfig) -> Result<(), LauncherLifecycleError> {
    let _child = launcher_platform::spawn_process(&resolved.process)?;
    Ok(())
}

pub fn build_runtime_plan(resolved: &ResolvedLauncherConfig) -> Result<RuntimePlan, LauncherLifecycleError> {
    let descriptor = resolved
        .config
        .runtime
        .as_ref()
        .ok_or(LauncherLifecycleError::MissingRuntimeDescriptor)?;
    if descriptor.schema_version != RUNTIME_DESCRIPTOR_SCHEMA_VERSION {
        return Err(LauncherLifecycleError::UnsupportedRuntimeSchema {
            actual: descriptor.schema_version,
            expected: RUNTIME_DESCRIPTOR_SCHEMA_VERSION,
        });
    }
    if descriptor.apps.is_empty() {
        return Err(LauncherLifecycleError::EmptyRuntimeApps);
    }

    let namespace_root = resolve_config_path(&resolved.config_root, &descriptor.namespace_root);
    let runtime_root = namespace_root.join("runtime");
    let logs_root = namespace_root.join("logs");
    let mut endpoints = BTreeSet::new();
    let mut apps = Vec::new();

    for (app, app_descriptor) in descriptor.apps.iter() {
        if !endpoints.insert(app_descriptor.endpoint.as_str().to_owned()) {
            return Err(LauncherLifecycleError::DuplicateEndpoint {
                endpoint: app_descriptor.endpoint.as_str().to_owned(),
            });
        }
        let process = build_runtime_process_plan(
            &resolved.config_root,
            &resolved.payload_root,
            &app_descriptor.entry,
        )?;
        let stamp = RuntimeStamp::new(
            app,
            app_descriptor.endpoint.clone(),
            descriptor.mode,
            descriptor.namespace.clone(),
            descriptor.source,
        );
        apps.push(RuntimeAppPlan {
            app,
            log_path: logs_root.join(app.as_str()).join("latest.log"),
            process,
            runtime_file_path: runtime_root.join(format!("{}.json", app.as_str())),
            stamp,
        });
    }

    Ok(RuntimePlan {
        apps,
        cache_root: namespace_root.join("cache"),
        logs_root,
        mode: descriptor.mode,
        namespace: descriptor.namespace.clone(),
        namespace_root: namespace_root.clone(),
        runtime_root,
        schema_version: RUNTIME_PLAN_SCHEMA_VERSION,
        source: descriptor.source,
        state_root: namespace_root.join("state"),
        versions_root: namespace_root.join("versions"),
    })
}

fn load_from_root(
    root: &Path,
    source: ConfigSource,
    forced_source: Option<&'static str>,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    let path = root.join(LAUNCHER_CONFIG_FILE);
    if let Some(source) = forced_source
        && !path.is_file()
    {
        return Err(LauncherLifecycleError::ForcedConfigMissing {
            origin: source,
            path: path.display().to_string(),
        });
    }
    load_from_path(path, source, forwarded_args)
}

fn load_from_path(
    path: PathBuf,
    source: ConfigSource,
    forwarded_args: &[String],
) -> Result<ResolvedLauncherConfig, LauncherLifecycleError> {
    let config = load_launcher_config(&path)?;
    let config_root = path
        .parent()
        .ok_or_else(|| LauncherLifecycleError::ForcedConfigMissing {
            origin: "config",
            path: path.display().to_string(),
        })?
        .to_path_buf();
    let process = build_process_spec(&config_root, &config, forwarded_args)?;
    let payload_root = resolve_config_path(&config_root, &config.payload_root);
    Ok(ResolvedLauncherConfig {
        config,
        config_path: path,
        config_root,
        payload_root,
        process,
        source,
    })
}

fn resolve_config_path(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn build_runtime_process_plan(
    config_root: &Path,
    payload_root: &Path,
    entry: &PayloadEntry,
) -> Result<RuntimeProcessPlan, LauncherLifecycleError> {
    require_non_empty(&entry.executable, "runtime.entry.executable")?;
    let cwd = entry
        .cwd
        .as_deref()
        .map(|cwd| resolve_config_path(config_root, cwd))
        .unwrap_or_else(|| payload_root.to_path_buf());
    Ok(RuntimeProcessPlan {
        args: entry.args.clone(),
        cwd,
        env: entry.env.clone(),
        executable: resolve_config_path(config_root, &entry.executable),
    })
}

fn resolve_search_root(cwd: &Path, root: &Path) -> PathBuf {
    if root.is_absolute() {
        root.to_path_buf()
    } else {
        cwd.join(root)
    }
}

fn require_non_empty(value: &str, field: &'static str) -> Result<(), LauncherLifecycleError> {
    if value.trim().is_empty() {
        return Err(LauncherLifecycleError::EmptyField { field });
    }
    Ok(())
}
