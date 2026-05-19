Feature: Terminal icons
  Users can pin a personal emoji to each terminal so they're easy
  to differentiate at first glance — in the canvas tile, the dock,
  the workspace switcher, and sub-panel tabs.

  The picker uses the command palette (Kolu's canonical picker), not
  a separate popover — the chip in the title bar opens the palette
  pre-drilled into "Set icon".

  Background:
    Given the terminal is ready

  Scenario: Default state — no icon shown, picker placeholder visible
    Then the terminal icon chip should show the placeholder

  Scenario: Click chip opens the Set icon palette group
    When I click the terminal icon chip
    Then the command palette should be visible
    And the palette breadcrumb should show "Set icon"
    And the palette search input should be focused
    And there should be no page errors

  Scenario: Pick an icon from the quick row by label
    When I click the terminal icon chip
    And I select "🏠  home" in the palette
    Then the active tile should show the icon "🏠"

  Scenario: Pick an icon by fuzzy-matching the label
    When I click the terminal icon chip
    And I type "rocket" in the palette
    And I press Enter
    Then the active tile should show the icon "🚀"

  Scenario: Picked icon persists after page refresh
    When I click the terminal icon chip
    And I select "🚀  rocket" in the palette
    And I refresh the page
    Then the active tile should show the icon "🚀"

  Scenario: Custom emoji via free-form value input
    When I click the terminal icon chip
    And I select "Custom emoji…" in the palette
    And I type "🎩" in the palette
    And I press Enter
    Then the active tile should show the icon "🎩"

  Scenario: Clear icon removes it
    When I click the terminal icon chip
    And I select "⚡  fast" in the palette
    Then the active tile should show the icon "⚡"
    When I click the terminal icon chip
    And I select "Clear icon" in the palette
    Then the terminal icon chip should show the placeholder
