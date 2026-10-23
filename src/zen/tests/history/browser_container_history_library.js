/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.containers.separate-history", true],
      ["zen.workspaces.separate-history", false],
      ["zen.library.history.closed-tabs", false],
    ],
  });
  await cleanUpHistory();
  registerCleanupFunction(cleanUpHistory);
});

add_task(async function test_library_follows_the_selected_tabs_container() {
  const containerURL = pageURL("library-container");
  const containerTab = await openTabIn(containerURL, 1);
  await waitForContainerVisit(1, containerURL);
  const plainURL = pageURL("library-plain");
  const visited = PlacesTestUtils.waitForNotification("page-visited", events =>
    events.some(event => event.url === plainURL)
  );
  const plainTab = await openTabIn(plainURL, 0);
  await visited;

  gBrowser.selectedTab = containerTab;
  let section = await openLibraryHistory();
  await TestUtils.waitForCondition(
    () => libraryURLs(section).includes(containerURL),
    "in a container tab, the library lists the container's visit"
  );
  ok(
    !libraryURLs(section).includes(plainURL),
    "and not the visits made outside it"
  );
  await closeLibrary();

  gBrowser.selectedTab = plainTab;
  section = await openLibraryHistory();
  await TestUtils.waitForCondition(
    () => libraryURLs(section).includes(plainURL),
    "outside containers, the library lists the global history"
  );
  ok(
    !libraryURLs(section).includes(containerURL),
    "without the container's visit"
  );
  await closeLibrary();

  BrowserTestUtils.removeTab(containerTab);
  BrowserTestUtils.removeTab(plainTab);
  await cleanUpHistory();
});

add_task(async function test_library_forgets_from_the_container() {
  const url = pageURL("library-forget");
  const tab = await openTabIn(url, 1);
  await waitForContainerVisit(1, url);

  const section = await openLibraryHistory();
  let row;
  await TestUtils.waitForCondition(() => {
    row = [...section.querySelectorAll(".zen-library-row")].find(
      r => r.querySelector(".zen-library-row-title")?.textContent === PAGE_TITLE
    );
    return row;
  }, "the container's visit has a row");
  row.querySelector('[data-l10n-id="library-history-forget-button"]').click();
  await TestUtils.waitForCondition(
    async () =>
      !(await ZenContainerHistory.getVisits({ userContextId: 1 })).some(
        v => v.url === url
      ),
    "forgetting the row removes the page from the container's history"
  );
  ok(!libraryURLs(section).includes(url), "and from the list");
  await closeLibrary();

  BrowserTestUtils.removeTab(tab);
  await cleanUpHistory();
});

add_task(async function test_library_opens_visits_in_their_container() {
  const url = pageURL("library-open");
  const tab = await openTabIn(url, 1);
  await waitForContainerVisit(1, url);

  const section = await openLibraryHistory();
  let row;
  await TestUtils.waitForCondition(() => {
    row = section.querySelector(".zen-library-row");
    return row;
  }, "the container's visit has a row");
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  row.click();
  const newTab = await opened;
  const Library = customElements.get("zen-library");
  await TestUtils.waitForCondition(
    () => !Library.isLibraryOpen && Library.libraryProgress === 0,
    "opening a visit closes the library"
  );
  is(
    newTab.userContextId,
    1,
    "a container's visit opens back in that container"
  );

  BrowserTestUtils.removeTab(newTab);
  BrowserTestUtils.removeTab(tab);
  await cleanUpHistory();
});
