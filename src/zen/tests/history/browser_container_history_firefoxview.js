/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.containers.separate-history", true]],
  });
  await cleanUpHistory();
  registerCleanupFunction(cleanUpHistory);
});

/**
 * Opens about:history in a tab and waits for Firefox View's history.
 *
 * @param {number} userContextId
 * @returns {Promise<{tab: MozTabbrowserTab, history: Element}>}
 */
async function openAboutHistory(userContextId) {
  const tab = BrowserTestUtils.addTab(gBrowser, "about:history", {
    skipAnimation: true,
    userContextId,
  });
  gBrowser.selectedTab = tab;
  await TestUtils.waitForCondition(
    () => tab.linkedBrowser.currentURI.spec === "about:firefoxview#history",
    "about:history takes the tab to Firefox View's history"
  );
  let history;
  await TestUtils.waitForCondition(() => {
    history = tab.linkedBrowser.contentDocument?.querySelector("view-history");
    return history?.controller && !history.controller.isHistoryPending;
  }, "Firefox View's history is loaded");
  return { tab, history };
}

function listedURLs(history) {
  return history.controller.historyVisits.flatMap(entry =>
    entry.items.map(item => item.url)
  );
}

add_task(async function test_about_history_in_a_container() {
  const containerURL = pageURL("fxview-container");
  const pageTab = await openTabIn(containerURL, 1);
  await waitForContainerVisit(1, containerURL);
  const plainURL = pageURL("fxview-plain");
  const visited = PlacesTestUtils.waitForNotification("page-visited", events =>
    events.some(event => event.url === plainURL)
  );
  const plainTab = await openTabIn(plainURL, 0);
  await visited;

  const { tab, history } = await openAboutHistory(1);
  is(
    tab.linkedBrowser.getAttribute("usercontextid"),
    "1",
    "the history page stayed in the container"
  );
  is(
    history.controller.placesQuery.userContextId,
    1,
    "Firefox View reads the container's history"
  );
  await TestUtils.waitForCondition(
    () => listedURLs(history).includes(containerURL),
    "the container's visit is listed"
  );
  ok(
    !listedURLs(history).includes(plainURL),
    "a visit outside the container is not listed"
  );

  // Deleting from Firefox View forgets the page from the container only.
  history.triggerNode = { url: containerURL };
  await history.controller.deleteFromHistory();
  await TestUtils.waitForCondition(
    () => !listedURLs(history).includes(containerURL),
    "the forgotten page leaves the list"
  );
  ok(
    !(await ZenContainerHistory.getVisits({ userContextId: 1 })).some(
      v => v.url === containerURL
    ),
    "and the container's history"
  );

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(pageTab);
  BrowserTestUtils.removeTab(plainTab);
  await cleanUpHistory();
});

add_task(async function test_about_history_outside_containers() {
  const containerURL = pageURL("fxview-hidden");
  const pageTab = await openTabIn(containerURL, 1);
  await waitForContainerVisit(1, containerURL);
  const plainURL = pageURL("fxview-global");
  const visited = PlacesTestUtils.waitForNotification("page-visited", events =>
    events.some(event => event.url === plainURL)
  );
  const plainTab = await openTabIn(plainURL, 0);
  await visited;

  const { tab, history } = await openAboutHistory(0);
  ok(
    history.controller.placesQuery.userContextId === undefined,
    "Firefox View reads the global history"
  );
  await TestUtils.waitForCondition(
    () => listedURLs(history).includes(plainURL),
    "the global visit is listed"
  );
  ok(
    !listedURLs(history).includes(containerURL),
    "the container's visit is not listed"
  );

  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(pageTab);
  BrowserTestUtils.removeTab(plainTab);
  await cleanUpHistory();
});
