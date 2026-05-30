# Example configuration using kolu's home-manager module.
# Built in CI to ensure the module evaluates correctly.
# Linux: NixOS VM test that boots the config and verifies the systemd
# service actually starts. Darwin: standalone home-manager eval-build that
# verifies the launchd path produces a valid plist (no runtime test —
# CI builders don't have a launchd session).
{
  inputs = {
    # In CI, localci builds this with --override-input kolu pointing to the repo root.
    kolu.url = "github:juspay/kolu";
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { nixpkgs, home-manager, kolu, ... }:
    let
      linuxSystem = "x86_64-linux";
      darwinSystem = "aarch64-darwin";
      linuxPkgs = nixpkgs.legacyPackages.${linuxSystem};
      darwinPkgs = nixpkgs.legacyPackages.${darwinSystem};

      # Pure home-manager module — used both inside the NixOS VM (Linux
      # systemd path) and standalone on Darwin (launchd path).
      koluHmModule = { pkgs, ... }: {
        imports = [ kolu.homeManagerModules.default ];
        services.kolu = {
          enable = true;
          package = kolu.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
        home.stateVersion = "24.11";
      };

      darwinHome = home-manager.lib.homeManagerConfiguration {
        pkgs = darwinPkgs;
        modules = [
          koluHmModule
          {
            home.username = "alice";
            home.homeDirectory = "/Users/alice";
          }
        ];
      };

      # NixOS module: minimal system + home-manager with kolu enabled.
      nixosModule = {
        boot.loader.grub.devices = [ "nodev" ];
        fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
        system.stateVersion = "24.11";

        users.users.alice = {
          isNormalUser = true;
          # Auto-login so the user session (and its systemd units) starts in the VM
          initialPassword = "pass";
          # R4c (#951): linger keeps alice's systemd --user manager alive
          # without an active login, so the transient `kolu-pty-host` daemon
          # unit (and its PTYs) survives between kolu-server restarts/deploys.
          linger = true;
        };

        home-manager.users.alice = koluHmModule;
      };
    in
    {
      nixosConfigurations.example = nixpkgs.lib.nixosSystem {
        system = linuxSystem;
        modules = [
          home-manager.nixosModules.home-manager
          nixosModule
        ];
      };

      # Linux: VM test boots the config and verifies kolu listens on its port.
      checks.${linuxSystem}.vm-test = linuxPkgs.testers.nixosTest {
        name = "kolu-service";

        nodes.machine = { ... }: {
          imports = [
            home-manager.nixosModules.home-manager
            nixosModule
          ];

          # Auto-login alice so her user session starts
          services.getty.autologinUser = "alice";
        };

        testScript = ''
          machine.wait_for_unit("multi-user.target")
          # Poll for alice's user session. wait_for_unit fails fast if the
          # unit is still inactive with no pending job — a race with
          # auto-login queueing user@1000. wait_until_succeeds retries.
          machine.wait_until_succeeds(
              "systemctl is-active user@1000.service",
              timeout=60,
          )

          # Use machinectl shell to get a proper user session with
          # DBUS_SESSION_BUS_ADDRESS and XDG_RUNTIME_DIR set.
          # Plain `su` doesn't set these, so systemctl --user fails.
          machine.succeed(
              "machinectl -q shell alice@.host /run/current-system/sw/bin/systemctl --user is-active kolu.service"
          )

          # Daemon pid file (the daemon writes it via tryAcquirePidFile). The
          # service's KOLU_STATE_DIR is ~/.config/kolu (the nix wrapper sets it).
          pidfile = "/home/alice/.config/kolu/pty-host.pid"

          # Dump the kolu + daemon journals on failure so a boot/daemon issue is
          # legible in CI (user-service stdout doesn't reach the VM console).
          # Read the SYSTEM journal as root (`_SYSTEMD_USER_UNIT=`), NOT via
          # `machinectl shell journalctl` — the latter hung for an hour. Each
          # call is `timeout`-guarded so the dump itself can never hang the run.
          def dump_journals():
              for unit in ("kolu.service", "kolu-pty-host.service"):
                  out = machine.succeed(
                      "timeout 20 journalctl _SYSTEMD_USER_UNIT=" + unit
                      + " --no-pager -n 100 2>&1 || echo '(no journal)'"
                  )
                  print("=== journal: " + unit + " ===\n" + out)

          def wait_for_http(timeout):
              try:
                  machine.wait_until_succeeds(
                      "curl --fail --silent http://127.0.0.1:7681/ > /dev/null",
                      timeout=timeout,
                  )
              except Exception:
                  dump_journals()
                  raise

          # Poll until kolu's HTTP listener binds — systemd reports "active"
          # before the port is open, and boot spawns the PTY-host daemon FIRST
          # (before binding), so this also implies the daemon is up. 120s
          # headroom for hosts without KVM (qemu TCG inflates node startup).
          wait_for_http(120)

          # R4c (#951): the PTY-host daemon must survive a kolu-server restart
          # (a deploy). It spawns at boot via `systemd-run --user
          # --unit=kolu-pty-host` (its own cgroup). We assert survival by the
          # daemon's *process pid* (from its pid file) rather than the systemd
          # unit state — `kill -0` as root can't hang, and the pid is the real
          # property under test: same live pid before and after the restart.
          try:
              machine.wait_until_succeeds("test -s " + pidfile, timeout=30)
          except Exception:
              dump_journals()
              raise
          pid_before = machine.succeed("cat " + pidfile).strip()
          machine.succeed("kill -0 " + pid_before)  # daemon is alive pre-restart

          # Restart kolu-server — the deploy. The daemon (own cgroup) must NOT
          # be taken down with it.
          machine.succeed(
              "machinectl -q shell alice@.host "
              "/run/current-system/sw/bin/systemctl --user restart kolu.service"
          )
          wait_for_http(120)
          pid_after = machine.succeed("cat " + pidfile).strip()
          assert pid_before == pid_after, (
              f"PTY-host daemon did NOT survive kolu-server restart: "
              f"pid {pid_before} -> {pid_after}"
          )
          machine.succeed("kill -0 " + pid_after)  # same daemon still running
        '';
      };

      # Darwin: standalone home-manager activation package. Building this
      # exercises the launchd.agents.kolu path end-to-end (plist generation,
      # wait4path wrapping, etc.) without needing a live launchd session.
      checks.${darwinSystem} = {
        home-activation = darwinHome.activationPackage;

        launchd-config =
          let
            agentConfig = darwinHome.config.launchd.agents.kolu.config;
          in
          assert agentConfig.StandardOutPath == "/Users/alice/Library/Logs/kolu.out.log";
          assert agentConfig.StandardErrorPath == "/Users/alice/Library/Logs/kolu.err.log";
          # Restart on non-zero exit AND on crash signals — matches systemd's
          # `Restart = "on-failure"`. `SuccessfulExit` alone misses SIGSEGV etc.
          assert agentConfig.KeepAlive.SuccessfulExit == false;
          assert agentConfig.KeepAlive.Crashed == true;
          darwinPkgs.runCommand "kolu-launchd-config" { } ''
            touch $out
          '';
      };
    };
}
