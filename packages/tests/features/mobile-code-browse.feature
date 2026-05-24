Feature: Mobile code browser
  On mobile the right panel is hidden — there's no room for a side
  column. The "Files" button in the chrome sheet (`MobileChromeSheet`)
  opens a bottom drawer with the active terminal's repo file tree
  (`MobileCodeSheet`). Tapping a file shows it in a detail view:
  text files render via Pierre's `CodeView`; HTML files render in
  the sandboxed iframe preview the desktop Code tab uses. A back
  arrow returns from the detail view to the tree; an explicit close
  button dismisses the drawer.

  Background:
    Given the terminal is ready

  @mobile
  Scenario: Files button opens the mobile code sheet
    When I run "rm -rf /tmp/kolu-mobile-files && git init /tmp/kolu-mobile-files && cd /tmp/kolu-mobile-files"
    And I run "echo hello > a.txt"
    And I run "git add a.txt && git commit -m init"
    And I tap the mobile pull handle
    And I tap the mobile files button
    Then the mobile code sheet should be visible
    And the mobile file tree should contain "a.txt"
    And there should be no page errors

  @mobile
  Scenario: Tapping a text file shows its content
    When I run "rm -rf /tmp/kolu-mobile-text && git init /tmp/kolu-mobile-text && cd /tmp/kolu-mobile-text"
    And I run "echo hello > readme.txt"
    And I run "git add readme.txt && git commit -m init"
    And I tap the mobile pull handle
    And I tap the mobile files button
    And I tap mobile file "readme.txt"
    Then the mobile file view should be visible
    And there should be no page errors

  @mobile
  Scenario: Tapping an HTML file shows the iframe preview
    When I run "rm -rf /tmp/kolu-mobile-html && git init /tmp/kolu-mobile-html && cd /tmp/kolu-mobile-html"
    And I run "printf '<h1>hi</h1>' > index.html"
    And I run "git add index.html && git commit -m init"
    And I tap the mobile pull handle
    And I tap the mobile files button
    And I tap mobile file "index.html"
    Then the mobile html preview should be visible
    And there should be no page errors

  @mobile
  Scenario: Tapping an absolute path in terminal output resolves to a repo-relative file
    # Regression: terminal output emits absolute paths (`pwd`, error
    # traces, build logs). The mobile path used to shove the raw
    # absolute string into the selection slot — `fsReadFile` then
    # rejected with "path escapes root" or EISDIR depending on where
    # the repo root sat. `resolveLineRefPath` in `MobileCodeSheet`
    # now strips the repo prefix before the slot is written.
    When I run "rm -rf /tmp/kolu-mobile-abs && git init /tmp/kolu-mobile-abs && cd /tmp/kolu-mobile-abs"
    And I run "echo hello > README.md"
    And I run "git add README.md && git commit -m init"
    And I run "echo /tmp/kolu-mobile-abs/README.md"
    And I tap terminal text "/tmp/kolu-mobile-abs/README.md"
    Then the mobile code sheet should be visible
    And the mobile file view should be visible
    And there should be no page errors

  @mobile
  Scenario: Tapping a path outside the repo surfaces a "not found" toast
    # Regression: the bug the user reported on iPhone — tapping a
    # path that doesn't resolve under the active repo used to push
    # the absolute string at `fsReadFile` and render a server error.
    # Now it toasts and leaves the slot empty so the tree stays
    # visible.
    When I run "rm -rf /tmp/kolu-mobile-offrepo && git init /tmp/kolu-mobile-offrepo && cd /tmp/kolu-mobile-offrepo"
    And I run "echo hello > a.txt"
    And I run "git add a.txt && git commit -m init"
    And I run "echo /etc/passwd"
    And I tap terminal text "/etc/passwd"
    Then the mobile code sheet should be visible
    And the mobile file view should not be visible
    And a toast should mention "File reference not found"
    And there should be no page errors

  @mobile
  Scenario: Close button dismisses the drawer
    When I run "rm -rf /tmp/kolu-mobile-close && git init /tmp/kolu-mobile-close && cd /tmp/kolu-mobile-close"
    And I run "echo hi > x.txt"
    And I run "git add x.txt && git commit -m init"
    And I tap the mobile pull handle
    And I tap the mobile files button
    Then the mobile code sheet should be visible
    When I tap the mobile code close button
    Then the mobile code sheet should not be visible
    And there should be no page errors
