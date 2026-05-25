use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;
use std::str::FromStr;
use thiserror::Error;

pub const LOOPBACK_HOST: &str = "127.0.0.1";

#[derive(Debug, Error, Eq, PartialEq)]
pub enum LauncherProtoError {
    #[error("namespace must not be empty")]
    EmptyNamespace,
    #[error("namespace must not contain leading or trailing whitespace: {0}")]
    NamespaceWhitespace(String),
    #[error("namespace contains unsupported characters: {0}")]
    NamespaceCharacters(String),
    #[error("namespace must not contain path separators: {0}")]
    NamespacePathSeparator(String),
    #[error("endpoint must use tcp://127.0.0.1:<port>: {0}")]
    UnsupportedEndpoint(String),
    #[error("endpoint port must be between 1 and 65535: {0}")]
    InvalidEndpointPort(String),
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeApp {
    Daemon,
    Desktop,
    Web,
}

impl RuntimeApp {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daemon => "daemon",
            Self::Desktop => "desktop",
            Self::Web => "web",
        }
    }
}

impl fmt::Display for RuntimeApp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeMode {
    Dev,
    Packaged,
}

impl RuntimeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dev => "dev",
            Self::Packaged => "packaged",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeSource {
    Launcher,
    ToolsDev,
}

impl RuntimeSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launcher => "launcher",
            Self::ToolsDev => "tools-dev",
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RuntimeNamespace(String);

impl RuntimeNamespace {
    pub fn new(value: impl Into<String>) -> Result<Self, LauncherProtoError> {
        let value = value.into();
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(LauncherProtoError::EmptyNamespace);
        }
        if trimmed != value {
            return Err(LauncherProtoError::NamespaceWhitespace(value));
        }
        if value.contains(['/', '\\']) {
            return Err(LauncherProtoError::NamespacePathSeparator(value));
        }
        let mut chars = value.chars();
        let Some(first) = chars.next() else {
            return Err(LauncherProtoError::EmptyNamespace);
        };
        if !first.is_ascii_alphanumeric()
            || value.len() > 128
            || !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        {
            return Err(LauncherProtoError::NamespaceCharacters(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for RuntimeNamespace {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for RuntimeNamespace {
    type Err = LauncherProtoError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for RuntimeNamespace {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct RuntimeEndpoint(String);

impl RuntimeEndpoint {
    pub fn new(value: impl Into<String>) -> Result<Self, LauncherProtoError> {
        let value = value.into();
        let prefix = format!("tcp://{LOOPBACK_HOST}:");
        let Some(port_text) = value.strip_prefix(&prefix) else {
            return Err(LauncherProtoError::UnsupportedEndpoint(value));
        };
        let Ok(port) = port_text.parse::<u16>() else {
            return Err(LauncherProtoError::InvalidEndpointPort(value));
        };
        if port == 0 || port_text.to_string() != port.to_string() {
            return Err(LauncherProtoError::InvalidEndpointPort(value));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn port(&self) -> u16 {
        self.0
            .rsplit_once(':')
            .and_then(|(_, port)| port.parse::<u16>().ok())
            .expect("RuntimeEndpoint must contain a validated u16 port")
    }
}

impl fmt::Display for RuntimeEndpoint {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for RuntimeEndpoint {
    type Err = LauncherProtoError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::new(value)
    }
}

impl<'de> Deserialize<'de> for RuntimeEndpoint {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStamp {
    pub app: RuntimeApp,
    pub endpoint: RuntimeEndpoint,
    pub mode: RuntimeMode,
    pub namespace: RuntimeNamespace,
    pub source: RuntimeSource,
}

impl RuntimeStamp {
    pub fn new(
        app: RuntimeApp,
        endpoint: RuntimeEndpoint,
        mode: RuntimeMode,
        namespace: RuntimeNamespace,
        source: RuntimeSource,
    ) -> Self {
        Self {
            app,
            endpoint,
            mode,
            namespace,
            source,
        }
    }
}
