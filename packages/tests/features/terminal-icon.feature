Feature: Terminal icons
  Users can pin a personal emoji to each terminal so they're easy
  to differentiate at first glance — in the canvas tile, the dock,
  the workspace switcher, and sub-panel tabs.

  Background:
    Given the terminal is ready

  Scenario: Default state — no icon shown, picker placeholder visible
    Then the terminal icon chip should show the placeholder

  Scenario: Pick an icon from the curated quick row
    When I open the terminal icon picker
    And I pick the icon "🏠" from the quick row
    Then the active tile should show the icon "🏠"

  Scenario: Picked icon persists after page refresh
    When I open the terminal icon picker
    And I pick the icon "🚀" from the quick row
    And I refresh the page
    Then the active tile should show the icon "🚀"

  Scenario: Clear icon removes it
    When I open the terminal icon picker
    And I pick the icon "⚡" from the quick row
    Then the active tile should show the icon "⚡"
    When I open the terminal icon picker
    And I clear the terminal icon
    Then the terminal icon chip should show the placeholder

  Scenario: Custom icon via free-form input
    When I open the terminal icon picker
    And I type "🎩" into the custom icon input
    And I press Enter
    Then the active tile should show the icon "🎩"
