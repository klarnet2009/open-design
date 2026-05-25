use launcher_lifecycle::{
    ConfigSearch, ConfigSource, LAUNCHER_CONFIG_FILE, LauncherLifecycleError, build_process_spec,
    build_runtime_plan, resolve_config_with_args, resolve_launcher_config,
};
use launcher_proto::{RuntimeApp, RuntimeMode, RuntimeSource};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "open-design-launcher-lifecycle-test-{}-{}",
        name,
        std::process::id()
    ))
}

fn write_config(root: &Path, executable: &str) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        format!(
            r#"{{
  "schemaVersion": 1,
  "payloadRoot": "versions/0.8.0/payload",
  "entry": {{
    "executable": "{executable}",
    "args": ["--from-config"],
    "cwd": "versions/0.8.0/payload",
    "env": {{"OD_TEST": "1"}}
  }}
}}"#
        ),
    )
    .unwrap();
}

fn write_runtime_config(root: &Path) {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "payloadRoot": "versions/0.8.0/payload",
  "entry": {"executable": "Open Design Payload.exe"},
  "runtime": {
    "schemaVersion": 1,
    "namespace": "release-beta-win",
    "namespaceRoot": "namespaces/release-beta-win",
    "mode": "packaged",
    "source": "launcher",
    "apps": {
      "daemon": {
        "endpoint": "tcp://127.0.0.1:17401",
        "entry": {
          "executable": "versions/0.8.0/payload/daemon.exe",
          "args": ["--serve"],
          "env": {"OD_PORT": "17456"}
        }
      },
      "web": {
        "endpoint": "tcp://127.0.0.1:17402",
        "entry": {
          "executable": "versions/0.8.0/payload/web.exe",
          "env": {"OD_WEB_PORT": "17573"}
        }
      }
    }
  }
}"#,
    )
    .unwrap();
}

fn search(root: &Path) -> ConfigSearch {
    ConfigSearch {
        cwd: root.join("cwd"),
        env_root: None,
        exe_path: root.join("bin").join("open-design-launcher.exe"),
        explicit_root: None,
    }
}

