Feature: Local PTY daemon reattach
  Local terminals run in a detached `kolu --stdio` PTY-host daemon (#951
  R4c), so they survive a kolu-server restart — replacing tmux/zmx and
  closing #671. After the server restarts, the same shells reattach by id
  with scrollback intact: no re-spawn, no lost output. The client's
  WebSocket drops when the old server dies and auto-reconnects to the fresh
  one, whose boot-time `reattachLocalTerminals` has already re-registered
  the surviving PTYs.

  Scenario: Terminal reattaches with scrollback after kolu-server restart
    Given the terminal is ready
    When I run "echo kolu-survives-restart"
    Then the screen state should contain "kolu-survives-restart"
    When I restart the kolu server
    Then the connection status should eventually be "open"
    And the screen state should contain "kolu-survives-restart"
    And there should be no page errors