#[test]
fn explicit_root_wins() {
    let root = temp_root("explicit-root");
    let explicit = root.join("explicit");
    let cwd = root.join("cwd");
    write_config(&explicit, "explicit.exe");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.explicit_root = Some(explicit.clone());
    search.cwd = cwd;

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::ExplicitRoot);
    assert_eq!(resolved.config_root, explicit);
    assert_eq!(resolved.process.executable, root.join("explicit").join("explicit.exe"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn env_root_wins() {
    let root = temp_root("env-root");
    let env_root = root.join("env");
    let cwd = root.join("cwd");
    write_config(&env_root, "env.exe");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.env_root = Some(env_root.clone());
    search.cwd = cwd;

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::EnvironmentRoot);
    assert_eq!(resolved.config_root, env_root);
    assert_eq!(resolved.process.executable, root.join("env").join("env.exe"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn exe_dir_fallback() {
    let root = temp_root("exe-dir");
    let exe_dir = root.join("bin");
    write_config(&exe_dir, "payload.exe");
    let search = search(&root);

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.source, ConfigSource::LauncherDirectory);
    assert_eq!(resolved.config_root, exe_dir);
    assert_eq!(resolved.process.executable, root.join("bin").join("payload.exe"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn explicit_missing_hard_fails() {
    let root = temp_root("missing-explicit");
    let cwd = root.join("cwd");
    write_config(&cwd, "cwd.exe");
    let mut search = search(&root);
    search.cwd = cwd;
    search.explicit_root = Some(root.join("missing"));

    assert!(matches!(
        resolve_launcher_config(&search),
        Err(LauncherLifecycleError::ForcedConfigMissing { origin: "flag", .. })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn relative_root_anchors() {
    let root = temp_root("relative-root");
    let cwd = root.join("cwd");
    let config_root = cwd.join("launcher-root");
    write_config(&config_root, "payload.exe");
    let mut search = search(&root);
    search.cwd = cwd.clone();
    search.explicit_root = Some(PathBuf::from("launcher-root"));

    let resolved = resolve_launcher_config(&search).unwrap();

    assert_eq!(resolved.config_root, config_root);
    assert_eq!(
        resolved.process.executable,
        cwd.join("launcher-root").join("payload.exe")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn paths_anchor_to_config() {
    let root = temp_root("relative-paths");
    let config_root = root.join("config");
    write_config(&config_root, "versions/0.8.0/payload/Open Design.exe");
    let mut search = search(&root);
    search.explicit_root = Some(config_root.clone());
    let forwarded = vec!["od://project/1".to_owned(), "--safe-mode".to_owned()];

    let resolved = resolve_config_with_args(&search, &forwarded).unwrap();

    assert_eq!(resolved.payload_root, config_root.join("versions/0.8.0/payload"));
    assert_eq!(
        resolved.process.executable,
        config_root.join("versions/0.8.0/payload/Open Design.exe")
    );
    assert_eq!(resolved.process.cwd, config_root.join("versions/0.8.0/payload"));
    assert_eq!(
        resolved.process.args,
        vec!["--from-config", "od://project/1", "--safe-mode"]
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn unknown_fields_fail() {
    let root = temp_root("unknown-field");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "payloadRoot": "payload",
  "entry": {"executable": "payload.exe"},
  "extra": true
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());

    assert!(matches!(
        resolve_launcher_config(&search),
        Err(LauncherLifecycleError::Platform(_))
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn cwd_defaults_to_payload() {
    let config = launcher_lifecycle::LauncherConfig {
        schema_version: 1,
        payload_root: "payload".to_owned(),
        runtime: None,
        entry: launcher_core::PayloadEntry::new("payload/app.exe").unwrap(),
    };

    let process = build_process_spec(Path::new("C:/root"), &config, &[]).unwrap();

    assert_eq!(process.cwd, PathBuf::from("C:/root/payload"));
}

#[test]
fn runtime_plan_resolves() {
    let root = temp_root("runtime-plan");
    let config_root = root.join("config");
    write_runtime_config(&config_root);
    let mut search = search(&root);
    search.explicit_root = Some(config_root.clone());
    let resolved = resolve_launcher_config(&search).unwrap();

    let plan = build_runtime_plan(&resolved).unwrap();

    assert_eq!(plan.namespace.as_str(), "release-beta-win");
    assert_eq!(plan.mode, RuntimeMode::Packaged);
    assert_eq!(plan.source, RuntimeSource::Launcher);
    assert_eq!(plan.namespace_root, config_root.join("namespaces/release-beta-win"));
    assert_eq!(plan.runtime_root, plan.namespace_root.join("runtime"));
    assert_eq!(plan.logs_root, plan.namespace_root.join("logs"));
    assert_eq!(plan.cache_root, plan.namespace_root.join("cache"));
    assert_eq!(plan.state_root, plan.namespace_root.join("state"));
    assert_eq!(plan.versions_root, plan.namespace_root.join("versions"));
    assert_eq!(plan.apps.len(), 2);
    assert_eq!(plan.apps[0].app, RuntimeApp::Daemon);
    assert_eq!(plan.apps[0].stamp.endpoint.as_str(), "tcp://127.0.0.1:17401");
    assert_eq!(
        plan.apps[0].process.executable,
        config_root.join("versions/0.8.0/payload/daemon.exe")
    );
    assert_eq!(
        plan.apps[0].process.cwd,
        config_root.join("versions/0.8.0/payload")
    );
    assert_eq!(
        plan.apps[0].runtime_file_path,
        plan.runtime_root.join("daemon.json")
    );
    assert_eq!(
        plan.apps[0].log_path,
        plan.logs_root.join("daemon").join("latest.log")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn duplicate_endpoints_fail() {
    let root = temp_root("duplicate-endpoints");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        root.join(LAUNCHER_CONFIG_FILE),
        r#"{
  "schemaVersion": 1,
  "payloadRoot": "payload",
  "entry": {"executable": "payload.exe"},
  "runtime": {
    "schemaVersion": 1,
    "namespace": "release-beta-win",
    "namespaceRoot": "namespaces/release-beta-win",
    "mode": "packaged",
    "source": "launcher",
    "apps": {
      "daemon": {"endpoint": "tcp://127.0.0.1:17401", "entry": {"executable": "daemon.exe"}},
      "web": {"endpoint": "tcp://127.0.0.1:17401", "entry": {"executable": "web.exe"}}
    }
  }
}"#,
    )
    .unwrap();
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());
    let resolved = resolve_launcher_config(&search).unwrap();

    assert!(matches!(
        build_runtime_plan(&resolved),
        Err(LauncherLifecycleError::DuplicateEndpoint { .. })
    ));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn missing_runtime_fails() {
    let root = temp_root("missing-runtime");
    write_config(&root, "payload.exe");
    let mut search = search(&root);
    search.explicit_root = Some(root.clone());
    let resolved = resolve_launcher_config(&search).unwrap();

    assert!(matches!(
        build_runtime_plan(&resolved),
        Err(LauncherLifecycleError::MissingRuntimeDescriptor)
    ));

    let _ = fs::remove_dir_all(root);
}
